import { ABSOLUTE_MEDIA_MAX_BYTES, ABSOLUTE_MEDIA_MAX_DURATION_SECONDS } from "./config.js";
import type { ContextMessage, TypingScope } from "./types.js";
import { scopeDeadline } from "./typing.js";

export interface Store {
  claimUpdate(updateId: number, now: number, ttlMs: number): Promise<"new" | "duplicate">;
  /** Drop a claim so a failed handler can still be retried by Telegram. */
  releaseUpdate(updateId: number): Promise<void>;
  /**
   * Claim one Telegram message (chat + message_id) for a wake. Atomic: of any
   * number of concurrent claims, one gets "new". A redelivery under a new
   * update_id, or an edit of a message that already woke the bot, gets "duplicate".
   */
  claimMessage(chatId: string, messageId: number, now: number, ttlMs: number): Promise<"new" | "duplicate">;
  hitRate(
    bucketKey: string,
    now: number,
    windowMs: number,
    max: number,
  ): Promise<{ allowed: boolean; count: number }>;
  /** Returns the previous buffer, capped at `limit`, not including `message`. */
  pushContext(scopeKey: string, message: ContextMessage, limit: number): Promise<ContextMessage[]>;
  /** The active wakes in one chat (and forum topic), or null when none. */
  getTyping(scopeKey: string): Promise<TypingScope | null>;
  setTyping(scopeKey: string, scope: TypingScope | null): Promise<void>;
  closeWake(wakeId: string, now: number, ttlMs: number): Promise<void>;
  /**
   * Claim an idempotent /send. Atomic set-if-absent: returns null when this
   * caller now owns `key` (stored as `pending`), or the record already there.
   */
  claimSend(key: string, now: number, ttlMs: number): Promise<SendRecord | null>;
  /** Record how a claimed send ended. Kept for `ttlMs` (the reply token's remaining life). */
  finishSend(key: string, record: SendRecord, now: number, ttlMs: number): Promise<void>;
  /** Drop a claim after a send that definitely did not go out, so it can be tried again. */
  releaseSend(key: string): Promise<void>;
  isWakeClosed(wakeId: string, now: number): Promise<boolean>;
  /**
   * Remember a Telegram file id for one wake. The id never leaves the bridge.
   * `now` drops grants that have already expired.
   */
  putMedia(grant: MediaGrant, now: number): Promise<void>;
  /** The grant for this chat and media id, or null when it is missing, expired, or for another chat. */
  getMedia(chatId: string, mediaId: string, now: number): Promise<MediaGrant | null>;
  deleteMedia(chatId: string, mediaId: string): Promise<void>;
  /** Drop every media grant for one wake. Used when the final reply is delivered or the forward fails. */
  deleteWakeMedia(chatId: string, wakeId: string): Promise<void>;
}

/**
 * Server-side permission to pull one Telegram voice or audio file.
 * `fileId` is the Bot API file_id. It stays in the store and is never put on the wake.
 */
export interface MediaGrant {
  mediaId: string;
  wakeId: string;
  chatId: string;
  userId: string | null;
  threadId: number | null;
  kind: "voice" | "audio";
  fileId: string;
  mimeType: string | null;
  fileName: string | null;
  durationSeconds: number | null;
  fileSize: number | null;
  expiresAtMs: number;
}

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MEDIA_GRANTS = 200;

function isCanonicalStoredId(value: string): boolean {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0;
}

/** Telegram file_id, kept opaque. Reject path and URL shapes so it cannot be turned into a request URL. */
export function isTelegramFileId(value: string): boolean {
  if (value.length < 8 || value.length > 512) return false;
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  if (/["\\%<>]/.test(value)) return false;
  const lower = value.toLowerCase();
  return !lower.includes("..") && !lower.includes("://") && !lower.includes("%2e") && !lower.includes("%2f");
}

/** Copy a grant field by field. Returns null when any field is missing or unsafe. */
export function copyMediaGrant(value: unknown): MediaGrant | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const mediaId = record.mediaId;
  const wakeId = record.wakeId;
  const chatId = record.chatId;
  const fileId = record.fileId;
  const kind = record.kind;
  const expiresAtMs = record.expiresAtMs;
  if (typeof mediaId !== "string" || !MEDIA_ID.test(mediaId)) return null;
  if (typeof wakeId !== "string" || wakeId.length < 1 || wakeId.length > 80) return null;
  if (typeof chatId !== "string" || !isCanonicalStoredId(chatId)) return null;
  if (typeof fileId !== "string" || !isTelegramFileId(fileId)) return null;
  if (kind !== "voice" && kind !== "audio") return null;
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return null;
  const userId = record.userId;
  if (userId !== null && (typeof userId !== "string" || !isCanonicalStoredId(userId))) return null;
  const threadId = record.threadId;
  if (threadId !== null && (typeof threadId !== "number" || !Number.isSafeInteger(threadId))) return null;
  const mimeType = record.mimeType;
  if (mimeType !== null && (typeof mimeType !== "string" || !/^audio\/[a-z0-9.+-]{1,64}$/.test(mimeType))) return null;
  const fileName = record.fileName;
  if (fileName !== null && (typeof fileName !== "string" || fileName.length < 1 || fileName.length > 64 || /[/\\]/.test(fileName) || fileName.includes(".."))) {
    return null;
  }
  const durationSeconds = record.durationSeconds;
  if (durationSeconds !== null && (typeof durationSeconds !== "number" || !Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > ABSOLUTE_MEDIA_MAX_DURATION_SECONDS)) {
    return null;
  }
  const fileSize = record.fileSize;
  if (fileSize !== null && (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > ABSOLUTE_MEDIA_MAX_BYTES)) {
    return null;
  }
  return {
    mediaId,
    wakeId,
    chatId,
    userId,
    threadId,
    kind,
    fileId,
    mimeType,
    fileName,
    durationSeconds,
    fileSize,
    expiresAtMs,
  };
}

/**
 * One idempotent /send. `pending` while it is in flight (or if the instance
 * died mid-send), `sent` once Telegram accepted every part, `ambiguous` when
 * Telegram may or may not have posted it. Only `sent` is answered with
 * already_sent; the other two are never resent.
 */
export interface SendRecord {
  state: "pending" | "sent" | "ambiguous";
  message_ids: number[];
}

export function normalizeSendRecord(value: unknown): SendRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.state !== "pending" && record.state !== "sent" && record.state !== "ambiguous") return null;
  const ids = Array.isArray(record.message_ids)
    ? record.message_ids.filter((id): id is number => typeof id === "number")
    : [];
  return { state: record.state, message_ids: ids };
}

export function scopeKey(chatId: string, threadId: number | null): string {
  return `chat:${chatId}:thread:${threadId ?? "root"}`;
}

export function chatIdFromScope(key: string): string {
  const marker = ":thread:";
  const start = "chat:".length;
  const idx = key.lastIndexOf(marker);
  if (!key.startsWith("chat:") || idx < start) return "";
  return key.slice(start, idx);
}

export function rateChatKey(chatId: string): string {
  return `rate:chat:${chatId}`;
}

export function rateUserKey(chatId: string, userId: string): string {
  return `rate:chat:${chatId}:user:${userId}`;
}

export function chatIdFromRateKey(key: string): string {
  const prefix = "rate:chat:";
  if (!key.startsWith(prefix)) return "";
  const rest = key.slice(prefix.length);
  const userIdx = rest.indexOf(":user:");
  return userIdx === -1 ? rest : rest.slice(0, userIdx);
}

/**
 * How long a message that started a wake is remembered, so an edit of it does
 * not start another. Matches the age past which context is no longer attached.
 */
export const MESSAGE_CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;

/** Context older than this (by Telegram message date) is not attached to wakes. */
export const CONTEXT_MAX_AGE_SECONDS = 7 * 24 * 3600;

/** Previous buffer for `message`: capped at `limit`, without itself or entries a week older than it. */
export function freshContext(previous: readonly ContextMessage[], message: ContextMessage, limit: number): ContextMessage[] {
  const cutoff = message.date === null ? null : message.date - CONTEXT_MAX_AGE_SECONDS;
  // Same message_id = a Telegram retry or an edit; never report the current message as prior context.
  const fresh = previous.filter((item) =>
    item.message_id !== message.message_id && (cutoff === null || item.date === null || item.date >= cutoff));
  return fresh.slice(-limit);
}

/** Bound memory in long-lived single-process deployments. */
const MAX_MEMORY_SCOPES = 1000;

interface Bucket {
  windowStart: number;
  count: number;
}

export class MemoryStore implements Store {
  private readonly updates = new Map<number, number>();
  private readonly messages = new Map<string, number>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly contexts = new Map<string, ContextMessage[]>();
  private readonly typing = new Map<string, TypingScope>();
  private readonly closedWakes = new Map<string, number>();
  private readonly sends = new Map<string, { until: number; record: SendRecord }>();
  private readonly media = new Map<string, MediaGrant>();

  async claimUpdate(updateId: number, now: number, ttlMs: number): Promise<"new" | "duplicate"> {
    this.pruneUpdates(now);
    const expiry = this.updates.get(updateId);
    if (expiry !== undefined && expiry > now) return "duplicate";
    this.updates.set(updateId, now + ttlMs);
    return "new";
  }

  async releaseUpdate(updateId: number): Promise<void> {
    this.updates.delete(updateId);
  }

  async claimMessage(chatId: string, messageId: number, now: number, ttlMs: number): Promise<"new" | "duplicate"> {
    for (const [key, expiry] of this.messages) {
      if (expiry <= now) this.messages.delete(key);
    }
    const key = `${chatId}:${messageId}`;
    const expiry = this.messages.get(key);
    if (expiry !== undefined && expiry > now) return "duplicate";
    this.messages.set(key, now + ttlMs);
    return "new";
  }

  async hitRate(
    bucketKey: string,
    now: number,
    windowMs: number,
    max: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      for (const [key, value] of this.buckets) {
        if (value.windowStart < windowStart) this.buckets.delete(key);
      }
    }
    bucket.count += 1;
    this.buckets.set(bucketKey, bucket);
    return { allowed: bucket.count <= max, count: bucket.count };
  }

  async pushContext(key: string, message: ContextMessage, limit: number): Promise<ContextMessage[]> {
    const previous = this.contexts.get(key) ?? [];
    const prior = freshContext(previous, message, limit);
    // Re-insert so Map order is least recently used first, then evict.
    this.contexts.delete(key);
    this.contexts.set(key, [...prior, message].slice(-limit));
    while (this.contexts.size > MAX_MEMORY_SCOPES) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    return prior;
  }

  async getTyping(key: string): Promise<TypingScope | null> {
    const scope = this.typing.get(key);
    return scope ? structuredClone(scope) : null;
  }

  async setTyping(key: string, scope: TypingScope | null): Promise<void> {
    if (scope && Object.keys(scope.wakes).length > 0) {
      // In "once" mode no timer clears a scope, so drop the ones past every wake's ceiling here.
      const latest = Math.max(...Object.values(scope.wakes).map((wake) => wake.startedAt));
      for (const [other, value] of this.typing) {
        if (other !== key && scopeDeadline(value) <= latest) this.typing.delete(other);
      }
      this.typing.set(key, structuredClone(scope));
    } else {
      this.typing.delete(key);
    }
  }

  async closeWake(wakeId: string, now: number, ttlMs: number): Promise<void> {
    this.pruneWakes(now);
    this.closedWakes.set(wakeId, now + ttlMs);
  }

  async isWakeClosed(wakeId: string, now: number): Promise<boolean> {
    const expiry = this.closedWakes.get(wakeId);
    if (expiry === undefined) return false;
    if (expiry <= now) {
      this.closedWakes.delete(wakeId);
      return false;
    }
    return true;
  }

  async claimSend(key: string, now: number, ttlMs: number): Promise<SendRecord | null> {
    for (const [other, entry] of this.sends) {
      if (entry.until <= now) this.sends.delete(other);
    }
    const existing = this.sends.get(key);
    if (existing) return structuredClone(existing.record);
    this.sends.set(key, { until: now + ttlMs, record: { state: "pending", message_ids: [] } });
    return null;
  }

  async finishSend(key: string, record: SendRecord, now: number, ttlMs: number): Promise<void> {
    this.sends.set(key, { until: now + ttlMs, record: structuredClone(record) });
  }

  async releaseSend(key: string): Promise<void> {
    this.sends.delete(key);
  }

  async putMedia(grant: MediaGrant, now: number): Promise<void> {
    const clean = copyMediaGrant(grant);
    if (!clean || clean.expiresAtMs <= now) throw new Error("bad_media_grant");
    this.pruneMedia(now);
    this.media.delete(clean.mediaId);
    this.media.set(clean.mediaId, clean);
    while (this.media.size > MAX_MEDIA_GRANTS) {
      const oldest = this.media.keys().next().value;
      if (oldest === undefined) break;
      this.media.delete(oldest);
    }
  }

  async getMedia(chatId: string, mediaId: string, now: number): Promise<MediaGrant | null> {
    const found = this.media.get(mediaId);
    if (!found) return null;
    if (found.expiresAtMs <= now) {
      this.media.delete(mediaId);
      return null;
    }
    if (found.chatId !== chatId) return null;
    return copyMediaGrant(found);
  }

  async deleteMedia(chatId: string, mediaId: string): Promise<void> {
    const found = this.media.get(mediaId);
    if (found && found.chatId === chatId) this.media.delete(mediaId);
  }

  async deleteWakeMedia(chatId: string, wakeId: string): Promise<void> {
    for (const [id, grant] of this.media) {
      if (grant.chatId === chatId && grant.wakeId === wakeId) this.media.delete(id);
    }
  }

  private pruneUpdates(now: number): void {
    for (const [id, expiry] of this.updates) {
      if (expiry <= now) this.updates.delete(id);
    }
  }

  private pruneWakes(now: number): void {
    for (const [id, expiry] of this.closedWakes) {
      if (expiry <= now) this.closedWakes.delete(id);
    }
  }

  private pruneMedia(now: number): void {
    for (const [id, grant] of this.media) {
      if (grant.expiresAtMs <= now) this.media.delete(id);
    }
  }
}
