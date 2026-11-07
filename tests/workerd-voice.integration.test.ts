import * as esbuild from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { WakeEvent } from "../src/core/types.js";

const OGG = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]);
const TOKEN = "123456:ABCDEFghij";
const FILE_ID = "AwACAgQAAxkBAAIFKWfPCSN82kPw7sqAG-_9E6z9orxgAALRHwAC0Tl4Uj7NUibkOW-wNgQ";

interface Seen {
  method: string;
  host: string;
  path: string;
}

function voiceUpdate(updateId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 40 + updateId,
      date: 1_700_000_000,
      voice: {
        file_id: FILE_ID,
        file_unique_id: "AgAD0R8AAtE5eFI",
        duration: 4,
        mime_type: "audio/ogg",
        file_size: OGG.byteLength,
      },
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      chat: { id: -500, type: "group", title: "Lab" },
      reply_to_message: {
        message_id: 3,
        text: "earlier",
        chat: { id: -500, type: "group" },
        from: { id: 999, is_bot: true, username: "testbot" },
      },
    },
  };
}

function textUpdate(updateId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 80 + updateId,
      date: 1_700_000_000,
      text: "/ask@testbot hello",
      entities: [{ type: "bot_command", offset: 0, length: 12 }],
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      chat: { id: -500, type: "group", title: "Lab" },
    },
  };
}

let bundled: string | undefined;

async function workerSource(): Promise<string> {
  if (bundled) return bundled;
  const result = await esbuild.build({
    absWorkingDir: process.cwd(),
    entryPoints: ["src/adapters/cloudflare/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  bundled = result.outputFiles?.[0]?.text;
  if (!bundled) throw new Error("worker bundle was empty");
  return bundled;
}

function textEnv(): Record<string, { type: "text"; value: string } | { type: "durable-object"; worker: string; exportName: string }> {
  const values: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
    TELEGRAM_BOT_USERNAME: "testbot",
    TELEGRAM_BOT_ID: "999",
    GROK_WEBHOOK_URL: "https://grok.example/hook",
    GROK_WEBHOOK_SENDER_KEY: "sender-key-value",
    REPLY_TOKEN_SECRET: "reply-token-secret-for-tests-only-0123456789",
    PUBLIC_BASE_URL: "https://bridge.example",
    ALLOWLIST_CHAT_IDS: "-500",
    FORWARD_FAILURE_TEXT: "",
  };
  const env: Record<string, { type: "text"; value: string } | { type: "durable-object"; worker: string; exportName: string }> = {};
  for (const [key, value] of Object.entries(values)) env[key] = { type: "text", value };
  env.CHAT_SESSION = { type: "durable-object", worker: "grokbot", exportName: "ChatSession" };
  return env;
}

async function startBridge(handler: http.RequestListener): Promise<{ mf: Miniflare; seen: Seen[] }> {
  const seen: Seen[] = [];
  const source = await workerSource();
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "grokbot",
          compatibilityDate: "2026-01-15",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: source } },
          },
          exports: {
            ChatSession: { type: "durable-object", storage: "sqlite" },
          },
          env: textEnv(),
        },
        dev: {
          outboundService: {
            type: "node-handler",
            handler(req, res) {
              const host = String(req.headers.host ?? "");
              const requestPath = req.url ?? "/";
              seen.push({ method: req.method ?? "GET", host, path: requestPath.split("?")[0] ?? requestPath });
              handler(req, res);
            },
          },
        },
      },
    ],
  });
  await mf.ready;
  return { mf, seen };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

async function postWebhook(mf: Miniflare, update: unknown): Promise<Response> {
  return mf.dispatchFetch("https://bridge.example/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "webhook-secret-value",
    },
    body: JSON.stringify(update),
  });
}

describe("workerd voice path", () => {
  const running: Miniflare[] = [];

  afterAll(async () => {
    await Promise.all(running.map((mf) => mf.dispose()));
  });

  it("recovers a workerd connection reset on the file GET and serves the Ogg bytes", async () => {
    let fileGets = 0;
    let wake: WakeEvent | undefined;
    const { mf, seen } = await startBridge(async (req, res) => {
      const host = String(req.headers.host ?? "");
      const requestPath = req.url ?? "/";
      if (host === "grok.example") {
        wake = JSON.parse((await readBody(req)).toString("utf8")) as WakeEvent;
        res.writeHead(202, { "content-type": "text/plain" });
        res.end("accepted");
        return;
      }
      if (requestPath.endsWith("/getFile")) {
        await readBody(req);
        sendJson(res, 200, {
          ok: true,
          result: { file_path: "voice/file_36.oga", file_size: OGG.byteLength },
        });
        return;
      }
      if (requestPath.includes("/file/bot")) {
        fileGets += 1;
        if (fileGets === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(OGG.byteLength),
        });
        res.end(Buffer.from(OGG));
        return;
      }
      await readBody(req);
      sendJson(res, 200, { ok: true, result: true });
    });
    running.push(mf);

    expect((await postWebhook(mf, voiceUpdate(1))).status).toBe(200);
    await viWaitFor(() => wake);
    const item = wake?.message.media_items?.[0];
    expect(item?.available).toBe(true);
    expect(item?.download_url).toBe(`https://bridge.example/media/${item?.id}`);
    const response = await mf.dispatchFetch(item?.download_url ?? "", {
      headers: { authorization: `Bearer ${wake?.reply.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OGG);
    expect(fileGets).toBe(2);
    expect(seen.some((call) => call.host === "api.telegram.org" && call.path.endsWith("/getFile") && call.method === "POST")).toBe(true);
    const downloads = seen.filter((call) => call.host === "api.telegram.org" && call.path.endsWith("/voice/file_36.oga"));
    expect(downloads).toHaveLength(2);
    expect(downloads.every((call) => call.method === "GET")).toBe(true);
  }, 30_000);

  it("reports a duplicate content-length from workerd without retrying or echoing the header", async () => {
    let fileGets = 0;
    let wake: WakeEvent | undefined;
    const { mf } = await startBridge(async (req, res) => {
      const host = String(req.headers.host ?? "");
      const requestPath = req.url ?? "/";
      if (host === "grok.example") {
        wake = JSON.parse((await readBody(req)).toString("utf8")) as WakeEvent;
        res.writeHead(202);
        res.end("accepted");
        return;
      }
      if (requestPath.endsWith("/getFile")) {
        await readBody(req);
        sendJson(res, 200, { ok: true, result: { file_path: "voice/file_36.oga", file_size: OGG.byteLength } });
        return;
      }
      if (requestPath.includes("/file/bot")) {
        fileGets += 1;
        const socket = res.socket;
        if (!socket) throw new Error("missing socket");
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: ${OGG.byteLength}\r\ncontent-length: ${OGG.byteLength}\r\n\r\n`,
        );
        socket.end(Buffer.from(OGG));
        return;
      }
      await readBody(req);
      sendJson(res, 200, { ok: true, result: true });
    });
    running.push(mf);
    expect((await postWebhook(mf, voiceUpdate(2))).status).toBe(200);
    await viWaitFor(() => wake);
    const item = wake?.message.media_items?.[0];
    const response = await mf.dispatchFetch(item?.download_url ?? "", {
      headers: { authorization: `Bearer ${wake?.reply.token}` },
    });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: "media_fetch_failed", reason: "download_bad_content_length" });
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(FILE_ID);
    expect(body).not.toContain("content-length");
    expect(fileGets).toBe(1);
  }, 30_000);

  it("runs webhook, grant, download, simulated transcript, one final send, then closes the grant", async () => {
    const sends: unknown[] = [];
    const box: { wake?: WakeEvent } = {};
    const { mf } = await startBridge(async (req, res) => {
      const host = String(req.headers.host ?? "");
      const requestPath = req.url ?? "/";
      const raw = await readBody(req);
      if (host === "grok.example") {
        box.wake = JSON.parse(raw.toString("utf8")) as WakeEvent;
        res.writeHead(202);
        res.end("accepted");
        return;
      }
      if (requestPath.endsWith("/getFile")) {
        sendJson(res, 200, {
          ok: true,
          result: {
            file_id: FILE_ID,
            file_unique_id: "AgAD0R8AAtE5eFI",
            file_size: OGG.byteLength,
            file_path: "voice/file_36.oga",
          },
        });
        return;
      }
      if (requestPath.includes("/file/bot")) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(OGG.byteLength),
        });
        res.end(Buffer.from(OGG));
        return;
      }
      if (requestPath.endsWith("/sendMessage")) {
        sends.push(JSON.parse(raw.toString("utf8")) as unknown);
        sendJson(res, 200, { ok: true, result: { message_id: 70 + sends.length } });
        return;
      }
      sendJson(res, 200, { ok: true, result: true });
    });
    running.push(mf);

    const textResponse = await postWebhook(mf, textUpdate(3));
    expect(textResponse.status).toBe(200);
    await viWaitFor(() => box.wake);
    expect(box.wake?.message.text).toContain("hello");
    expect(JSON.stringify(box.wake?.message ?? {})).not.toContain("media_items");
    box.wake = undefined;

    expect((await postWebhook(mf, voiceUpdate(4))).status).toBe(200);
    await viWaitFor(() => (box.wake?.message.media_items?.length ? 1 : 0));
    const voice = box.wake as WakeEvent | undefined;
    const item = voice?.message.media_items?.[0];
    expect(item?.kind).toBe("voice");
    expect(JSON.stringify(voice)).not.toContain(FILE_ID);
    expect(JSON.stringify(voice)).not.toContain(TOKEN);

    const denied = await mf.dispatchFetch(item?.download_url ?? "", {
      headers: { authorization: "Bearer v1.not-a-token" },
    });
    expect(denied.status).toBe(401);

    const downloaded = await mf.dispatchFetch(item?.download_url ?? "", {
      headers: { authorization: `Bearer ${voice?.reply.token}` },
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("audio/ogg");
    expect(downloaded.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const transcript = await simulatedLocalStt(bytes);
    expect(transcript).toEqual({ ok: true, language: "he", text: "simulated-transcript" });

    const sent = await mf.dispatchFetch("https://bridge.example/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${voice?.reply.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: "-500",
        text: transcript.text,
        reply_to_message_id: 44,
        final: true,
      }),
    });
    expect(sent.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chat_id: "-500", text: "simulated-transcript" });

    const again = await mf.dispatchFetch("https://bridge.example/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${voice?.reply.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ chat_id: "-500", text: "second", reply_to_message_id: 44, final: true }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, already_sent: true });
    expect(sends).toHaveLength(1);

    const closed = await mf.dispatchFetch(item?.download_url ?? "", {
      headers: { authorization: `Bearer ${voice?.reply.token}` },
    });
    expect(closed.status).toBe(401);
    expect(await closed.json()).toEqual({ ok: false, error: "wake_closed" });
  }, 30_000);

  it("asks the real Telegram getFile endpoint and keeps an HTTP 401, not a thrown fetch", async () => {
    let wake: WakeEvent | undefined;
    const { mf, seen } = await startBridge(async (req, res) => {
      const host = String(req.headers.host ?? "");
      if (host === "grok.example") {
        wake = JSON.parse((await readBody(req)).toString("utf8")) as WakeEvent;
        res.writeHead(202);
        res.end("accepted");
        return;
      }
      if (host === "api.telegram.org") {
        await proxyTelegram(req, res);
        return;
      }
      await readBody(req);
      sendJson(res, 200, { ok: true, result: true });
    });
    running.push(mf);
    expect((await postWebhook(mf, voiceUpdate(5))).status).toBe(200);
    await viWaitFor(() => wake);
    const item = wake?.message.media_items?.[0];
    const response = await mf.dispatchFetch(item?.download_url ?? "", {
      headers: { authorization: `Bearer ${wake?.reply.token}` },
    });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: "media_fetch_failed", reason: "getfile_http_401" });
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(FILE_ID);
    expect(seen.some((call) => call.host === "api.telegram.org" && call.path.endsWith("/getFile") && call.method === "POST")).toBe(true);
    expect(seen.some((call) => call.path.includes("/file/bot"))).toBe(false);
  }, 30_000);
});

async function viWaitFor(read: () => unknown): Promise<void> {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > 5_000) throw new Error("timed out waiting for the wake");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Stand-in for /workspace/telegram-voice-test/run.sh. This VM does not have
 * the Hebrew model. The fixture only checks the bytes and deletes its temp dir.
 */
async function simulatedLocalStt(bytes: Buffer): Promise<{ ok: true; language: "he"; text: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "voice-sim-"));
  try {
    const file = path.join(dir, "voice.ogg");
    await writeFile(file, bytes, { mode: 0o600 });
    if (bytes.subarray(0, 4).toString("ascii") !== "OggS") throw new Error("not ogg");
    return { ok: true, language: "he", text: "simulated-transcript" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function proxyTelegram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers = { ...req.headers, host: "api.telegram.org" };
      delete headers["content-length"];
      const upstream = https.request(
        {
          host: "api.telegram.org",
          method: req.method,
          path: req.url,
          headers,
        },
        (incoming) => {
          res.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(res);
          incoming.on("end", () => resolve());
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: "proxy_failed" });
        else res.end();
        resolve();
      });
      const body = Buffer.concat(chunks);
      if (body.length > 0) Readable.from(body).pipe(upstream);
      else upstream.end();
    });
  });
}
