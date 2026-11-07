import type { ContextMessage } from "../../core/types.js";
import { chatIdFromRateKey, chatIdFromScope, copyMediaGrant, normalizeSendRecord, type Store } from "../../core/store.js";
import { normalizeScope, type TypingController } from "../../core/typing.js";

export interface DoId {
  toString(): string;
}

export interface DoNamespace {
  idFromName(name: string): DoId;
  get(id: DoId): {
    fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  };
}

async function call(namespace: DoNamespace, name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stub = namespace.get(namespace.idFromName(name));
  const response = await stub.fetch("https://session.internal/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`durable_object_${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function chatObjectName(chatId: string): string {
  return `chat:${chatId}`;
}

export function createDurableBackend(namespace: DoNamespace): { store: Store; typing: TypingController } {
  const store: Store = {
    async claimUpdate(updateId, now, ttlMs) {
      const result = await call(namespace, "dedupe", { op: "claim", updateId, now, ttlMs });
      return result.status === "duplicate" ? "duplicate" : "new";
    },
    async releaseUpdate(updateId) {
      await call(namespace, "dedupe", { op: "release", updateId });
    },
    async claimMessage(chatId, messageId, now, ttlMs) {
      // The chat's object serializes claims for its messages, so concurrent deliveries get one "new".
      const result = await call(namespace, chatObjectName(chatId), { op: "msg.claim", messageId, now, ttlMs });
      return result.status === "new" ? "new" : "duplicate";
    },
    async hitRate(bucketKey, now, windowMs, max) {
      const chatId = chatIdFromRateKey(bucketKey);
      const result = await call(namespace, chatObjectName(chatId), {
        op: "rate",
        bucketKey,
        now,
        windowMs,
        max,
      });
      return {
        allowed: result.allowed === true,
        count: typeof result.count === "number" ? result.count : 0,
      };
    },
    async pushContext(scope, message, limit) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "context",
        scopeKey: scope,
        message,
        limit,
      });
      return Array.isArray(result.prior) ? (result.prior as ContextMessage[]) : [];
    },
    async getTyping(scope) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "typing.get",
        scopeKey: scope,
      });
      return normalizeScope(result.scope);
    },
    async setTyping(key, scope) {
      await call(namespace, chatObjectName(chatIdFromScope(key)), {
        op: "typing.set",
        scopeKey: key,
        scope,
      });
    },
    async closeWake(wakeId, now, ttlMs) {
      await call(namespace, "dedupe", { op: "wake.close", wakeId, now, ttlMs });
    },
    async isWakeClosed(wakeId, now) {
      const result = await call(namespace, "dedupe", { op: "wake.closed", wakeId, now });
      return result.closed === true;
    },
    async claimSend(key, now, ttlMs) {
      const result = await call(namespace, "dedupe", { op: "send.claim", sendKey: key, now, ttlMs });
      if (result.claimed === true) return null;
      return normalizeSendRecord(result.record) ?? { state: "pending", message_ids: [] };
    },
    async finishSend(key, record, now, ttlMs) {
      await call(namespace, "dedupe", { op: "send.finish", sendKey: key, record, now, ttlMs });
    },
    async releaseSend(key) {
      await call(namespace, "dedupe", { op: "send.release", sendKey: key });
    },
    async putMedia(grant, now) {
      const result = await call(namespace, chatObjectName(grant.chatId), { op: "media.put", grant, now });
      if (result.ok !== true) throw new Error("media_grant_rejected");
    },
    async getMedia(chatId, mediaId, now) {
      const result = await call(namespace, chatObjectName(chatId), { op: "media.get", mediaId, now });
      const grant = copyMediaGrant(result.grant);
      if (!grant || grant.chatId !== chatId) return null;
      return grant;
    },
    async deleteMedia(chatId, mediaId) {
      await call(namespace, chatObjectName(chatId), { op: "media.delete", mediaId });
    },
    async deleteWakeMedia(chatId, wakeId) {
      await call(namespace, chatObjectName(chatId), { op: "media.deleteWake", wakeId });
    },
  };

  // The chat's Durable Object owns typing state, the reaction, and the alarm, so they survive eviction.
  const typing: TypingController = {
    async start(input) {
      await call(namespace, chatObjectName(input.chatId), { op: "typing.start", start: input });
    },
    async stop(scope, wakeId) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "typing.stop",
        scopeKey: scope,
        wakeId,
      });
      return { stopped: result.stopped === true, reason: result.stopped === true ? "stopped" : "none" };
    },
    async touch(scope, wakeId) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "typing.touch",
        scopeKey: scope,
        wakeId,
      });
      return { active: result.active === true, extended: result.extended === true };
    },
  };

  return { store, typing };
}
