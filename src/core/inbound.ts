import { classifyAddress, messageText, senderUser, topicThreadId } from "./address.js";
import { isAllowlisted } from "./allowlist.js";
import { secretsEqual } from "./crypto.js";
import { safeErrorMessage } from "./log.js";
import { runInBackground, type AppDeps } from "./deps.js";
import { forwardToGrok } from "./grok.js";
import { json, readLimitedBody } from "./http.js";
import { planWakeMedia } from "./media.js";
import { buildWakeEvent, toContextMessage } from "./payload.js";
import { MESSAGE_CLAIM_TTL_MS, rateChatKey, rateUserKey, scopeKey } from "./store.js";
import { fastGreetingReply } from "./text.js";
import { TELEGRAM_SECRET_HEADER, type TelegramMessage, type TelegramUpdate, type TypingStart } from "./types.js";

export async function handleWebhook(request: Request, deps: AppDeps): Promise<Response> {
  // Empty, too short, or outside Telegram's secret_token charset all fail closed.
  if (!deps.config.telegramWebhookSecret) {
    deps.log({ event: "webhook_rejected", reason: "not_configured" });
    return json(503, { ok: false, error: "webhook_secret_not_configured" });
  }
  const provided = request.headers.get(TELEGRAM_SECRET_HEADER) ?? "";
  const secretOk = await secretsEqual(deps.config.telegramWebhookSecret, provided);
  if (!secretOk) {
    deps.log({ event: "webhook_rejected", reason: "bad_secret" });
    return json(401, { ok: false, error: "unauthorized" });
  }

  const body = await readLimitedBody(request, deps.config.maxBodyBytes);
  if (!body.ok) {
    deps.log({ event: "webhook_rejected", reason: "body_too_large" });
    return body.response;
  }
  let update: TelegramUpdate;
  try {
    update = JSON.parse(body.text) as TelegramUpdate;
  } catch {
    deps.log({ event: "webhook_rejected", reason: "bad_json" });
    return json(400, { ok: false, error: "bad_json" });
  }
  if (!update || typeof update.update_id !== "number") {
    deps.log({ event: "webhook_rejected", reason: "bad_json" });
    return json(400, { ok: false, error: "bad_json" });
  }

  const now = deps.now();
  let claim: "new" | "duplicate";
  try {
    claim = await deps.store.claimUpdate(update.update_id, now, deps.config.dedupeTtlMs);
  } catch (err) {
    deps.log({
      event: "store_error",
      error: safeErrorMessage(err, []),
    });
    return json(500, { ok: false, error: "store_unavailable" });
  }
  if (claim === "duplicate") {
    deps.log({ event: "update_dropped", reason: "duplicate", update_id: update.update_id });
    return json(200, { ok: true });
  }

  try {
    return await handleClaimedUpdate(deps, update, now);
  } catch (err) {
    await deps.store.releaseUpdate(update.update_id).catch(() => undefined);
    deps.log({
      event: "webhook_failed",
      update_id: update.update_id,
      error: err instanceof Error ? err.name : "error",
    });
    return json(500, { ok: false, error: "internal_error" });
  }
}

async function handleClaimedUpdate(
  deps: AppDeps,
  update: TelegramUpdate,
  now: number,
): Promise<Response> {
  if (update.channel_post || update.edited_channel_post) {
    deps.log({ event: "update_dropped", reason: "ignored_channel", update_id: update.update_id });
    return json(200, { ok: true });
  }

  const edited = Boolean(update.edited_message);
  const message = update.message ?? update.edited_message;
  if (!message?.chat || typeof message.chat.id !== "number") {
    deps.log({ event: "update_dropped", reason: "ignored_update", update_id: update.update_id });
    return json(200, { ok: true });
  }

  const chatId = String(message.chat.id);
  const sender = senderUser(message);
  const userId = sender ? String(sender.id) : null;

  if (message.migrate_to_chat_id) {
    deps.log({
      event: "update_dropped",
      reason: "chat_migrated",
      update_id: update.update_id,
      chat_id: chatId,
      migrate_to_chat_id: String(message.migrate_to_chat_id),
    });
    return json(200, { ok: true });
  }

  if (message.is_automatic_forward) {
    // A linked channel's post copied into its discussion group. Channel posts are not wakes.
    deps.log({ event: "update_dropped", reason: "ignored_automatic_forward", update_id: update.update_id, chat_id: chatId });
    return json(200, { ok: true });
  }

  if (sender?.is_bot) {
    deps.log({ event: "update_dropped", reason: "ignored_bot", update_id: update.update_id, chat_id: chatId });
    return json(200, { ok: true });
  }

  if (!isAllowlisted(userId, chatId, deps.config)) {
    deps.log({
      event: "update_dropped",
      reason: "not_allowlisted",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const threadId = topicThreadId(message);
  const scope = scopeKey(chatId, threadId);
  const contextMessage = toContextMessage(message);
  let shortTerm: Awaited<ReturnType<AppDeps["store"]["pushContext"]>> = [];
  if (contextMessage) {
    shortTerm = await deps.store.pushContext(scope, contextMessage, deps.config.contextLimit);
  }

  const address = classifyAddress(message, deps.config);
  if (!address.addressed || !address.how) {
    deps.log({
      event: "update_dropped",
      reason: "not_addressed",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const chatRate = await deps.store.hitRate(rateChatKey(chatId), now, deps.config.rateLimitWindowMs, deps.config.rateLimitMax);
  const userRate = userId
    ? await deps.store.hitRate(rateUserKey(chatId, userId), now, deps.config.rateLimitWindowMs, deps.config.rateLimitMax)
    : { allowed: true, count: 0 };
  if (!chatRate.allowed || !userRate.allowed) {
    deps.log({
      event: "update_dropped",
      reason: "rate_limited",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const greeting = deps.config.fastGreeting
    ? fastGreetingReply(messageText(message), deps.config.telegramBotUsername)
    : null;
  if (greeting) {
    if (!await claimMessage(deps, update.update_id, chatId, message.message_id, edited, now)) return json(200, { ok: true });
    deps.log({ event: "fast_greeting", update_id: update.update_id, chat_id: chatId });
    runInBackground(deps, "fast_greeting_failed", async () => {
      await deps.telegram.sendMessage({
        chat_id: chatId,
        text: greeting,
        reply_to_message_id: message.message_id,
        ...(threadId !== null ? { message_thread_id: threadId } : {}),
      });
    });
    return json(200, { ok: true });
  }

  const wake = await buildWakeEvent({
    config: deps.config,
    message,
    edited,
    updateId: update.update_id,
    addressedHow: address.how,
    command: address.command,
    shortTerm,
    nowMs: now,
  });
  if (!wake) {
    deps.log({
      event: "wake_skipped",
      level: "error",
      reason: "reply_not_configured",
      missing_or_invalid: ["REPLY_TOKEN_SECRET", "PUBLIC_BASE_URL"].filter((name) =>
        name === "REPLY_TOKEN_SECRET" ? !deps.config.replyTokenSecret : !deps.config.publicBaseUrl),
      update_id: update.update_id,
      chat_id: chatId,
    });
    return json(200, { ok: true });
  }

  if (!await claimMessage(deps, update.update_id, chatId, message.message_id, edited, now)) return json(200, { ok: true });

  const planned = planWakeMedia({
    message,
    config: deps.config,
    chatId,
    threadId,
    userId,
    wakeId: wake.reply.wake_id,
    expiresAtMs: Date.parse(wake.reply.expires_at),
  });
  if (planned.items.length > 0) {
    let items = planned.items;
    if (planned.grants.length > 0) {
      try {
        for (const grant of planned.grants) await deps.store.putMedia(grant, now);
      } catch (err) {
        deps.log({
          event: "media_grant_failed",
          chat_id: chatId,
          error: err instanceof Error ? err.name : "error",
        });
        items = planned.items.map((item) => item.available
          ? { ...item, available: false, download_url: null, unavailable_reason: "unavailable" }
          : item);
        await deps.store.deleteWakeMedia(chatId, wake.reply.wake_id).catch(() => undefined);
      }
    }
    wake.message.media_items = items;
  }

  // Typing is pointless once the reply token has expired, so the ceiling never outlives it.
  const tokenExpiry = Date.parse(wake.reply.expires_at);
  const session: TypingStart = {
    scopeKey: scope,
    chatId,
    threadId,
    refreshMs: deps.config.typingRefreshMs,
    wakeId: wake.reply.wake_id,
    messageId: message.message_id,
    reaction: deps.config.progressReaction,
    // Phase 3, off by default. sendMessageDraft only works in private chats.
    draft: deps.config.draftPlaceholder && message.chat.type === "private",
    startedAt: now,
    leaseMs: deps.config.typingLeaseMs,
    deadline: Number.isFinite(tokenExpiry)
      ? Math.min(now + deps.config.typingMaxMs, tokenExpiry)
      : now + deps.config.typingMaxMs,
  };

  deps.log({
    event: "wake",
    update_id: update.update_id,
    chat_id: chatId,
    user_id: userId,
    addressed_how: address.how,
    edited,
    media_available: (wake.message.media_items ?? []).filter((item) => item.available).length,
  });

  runInBackground(deps, "wake_background_failed", () => deliverWake(deps, message, session, wake, chatId, threadId));
  return json(200, { ok: true });
}

/**
 * One Telegram message starts at most one wake. update_id dedupe covers
 * redelivery of the same update; this covers the same message arriving again
 * under another update_id, and edits: an edit of a message that already woke
 * the bot is ignored, and an edit of one that never did may wake it once.
 */
async function claimMessage(
  deps: AppDeps,
  updateId: number,
  chatId: string,
  messageId: number,
  edited: boolean,
  now: number,
): Promise<boolean> {
  const claim = await deps.store.claimMessage(chatId, messageId, now, MESSAGE_CLAIM_TTL_MS);
  if (claim === "new") return true;
  deps.log(edited
    ? { event: "edit_ignored", update_id: updateId, chat_id: chatId, message_id: messageId }
    : { event: "update_dropped", reason: "duplicate_message", update_id: updateId, chat_id: chatId, message_id: messageId });
  return false;
}

async function deliverWake(
  deps: AppDeps,
  message: TelegramMessage,
  session: TypingStart,
  wake: NonNullable<Awaited<ReturnType<typeof buildWakeEvent>>>,
  chatId: string,
  threadId: number | null,
): Promise<void> {
  // Reaction, typing and the optional ack are cosmetic. A failure there must not stop the wake.
  try {
    await deps.typing.start(session);
  } catch (err) {
    deps.log({ event: "typing_failed", chat_id: chatId, error: safeErrorMessage(err, []) });
  }
  if (deps.config.bridgeAck) {
    deps.log({ event: "bridge_ack", chat_id: chatId, update_id: wake.update_id });
    await deps.telegram.sendMessage({
      chat_id: chatId,
      text: "On it.",
      reply_to_message_id: message.message_id,
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
    });
    // Telegram clears typing when the bot posts.
    await deps.typing.touch(session.scopeKey, null).catch(() => undefined);
  }
  const forwarded = await forwardToGrok(deps.config, wake, deps.fetchImpl);
  deps.log({
    event: "forward",
    update_id: wake.update_id,
    chat_id: chatId,
    status: forwarded.status,
    reason: forwarded.reason,
    ok: forwarded.ok,
  });
  if (forwarded.ok) return;
  if (forwarded.ambiguous) {
    // The routine may be working on it. Keep typing and the 👀 (the lease ends them), say nothing,
    // and never retry: a second POST could wake it twice.
    deps.log({
      event: "forward_ambiguous",
      update_id: wake.update_id,
      chat_id: chatId,
      status: forwarded.status,
      wake_id: wake.reply.wake_id,
    });
    return;
  }
  // The routine did not accept the wake, so drop the file id instead of keeping it until the token expires.
  await deps.store.deleteWakeMedia(chatId, wake.reply.wake_id).catch((err: unknown) => {
    deps.log({ event: "media_revoke_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
  });
  // Definitely not accepted, so nobody is going to reply. Do not leave typing or the reaction up.
  await deps.typing.stop(session.scopeKey, session.wakeId).catch(() => undefined);
  // deliverWake runs once per wake (update_id is deduped first), so this line is sent at most once.
  const text = deps.config.forwardFailureText;
  if (!text) return;
  const sent = await deps.telegram.sendMessage({
    chat_id: chatId,
    text,
    reply_to_message_id: message.message_id,
    disable_notification: true,
    ...(threadId !== null ? { message_thread_id: threadId } : {}),
  });
  deps.log({ event: "forward_failure_notice", chat_id: chatId, update_id: wake.update_id, ok: sent.ok });
  // Another wake in this chat may still be working; the notice just cleared its typing.
  if (sent.ok) await deps.typing.touch(session.scopeKey, null).catch(() => undefined);
}
