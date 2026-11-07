import {
  normalizeScope,
  startWake,
  stopWake,
  telegramEffects,
  tickScope,
  touchWake,
  type ProgressEffects,
  type ScopeStore,
} from "../../core/typing.js";
import { createTelegramClient } from "../../core/telegram.js";
import { collectSecrets, createLogger } from "../../core/log.js";
import { copyMediaGrant, freshContext, normalizeSendRecord, type MediaGrant, type SendRecord } from "../../core/store.js";
import type { ContextMessage, TypingScope, TypingStart } from "../../core/types.js";

export interface DoStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface Bucket {
  windowStart: number;
  count: number;
}

interface DoOp {
  op?: string;
  updateId?: number;
  messageId?: number;
  now?: number;
  ttlMs?: number;
  bucketKey?: string;
  windowMs?: number;
  max?: number;
  scopeKey?: string;
  message?: ContextMessage;
  limit?: number;
  scope?: TypingScope | null;
  start?: TypingStart;
  wakeId?: string | null;
  sendKey?: string;
  record?: SendRecord;
  mediaId?: string;
  grant?: unknown;
}

export async function handleDoFetch(
  storage: DoStorage,
  env: Record<string, unknown>,
  request: Request,
): Promise<Response> {
  let body: DoOp;
  try {
    body = (await request.json()) as DoOp;
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  switch (body.op) {
    case "claim":
      return Response.json(await claim(storage, body));
    case "release":
      return Response.json(await release(storage, body));
    case "msg.claim":
      return Response.json(await claimMessage(storage, body));
    case "rate":
      return Response.json(await rate(storage, body));
    case "context":
      return Response.json(await context(storage, body));
    case "typing.get":
      return Response.json(await typingGet(storage, body));
    case "typing.set":
      return Response.json(await typingSet(storage, body));
    case "typing.start":
      return Response.json(await typingStart(storage, env, body));
    case "typing.stop":
      return Response.json(await typingStop(storage, env, body));
    case "typing.touch":
      return Response.json(await typingTouch(storage, env, body));
    case "wake.close":
      return Response.json(await wakeClose(storage, body));
    case "wake.closed":
      return Response.json(await wakeClosed(storage, body));
    case "send.claim":
      return Response.json(await sendClaim(storage, body));
    case "send.finish":
      return Response.json(await sendFinish(storage, body));
    case "send.release":
      if (body.sendKey) await storage.delete(`send:${body.sendKey}`);
      return Response.json({ ok: true });
    case "media.put":
      return Response.json(await mediaPut(storage, body));
    case "media.get":
      return Response.json(await mediaGet(storage, body));
    case "media.delete":
      if (body.mediaId) await storage.delete(`mediagrant:${body.mediaId}`);
      return Response.json({ ok: true });
    case "media.deleteWake":
      return Response.json(await mediaDeleteWake(storage, body));
    default:
      return Response.json({ ok: false, error: "unknown_op" }, { status: 400 });
  }
}

/**
 * Typing state (wakes, leases, reaction targets) lives in this object's storage
 * and the alarm is durable, so both survive eviction and restarts. Each alarm
 * sends one typing action per chat (and topic), however many wakes it has.
 */
export async function handleDoAlarm(storage: DoStorage, env: Record<string, unknown>, now = Date.now()): Promise<void> {
  const scopes = typingScopes(storage);
  const effects = doEffects(env);
  const map = (await storage.get<Record<string, unknown>>(TYPING_KEY)) ?? {};
  for (const key of Object.keys(map)) {
    // tickScope re-reads and writes before it calls Telegram, so a stop that
    // lands while a request is in flight is never undone.
    await tickScope(scopes, effects, key, now);
  }
  await scheduleTyping(storage, now, true);
}

const TYPING_KEY = "typing";

function typingScopes(storage: DoStorage): ScopeStore {
  return {
    async get(key) {
      const map = (await storage.get<Record<string, unknown>>(TYPING_KEY)) ?? {};
      return map[key] ?? null;
    },
    async set(key, scope) {
      const map = (await storage.get<Record<string, unknown>>(TYPING_KEY)) ?? {};
      if (scope) map[key] = scope;
      else delete map[key];
      if (Object.keys(map).length === 0) await storage.delete(TYPING_KEY);
      else await storage.put(TYPING_KEY, map);
    },
  };
}

function doEffects(env: Record<string, unknown>): ProgressEffects {
  const token = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN : "";
  return telegramEffects(createTelegramClient({ token }), createLogger(collectSecrets([token])));
}

/** Keep an alarm set while any wake is active, and none after. */
async function scheduleTyping(storage: DoStorage, now: number, fired = false): Promise<void> {
  const map = (await storage.get<Record<string, unknown>>(TYPING_KEY)) ?? {};
  let refreshMs = Infinity;
  for (const value of Object.values(map)) {
    const scope = normalizeScope(value);
    if (scope) refreshMs = Math.min(refreshMs, scope.refreshMs);
  }
  if (!Number.isFinite(refreshMs)) {
    if (Object.keys(map).length > 0) await storage.delete(TYPING_KEY);
    await storage.deleteAlarm();
    return;
  }
  const next = now + refreshMs;
  const existing = fired ? null : await storage.getAlarm();
  if (existing === null || existing > next) await storage.setAlarm(next);
}

/**
 * Each claimed update and closed wake is its own key holding its expiry, so the
 * dedupe object never rewrites one ever-growing value (which would hit the
 * per-value size limit on a busy bot and turn every webhook into a 500).
 */
const PRUNE_BATCH = 64;

/** Zero-padded so string order matches numeric order and pruning reaches the oldest ids first. */
function updateKey(updateId: number): string {
  return `upd:${String(updateId).padStart(16, "0")}`;
}

/** Values are an expiry, or an object carrying one in `until`. */
async function pruneExpired(storage: DoStorage, prefix: string, now: number): Promise<void> {
  const entries = await storage.list<unknown>({ prefix, limit: PRUNE_BATCH });
  for (const [key, value] of entries) {
    const expiry = typeof value === "number" ? value : (value as { until?: unknown } | null)?.until;
    if (typeof expiry !== "number" || expiry <= now) await storage.delete(key);
  }
}

/** Earlier versions kept one map under `legacyKey`. Honor it until it ages out. */
async function legacyActive(storage: DoStorage, legacyKey: string, id: string, now: number): Promise<boolean> {
  const legacy = await storage.get<Record<string, number>>(legacyKey);
  if (!legacy) return false;
  const expiry = legacy[id];
  if (Object.values(legacy).every((value) => value <= now)) await storage.delete(legacyKey);
  return expiry !== undefined && expiry > now;
}

async function claim(storage: DoStorage, body: DoOp): Promise<{ status: "new" | "duplicate" }> {
  const updateId = body.updateId;
  const now = body.now ?? Date.now();
  const ttlMs = body.ttlMs ?? 86_400_000;
  if (typeof updateId !== "number") return { status: "duplicate" };
  const key = updateKey(updateId);
  const expiry = await storage.get<number>(key);
  if ((expiry !== undefined && expiry > now) || await legacyActive(storage, "seen", String(updateId), now)) {
    return { status: "duplicate" };
  }
  await storage.put(key, now + ttlMs);
  await pruneExpired(storage, "upd:", now);
  return { status: "new" };
}

/** Lives in the chat's object, so the message id alone is unique. */
async function claimMessage(storage: DoStorage, body: DoOp): Promise<{ status: "new" | "duplicate" }> {
  const messageId = body.messageId;
  const now = body.now ?? Date.now();
  if (typeof messageId !== "number" || typeof body.ttlMs !== "number") return { status: "duplicate" };
  const key = `msg:${String(messageId).padStart(16, "0")}`;
  const expiry = await storage.get<number>(key);
  if (expiry !== undefined && expiry > now) return { status: "duplicate" };
  await storage.put(key, now + body.ttlMs);
  await pruneExpired(storage, "msg:", now);
  return { status: "new" };
}

async function release(storage: DoStorage, body: DoOp): Promise<{ ok: true }> {
  if (typeof body.updateId !== "number") return { ok: true };
  await storage.delete(updateKey(body.updateId));
  return { ok: true };
}

async function rate(storage: DoStorage, body: DoOp): Promise<{ allowed: boolean; count: number }> {
  const bucketKey = body.bucketKey ?? "";
  const now = body.now ?? Date.now();
  const windowMs = body.windowMs ?? 60_000;
  const max = body.max ?? 20;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const buckets = (await storage.get<Record<string, Bucket>>("buckets")) ?? {};
  let bucket = buckets[bucketKey];
  if (!bucket || bucket.windowStart !== windowStart) bucket = { windowStart, count: 0 };
  bucket.count += 1;
  buckets[bucketKey] = bucket;
  for (const [key, value] of Object.entries(buckets)) {
    if (value.windowStart !== windowStart) delete buckets[key];
  }
  await storage.put("buckets", buckets);
  return { allowed: bucket.count <= max, count: bucket.count };
}

async function context(storage: DoStorage, body: DoOp): Promise<{ prior: ContextMessage[] }> {
  const key = `ctx:${body.scopeKey ?? ""}`;
  const limit = body.limit ?? 10;
  const previous = (await storage.get<ContextMessage[]>(key)) ?? [];
  const prior = body.message ? freshContext(previous, body.message, limit) : previous.slice(-limit);
  if (body.message) {
    await storage.put(key, [...prior, body.message].slice(-limit));
  }
  return { prior };
}

async function typingGet(storage: DoStorage, body: DoOp): Promise<{ scope: TypingScope | null }> {
  if (!body.scopeKey) return { scope: null };
  return { scope: normalizeScope(await typingScopes(storage).get(body.scopeKey)) };
}

async function typingSet(storage: DoStorage, body: DoOp): Promise<{ ok: true }> {
  if (!body.scopeKey) return { ok: true };
  await typingScopes(storage).set(body.scopeKey, normalizeScope(body.scope));
  await scheduleTyping(storage, body.now ?? Date.now());
  return { ok: true };
}

async function typingStart(
  storage: DoStorage,
  env: Record<string, unknown>,
  body: DoOp,
): Promise<{ ok: true }> {
  const start = body.start;
  if (!start || typeof start.scopeKey !== "string" || typeof start.wakeId !== "string") return { ok: true };
  const now = body.now ?? Date.now();
  await startWake(typingScopes(storage), doEffects(env), start, now);
  await scheduleTyping(storage, now);
  return { ok: true };
}

async function typingStop(
  storage: DoStorage,
  env: Record<string, unknown>,
  body: DoOp,
): Promise<{ stopped: boolean; reason: string }> {
  if (!body.scopeKey || !body.wakeId) return { stopped: false, reason: "none" };
  const result = await stopWake(typingScopes(storage), doEffects(env), body.scopeKey, body.wakeId);
  await scheduleTyping(storage, body.now ?? Date.now());
  return { stopped: result.stopped, reason: result.reason };
}

async function typingTouch(
  storage: DoStorage,
  env: Record<string, unknown>,
  body: DoOp,
): Promise<{ active: boolean; extended: boolean }> {
  if (!body.scopeKey) return { active: false, extended: false };
  const now = body.now ?? Date.now();
  const result = await touchWake(typingScopes(storage), doEffects(env), body.scopeKey, body.wakeId ?? null, now);
  // Also re-arms the alarm if it was ever lost.
  await scheduleTyping(storage, now);
  return { active: result.active, extended: result.extended };
}

async function wakeClose(storage: DoStorage, body: DoOp): Promise<{ ok: true }> {
  if (!body.wakeId) return { ok: true };
  const now = body.now ?? Date.now();
  // Fallback covers the longest REPLY_TOKEN_TTL_SECONDS, so a retired token never revives.
  await storage.put(`wake:${body.wakeId}`, now + (body.ttlMs ?? 3_600_000));
  await pruneExpired(storage, "wake:", now);
  return { ok: true };
}

async function wakeClosed(storage: DoStorage, body: DoOp): Promise<{ closed: boolean }> {
  if (!body.wakeId) return { closed: false };
  const now = body.now ?? Date.now();
  const expiry = await storage.get<number>(`wake:${body.wakeId}`);
  if (expiry !== undefined && expiry > now) return { closed: true };
  return { closed: await legacyActive(storage, "wakes", body.wakeId, now) };
}

interface StoredSend {
  until: number;
  record: SendRecord;
}

/** Serialized by the object, so of two concurrent claims exactly one is told it owns the send. */
async function sendClaim(storage: DoStorage, body: DoOp): Promise<{ claimed: boolean; record?: SendRecord }> {
  // Without a key there is nothing to dedupe on; refuse rather than risk a resend.
  if (!body.sendKey) return { claimed: false, record: { state: "pending", message_ids: [] } };
  const now = body.now ?? Date.now();
  const key = `send:${body.sendKey}`;
  const existing = await storage.get<StoredSend>(key);
  if (existing && existing.until > now) {
    return { claimed: false, record: normalizeSendRecord(existing.record) ?? { state: "pending", message_ids: [] } };
  }
  await storage.put<StoredSend>(key, { until: now + (body.ttlMs ?? 3_600_000), record: { state: "pending", message_ids: [] } });
  await pruneExpired(storage, "send:", now);
  return { claimed: true };
}

interface MediaIndex {
  ids: string[];
  until: number;
}

async function mediaPut(storage: DoStorage, body: DoOp): Promise<{ ok: boolean }> {
  const grant = copyMediaGrant(body.grant);
  const now = body.now ?? Date.now();
  if (!grant || grant.expiresAtMs <= now) return { ok: false };
  await storage.put(`mediagrant:${grant.mediaId}`, grant);
  const indexKey = `mediawake:${grant.wakeId}`;
  const existing = await storage.get<MediaIndex>(indexKey);
  const ids = existing && Array.isArray(existing.ids) ? existing.ids.filter((id) => typeof id === "string") : [];
  if (!ids.includes(grant.mediaId)) ids.push(grant.mediaId);
  const until = Math.max(grant.expiresAtMs, existing?.until ?? 0);
  await storage.put<MediaIndex>(indexKey, { ids: ids.slice(-8), until });
  await pruneMedia(storage, now);
  return { ok: true };
}

async function mediaGet(storage: DoStorage, body: DoOp): Promise<{ grant: MediaGrant | null }> {
  const now = body.now ?? Date.now();
  const mediaId = body.mediaId ?? "";
  await pruneMedia(storage, now);
  const grant = copyMediaGrant(await storage.get<unknown>(`mediagrant:${mediaId}`));
  if (!grant || grant.expiresAtMs <= now || grant.mediaId !== mediaId) {
    if (mediaId) await storage.delete(`mediagrant:${mediaId}`);
    return { grant: null };
  }
  return { grant };
}

async function mediaDeleteWake(storage: DoStorage, body: DoOp): Promise<{ ok: true }> {
  if (!body.wakeId) return { ok: true };
  const index = await storage.get<MediaIndex>(`mediawake:${body.wakeId}`);
  for (const id of index?.ids ?? []) {
    if (typeof id === "string") await storage.delete(`mediagrant:${id}`);
  }
  await storage.delete(`mediawake:${body.wakeId}`);
  return { ok: true };
}

async function pruneMedia(storage: DoStorage, now: number): Promise<void> {
  const grants = await storage.list<unknown>({ prefix: "mediagrant:", limit: PRUNE_BATCH });
  for (const [key, value] of grants) {
    const expiry = (value as { expiresAtMs?: unknown } | null)?.expiresAtMs;
    if (typeof expiry !== "number" || expiry <= now) await storage.delete(key);
  }
  const indexes = await storage.list<unknown>({ prefix: "mediawake:", limit: PRUNE_BATCH });
  for (const [key, value] of indexes) {
    const until = (value as { until?: unknown } | null)?.until;
    if (typeof until !== "number" || until <= now) await storage.delete(key);
  }
}

async function sendFinish(storage: DoStorage, body: DoOp): Promise<{ ok: true }> {
  const record = normalizeSendRecord(body.record);
  if (!body.sendKey || !record) return { ok: true };
  const now = body.now ?? Date.now();
  await storage.put<StoredSend>(`send:${body.sendKey}`, { until: now + (body.ttlMs ?? 3_600_000), record });
  return { ok: true };
}
