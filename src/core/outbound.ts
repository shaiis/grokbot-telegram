import { isOutboundChatAllowed } from "./allowlist.js";
import { canonicalId } from "./config.js";
import { replyTokenScopeOk, secretsEqual, verifyReplyToken } from "./crypto.js";
import type { AppDeps } from "./deps.js";
import { json, readLimitedBody } from "./http.js";
import { scopeKey, type SendRecord } from "./store.js";
import { splitTelegramText } from "./text.js";
import { TELEGRAM_TEXT_LIMIT, type ReplyClaims } from "./types.js";

const MAX_TEXT_CHARS = TELEGRAM_TEXT_LIMIT * 8;

interface SendBody {
  chat_id?: unknown;
  text?: unknown;
  message_thread_id?: unknown;
  reply_to_message_id?: unknown;
  final?: unknown;
  wake_id?: unknown;
  disable_notification?: unknown;
  idempotency_key?: unknown;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export async function handleSend(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as SendBody;
  const chatId = normalizeId(body.chat_id);
  const text = typeof body.text === "string" ? body.text : "";
  const threadId = normalizeOptionalInt(body.message_thread_id);
  const replyTo = normalizeOptionalInt(body.reply_to_message_id);
  const final = body.final === true;
  if (body.disable_notification !== undefined && typeof body.disable_notification !== "boolean") {
    return json(400, { ok: false, error: "bad_disable_notification" });
  }
  if (body.idempotency_key !== undefined && (typeof body.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(body.idempotency_key))) {
    return json(400, { ok: false, error: "bad_idempotency_key" });
  }
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
  const requestedWakeId = typeof body.wake_id === "string" && body.wake_id.length <= 80 ? body.wake_id : null;
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (!text.trim()) return json(400, { ok: false, error: "empty_text" });
  if (text.length > MAX_TEXT_CHARS) return json(413, { ok: false, error: "text_too_large" });
  if (threadId === "invalid" || replyTo === "invalid") return json(400, { ok: false, error: "bad_message_id" });

  const auth = await authorize(credential, deps, chatId, threadId, { allowClosed: true });
  if (!auth.ok) return auth.response;

  // One final per wake, and at most one delivery per idempotency_key. Held for the token's life.
  const sendKey = auth.wakeId
    ? final ? `${auth.wakeId}:final` : idempotencyKey ? `${auth.wakeId}:key:${idempotencyKey}` : null
    : idempotencyKey ? `outbound:${chatId}:${idempotencyKey}` : null;
  const sendTtlMs = auth.wakeId ? Math.max(1000, auth.expiresAtMs - deps.now()) : deps.config.dedupeTtlMs;
  const existing = sendKey ? await deps.store.claimSend(sendKey, deps.now(), sendTtlMs) : null;
  if (existing) return repeatedSend(deps, chatId, auth.wakeId, existing);
  if (auth.closed) {
    if (sendKey) await deps.store.releaseSend(sendKey);
    return json(401, { ok: false, error: "wake_closed" });
  }

  // A progress line inside a wake goes out silently; the final answer notifies.
  // Operator sends (OUTBOUND_API_KEY, no wake) notify unless told otherwise.
  const silent = typeof body.disable_notification === "boolean"
    ? body.disable_notification
    : auth.wakeId !== null && !final;
  const scope = scopeKey(chatId, typeof threadId === "number" ? threadId : null);
  const parts = splitTelegramText(text);
  const messageIds: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const input: {
      chat_id: string;
      text: string;
      message_thread_id?: number;
      reply_to_message_id?: number;
      disable_notification?: boolean;
    } = { chat_id: chatId, text: part, disable_notification: silent };
    if (typeof threadId === "number") input.message_thread_id = threadId;
    if (index === 0 && typeof replyTo === "number") input.reply_to_message_id = replyTo;
    const sent = await deps.telegram.sendMessage(input);
    if (!sent.ok) {
      const ambiguous = sent.ambiguous === true;
      deps.log({
        event: ambiguous ? "send_ambiguous" : "send_failed",
        chat_id: chatId,
        status: sent.status,
        sent_parts: messageIds.length,
        wake_id: auth.wakeId,
      });
      // Never retried here. An ambiguous part may be in the chat, so a repeat of this key is refused;
      // a definite failure frees the key so the caller can send what is missing.
      if (sendKey) {
        // If this write fails the claim stays pending, which also refuses a repeat.
        await (ambiguous
          ? deps.store.finishSend(sendKey, { state: "ambiguous", message_ids: messageIds }, deps.now(), sendTtlMs)
          : deps.store.releaseSend(sendKey)
        ).catch((err: unknown) => {
          deps.log({ event: "send_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
        });
      }
      // Typing stays on: the answer did not get through. Anything that did clear typing on the clients.
      if (messageIds.length > 0) await afterMessage(deps, scope, auth.wakeId);
      return json(502, {
        ok: false,
        error: ambiguous ? "telegram_send_ambiguous" : "telegram_send_failed",
        ambiguous,
        description: sent.description,
        sent_parts: messageIds.length,
        message_ids: messageIds,
        ...(sent.retryAfter !== undefined ? { retry_after: sent.retryAfter } : {}),
      });
    }
    messageIds.push(sent.messageId);
  }

  // Recorded before anything else, so a repeat is answered with already_sent even if finishing up fails.
  if (sendKey) {
    try {
      await deps.store.finishSend(sendKey, { state: "sent", message_ids: messageIds }, deps.now(), sendTtlMs);
    } catch (err) {
      // The claim stays pending, so a repeat is refused rather than resent.
      deps.log({ event: "send_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
    }
  }

  const wakeId = auth.wakeId ?? (final ? requestedWakeId : null);
  if (final && wakeId) {
    // Only now, after Telegram confirmed every part: end this wake's typing and reaction.
    try {
      const stopped = await deps.typing.stop(scope, wakeId);
      // This wake had already ended (lease ran out); other wakes here still need typing back.
      if (!stopped.stopped) await deps.typing.touch(scope, null);
      if (auth.wakeId) {
        const remainingMs = Math.max(1000, auth.expiresAtMs - deps.now());
        await deps.store.closeWake(auth.wakeId, deps.now(), remainingMs);
        await deps.store.deleteWakeMedia(chatId, auth.wakeId);
      }
    } catch (err) {
      deps.log({
        event: "send_finalize_failed",
        chat_id: chatId,
        error: err instanceof Error ? err.name : "error",
      });
    }
  } else {
    await afterMessage(deps, scope, auth.wakeId);
  }

  deps.log({ event: "send", chat_id: chatId, parts: parts.length, final, silent, wake_id: auth.wakeId });
  return json(200, { ok: true, message_ids: messageIds });
}

/** A repeat of a send we already own. Never sends again. */
function repeatedSend(deps: AppDeps, chatId: string, wakeId: string | null, record: SendRecord): Response {
  deps.log({ event: "send_repeated", chat_id: chatId, wake_id: wakeId, state: record.state });
  if (record.state === "sent") {
    return json(200, { ok: true, already_sent: true, message_ids: record.message_ids });
  }
  // In flight, cut off mid-send, or ambiguous: it may be in the chat. Do not send it again.
  return json(409, {
    ok: false,
    ambiguous: true,
    error: record.state === "pending" ? "send_in_progress" : "previous_send_ambiguous",
    message_ids: record.message_ids,
  });
}

/** A bot message cleared typing on the clients. Re-pulse now, and renew the lease of the wake that sent it. */
async function afterMessage(deps: AppDeps, scope: string, wakeId: string | null): Promise<void> {
  try {
    await deps.typing.touch(scope, wakeId);
  } catch (err) {
    deps.log({ event: "typing_touch_failed", error: err instanceof Error ? err.name : "error" });
  }
}

/** Renew this wake's lease without sending anything. */
export async function handleTypingHeartbeat(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as SendBody;
  const chatId = normalizeId(body.chat_id);
  const threadId = normalizeOptionalInt(body.message_thread_id);
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (threadId === "invalid") return json(400, { ok: false, error: "bad_message_id" });

  const auth = await authorize(credential, deps, chatId, threadId);
  if (!auth.ok) return auth.response;
  if (!auth.wakeId) return json(400, { ok: false, error: "wake_id_required" });
  const result = await deps.typing.touch(scopeKey(chatId, threadId), auth.wakeId);
  deps.log({ event: "typing_heartbeat", chat_id: chatId, wake_id: auth.wakeId, active: result.extended });
  return json(200, { ok: true, active: result.extended });
}

export async function handleTypingStop(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as SendBody;
  const chatId = normalizeId(body.chat_id);
  const threadId = normalizeOptionalInt(body.message_thread_id);
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (threadId === "invalid") return json(400, { ok: false, error: "bad_message_id" });

  const auth = await authorize(credential, deps, chatId, threadId);
  if (!auth.ok) return auth.response;
  if (!auth.wakeId) {
    return json(400, { ok: false, error: "wake_id_required" });
  }
  const stopped = await deps.typing.stop(scopeKey(chatId, threadId), auth.wakeId);
  deps.log({
    event: "typing_stop",
    chat_id: chatId,
    wake_id: auth.wakeId,
    stopped: stopped.stopped,
    reason: stopped.reason,
  });
  return json(200, { ok: true, stopped: stopped.stopped, reason: stopped.reason });
}

type Credential =
  | { ok: true; kind: "token"; claims: ReplyClaims }
  | { ok: true; kind: "key" };

/** Check the bearer before reading the body, so unauthenticated callers cannot make us buffer it. */
async function authenticate(
  request: Request,
  deps: AppDeps,
): Promise<Credential | { ok: false; response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const bearer = match?.[1] ?? "";
  if (!bearer) return { ok: false, response: json(401, { ok: false, error: "unauthorized" }) };

  if (deps.config.replyTokenSecret && bearer.startsWith("v1.")) {
    const verified = await verifyReplyToken(deps.config.replyTokenSecret, bearer, deps.now());
    if (!verified.ok) {
      return { ok: false, response: json(401, { ok: false, error: verified.reason }) };
    }
    return { ok: true, kind: "token", claims: verified.claims };
  }

  if (deps.config.outboundApiKey && await secretsEqual(deps.config.outboundApiKey, bearer)) {
    return { ok: true, kind: "key" };
  }

  return { ok: false, response: json(401, { ok: false, error: "unauthorized" }) };
}

async function authorize(
  credential: Credential,
  deps: AppDeps,
  chatId: string,
  threadId: number | null,
  options: { allowClosed?: boolean } = {},
): Promise<
  | { ok: true; wakeId: string | null; expiresAtMs: number; closed: boolean }
  | { ok: false; response: Response }
> {
  if (credential.kind === "token") {
    const claims = credential.claims;
    if (!replyTokenScopeOk(claims, chatId, threadId)) {
      return { ok: false, response: json(403, { ok: false, error: "scope" }) };
    }
    // /send still answers a repeat of a delivered send on a closed wake; it refuses anything new itself.
    const closed = await deps.store.isWakeClosed(claims.wake_id, deps.now());
    if (closed && !options.allowClosed) {
      return { ok: false, response: json(401, { ok: false, error: "wake_closed" }) };
    }
    return { ok: true, wakeId: claims.wake_id, expiresAtMs: claims.exp * 1000, closed };
  }

  if (!isOutboundChatAllowed(chatId, deps.config)) {
    return { ok: false, response: json(403, { ok: false, error: "not_allowlisted" }) };
  }
  return { ok: true, wakeId: null, expiresAtMs: deps.now() + 60_000, closed: false };
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const body = await readLimitedBody(request, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, response: json(400, { ok: false, error: "bad_json" }) };
  }
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return canonicalId(String(value));
  if (typeof value === "string") return canonicalId(value);
  return null;
}

function normalizeOptionalInt(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return "invalid";
}
