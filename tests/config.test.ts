import { describe, expect, it } from "vitest";
import { ABSOLUTE_MEDIA_MAX_BYTES, canonicalId, fatalConfigProblems, loadConfig, normalizePublicBaseUrl } from "../src/core/config.js";
import { handleRequest } from "../src/core/handler.js";
import { createTestApp, dmUpdate, postUpdate, testEnv } from "./helpers.js";

function grokCalls(calls: { url: string }[]): number {
  return calls.filter((call) => call.url.startsWith("https://grok.example/hook")).length;
}

describe("webhook secret validation", () => {
  it("fails closed on a short secret or one outside Telegram's charset", async () => {
    for (const bad of ["short", "has spaces in it, sadly!!", "x".repeat(257)]) {
      const app = createTestApp({ env: testEnv({ TELEGRAM_WEBHOOK_SECRET: bad }) });
      const response = await postUpdate(app.deps, app.tasks, dmUpdate("hi"), bad);
      expect(response.status).toBe(503);
      expect(grokCalls(app.calls)).toBe(0);
      expect(app.deps.config.problems).toContain("TELEGRAM_WEBHOOK_SECRET");
    }
  });

  it("rejects an empty header even when the configured secret is valid", async () => {
    const app = createTestApp();
    const response = await postUpdate(app.deps, app.tasks, dmUpdate("hi"), "");
    expect(response.status).toBe(401);
  });

  it("tells a long-running process to refuse to start without a valid secret", () => {
    expect(fatalConfigProblems(loadConfig(testEnv({ TELEGRAM_WEBHOOK_SECRET: "" })))).toEqual(["TELEGRAM_WEBHOOK_SECRET"]);
    expect(fatalConfigProblems(loadConfig(testEnv({ TELEGRAM_WEBHOOK_SECRET: "bad secret" })))).toEqual(["TELEGRAM_WEBHOOK_SECRET"]);
    expect(fatalConfigProblems(loadConfig(testEnv()))).toEqual([]);
  });
});

describe("key length floors", () => {
  it("does not issue or accept reply tokens with a weak signing secret", async () => {
    const app = createTestApp({ env: testEnv({ REPLY_TOKEN_SECRET: "too-short" }) });
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    expect(grokCalls(app.calls)).toBe(0);
    expect(app.deps.config.replyTokenSecret).toBe("");
    expect(app.deps.config.problems).toContain("REPLY_TOKEN_SECRET");
    const health = await (await handleRequest(new Request("https://bridge.example/healthz"), app.deps)).json() as { ready: boolean };
    expect(health.ready).toBe(false);
  });

  it("ignores a short OUTBOUND_API_KEY", async () => {
    const app = createTestApp({ env: testEnv({ OUTBOUND_API_KEY: "short-key" }) });
    expect(app.deps.config.outboundApiKey).toBeNull();
    const response = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: "Bearer short-key", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "-500", text: "proactive" }),
    }), app.deps);
    expect(response.status).toBe(401);
  });
});

describe("media caps", () => {
  it("defaults to 10 MiB and 5 minutes and never accepts a size above the 20 MiB getFile limit", () => {
    const config = loadConfig(testEnv());
    expect(config.mediaMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.mediaMaxDurationSeconds).toBe(300);
    expect(loadConfig(testEnv({ MEDIA_MAX_BYTES: "999999999" })).mediaMaxBytes).toBe(ABSOLUTE_MEDIA_MAX_BYTES);
    expect(loadConfig(testEnv({ MEDIA_MAX_DURATION_SECONDS: "86400" })).mediaMaxDurationSeconds).toBe(600);
  });
});

describe("public base url", () => {
  it("accepts only an https origin (http only for localhost)", () => {
    expect(normalizePublicBaseUrl("https://bridge.example/")).toBe("https://bridge.example");
    expect(normalizePublicBaseUrl("https://bridge.example/sub/")).toBe("https://bridge.example/sub");
    expect(normalizePublicBaseUrl("http://bridge.example")).toBe("");
    expect(normalizePublicBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizePublicBaseUrl("https://user:pw@bridge.example")).toBe("");
    expect(normalizePublicBaseUrl("https://bridge.example/?x=1")).toBe("");
    expect(normalizePublicBaseUrl("not a url")).toBe("");
  });

  it("never builds send_url from the request Host header", async () => {
    const app = createTestApp({ env: testEnv({ PUBLIC_BASE_URL: "" }) });
    const request = new Request("https://attacker.example/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "webhook-secret-value" },
      body: JSON.stringify(dmUpdate("hello")),
    });
    const response = await handleRequest(request, app.deps);
    await Promise.all(app.tasks);
    expect(response.status).toBe(200);
    expect(grokCalls(app.calls)).toBe(0);
  });

  it("rejects an http public base url for a non-local host", async () => {
    const app = createTestApp({ env: testEnv({ PUBLIC_BASE_URL: "http://bridge.example" }) });
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    expect(grokCalls(app.calls)).toBe(0);
    expect(app.deps.config.problems).toContain("PUBLIC_BASE_URL");
  });
});

describe("id parsing", () => {
  it("canonicalizes ids and reports junk without echoing it", () => {
    expect(canonicalId(" 42 ")).toBe("42");
    expect(canonicalId("-500")).toBe("-500");
    expect(canonicalId("042")).toBeNull();
    expect(canonicalId("+42")).toBeNull();
    expect(canonicalId("0")).toBeNull();
    expect(canonicalId("99999999999999999999")).toBeNull();
    const config = loadConfig(testEnv({ ALLOWLIST_USER_IDS: "42, nope", ALLOWLIST_CHAT_IDS: "-500" }));
    expect([...config.allowlistUserIds]).toEqual(["42"]);
    expect(config.problems).toEqual(["ALLOWLIST_USER_IDS"]);
  });

  it("does not let a zero-padded chat id slip past token scope", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    const token = (app.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as { reply: { token: string } }).reply.token;
    const padded = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "042", text: "x" }),
    }), app.deps);
    expect(padded.status).toBe(400);
  });
});

describe("progress settings", () => {
  it("defaults to a 3 second refresh, a 10 minute lease, a 30 minute ceiling, and 👀", () => {
    const config = loadConfig(testEnv());
    expect(config.typingRefreshMs).toBe(3000);
    expect(config.typingLeaseMs).toBe(600_000);
    expect(config.typingMaxMs).toBe(1_800_000);
    expect(config.replyTokenTtlSeconds).toBe(1800);
    expect(config.progressReaction).toBe("👀");
    expect(config.forwardFailureText).toBe("Sorry — I couldn't pick that up just now. Mind sending it again?");
    expect(config.draftPlaceholder).toBe(false);
  });

  it("clamps timings to sane bounds and keeps the lease under the ceiling", () => {
    expect(loadConfig(testEnv({ TYPING_REFRESH_MS: "100" })).typingRefreshMs).toBe(1000);
    expect(loadConfig(testEnv({ TYPING_REFRESH_MS: "10000" })).typingRefreshMs).toBe(4500);
    expect(loadConfig(testEnv({ TYPING_LEASE_MS: "1000" })).typingLeaseMs).toBe(60_000);
    const capped = loadConfig(testEnv({ TYPING_LEASE_MS: "3600000", TYPING_MAX_MS: "900000" }));
    expect(capped.typingLeaseMs).toBe(900_000);
    expect(loadConfig(testEnv({ TYPING_MAX_MS: "99999999" })).typingMaxMs).toBe(7_200_000);
    expect(loadConfig(testEnv({ REPLY_TOKEN_TTL_SECONDS: "0" })).replyTokenTtlSeconds).toBe(60);
    expect(loadConfig(testEnv({ REPLY_TOKEN_TTL_SECONDS: "86400" })).replyTokenTtlSeconds).toBe(3600);
  });

  it("accepts an allowed reaction emoji, can turn it off, and reports an unknown one", () => {
    expect(loadConfig(testEnv({ PROGRESS_REACTION: "✍" })).progressReaction).toBe("✍");
    expect(loadConfig(testEnv({ PROGRESS_REACTION: "✍️" })).progressReaction).toBe("✍️");
    expect(loadConfig(testEnv({ PROGRESS_REACTION: "off" })).progressReaction).toBeNull();
    const bad = loadConfig(testEnv({ PROGRESS_REACTION: "🦖" }));
    expect(bad.progressReaction).toBe("👀");
    expect(bad.problems).toContain("PROGRESS_REACTION");
  });

  it("lets the failure line be replaced or turned off", () => {
    expect(loadConfig(testEnv({ FORWARD_FAILURE_TEXT: "Try again?" })).forwardFailureText).toBe("Try again?");
    expect(loadConfig(testEnv({ FORWARD_FAILURE_TEXT: "off" })).forwardFailureText).toBeNull();
    expect(loadConfig(testEnv({ TELEGRAM_DRAFT_PLACEHOLDER: "true" })).draftPlaceholder).toBe(true);
  });
});
