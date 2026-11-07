import { isAllowlisted } from "./allowlist.js";
import {
  ABSOLUTE_MEDIA_MAX_BYTES,
  ABSOLUTE_MEDIA_MAX_DURATION_SECONDS,
  type Config,
} from "./config.js";
import { verifyReplyToken } from "./crypto.js";
import type { AppDeps } from "./deps.js";
import { json } from "./http.js";
import { copyMediaGrant, isTelegramFileId, type MediaGrant } from "./store.js";
import { telegramMethodUrl } from "./telegram.js";
import { cleanLabel, joinUrl } from "./text.js";
import type { MediaItem, MediaUnavailableReason, TelegramMessage } from "./types.js";

const MEDIA_PATH = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DIR_SEGMENT = /^[A-Za-z0-9_-]{1,32}$/;
const FILE_SEGMENT = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9]{1,8})?$/;

const AUDIO_MIME = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

export function matchMediaPath(path: string): string | null {
  if (path.includes("\\") || path.includes("..") || path.includes("%")) return null;
  return MEDIA_PATH.exec(path)?.[1] ?? null;
}

/**
 * A Telegram getFile `file_path` is a relative path, not a URL.
 * Anything else is refused before a download request is built.
 */
export function sanitizeTelegramFilePath(filePath: string): string | null {
  if (filePath.length < 3 || filePath.length > 200) return null;
  if (filePath !== filePath.trim()) return null;
  // eslint-disable-next-line no-control-regex -- reject control characters in a Telegram file path
  if (/[\u0000-\u001f\\?#%]/.test(filePath)) return null;
  if (filePath.startsWith("/") || filePath.includes("//") || filePath.includes("..") || filePath.includes(":")) return null;
  const parts = filePath.split("/");
  if (parts.length < 2 || parts.length > 3) return null;
  const file = parts[parts.length - 1] ?? "";
  if (!parts.slice(0, -1).every((dir) => DIR_SEGMENT.test(dir))) return null;
  if (!FILE_SEGMENT.test(file)) return null;
  return parts.join("/");
}

export function planWakeMedia(options: {
  message: TelegramMessage;
  config: Pick<Config, "publicBaseUrl" | "pathPrefix" | "mediaMaxBytes" | "mediaMaxDurationSeconds">;
  chatId: string;
  threadId: number | null;
  userId: string | null;
  wakeId: string;
  expiresAtMs: number;
}): { items: MediaItem[]; grants: MediaGrant[] } {
  const specs: Array<{ kind: "voice" | "audio"; raw: unknown }> = [];
  if (options.message.voice) specs.push({ kind: "voice", raw: options.message.voice });
  if (options.message.audio) specs.push({ kind: "audio", raw: options.message.audio });
  const items: MediaItem[] = [];
  const grants: MediaGrant[] = [];
  for (const spec of specs) {
    const built = buildMedia(spec.kind, spec.raw, options);
    items.push(built.item);
    if (built.grant) grants.push(built.grant);
  }
  return { items, grants };
}

export async function handleMediaDownload(request: Request, deps: AppDeps, mediaId: string): Promise<Response> {
  if (!requestHostAllowed(request.url, deps.config.publicBaseUrl)) {
    deps.log({ event: "media_rejected", reason: "origin" });
    return json(404, { ok: false, error: "not_found" });
  }
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? "";
  if (!bearer || !deps.config.replyTokenSecret || !bearer.startsWith("v1.")) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const verified = await verifyReplyToken(deps.config.replyTokenSecret, bearer, deps.now());
  if (!verified.ok) return json(401, { ok: false, error: verified.reason });
  const claims = verified.claims;
  if (await deps.store.isWakeClosed(claims.wake_id, deps.now())) {
    await deps.store.deleteWakeMedia(claims.chat_id, claims.wake_id).catch(() => undefined);
    return json(401, { ok: false, error: "wake_closed" });
  }
  const grant = await deps.store.getMedia(claims.chat_id, mediaId, deps.now());
  if (!grant || grant.wakeId !== claims.wake_id) {
    return json(404, { ok: false, error: "media_not_found" });
  }
  if (grant.chatId !== claims.chat_id || (grant.threadId ?? null) !== (claims.thread_id ?? null)) {
    return json(403, { ok: false, error: "scope" });
  }
  if (!isAllowlisted(grant.userId, grant.chatId, deps.config)) {
    deps.log({ event: "media_rejected", reason: "not_allowlisted", chat_id: claims.chat_id, media_id: mediaId });
    return json(403, { ok: false, error: "not_allowlisted" });
  }

  const maxBytes = Math.min(deps.config.mediaMaxBytes, ABSOLUTE_MEDIA_MAX_BYTES);
  const fetched = await downloadTelegramAudio({
    token: deps.config.telegramBotToken,
    fileId: grant.fileId,
    declaredMime: grant.mimeType,
    maxBytes,
    fetchImpl: deps.fetchImpl,
  });
  if (!fetched.ok) {
    if (fetched.reason === "too_large" || fetched.reason === "type_rejected") {
      await deps.store.deleteMedia(claims.chat_id, mediaId).catch(() => undefined);
    }
    deps.log({
      event: "media_download_failed",
      chat_id: claims.chat_id,
      wake_id: claims.wake_id,
      media_id: mediaId,
      error: fetched.reason,
    });
    if (fetched.reason === "too_large") return json(413, { ok: false, error: "media_too_large" });
    if (fetched.reason === "type_rejected") return json(415, { ok: false, error: "media_type_rejected" });
    return json(502, { ok: false, error: "media_fetch_failed" });
  }

  deps.log({
    event: "media_download",
    chat_id: claims.chat_id,
    wake_id: claims.wake_id,
    media_id: mediaId,
    bytes: fetched.bytes.byteLength,
  });
  const filename = downloadName(grant.kind, fetched.mime);
  return new Response(fetched.bytes, {
    status: 200,
    headers: {
      "content-type": fetched.mime,
      "content-length": String(fetched.bytes.byteLength),
      "cache-control": "no-store",
      "cdn-cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

function requestHostAllowed(requestUrl: string, publicBaseUrl: string): boolean {
  if (!publicBaseUrl) return false;
  try {
    return new URL(requestUrl).hostname === new URL(publicBaseUrl).hostname;
  } catch {
    return false;
  }
}

function buildMedia(
  kind: "voice" | "audio",
  raw: unknown,
  options: {
    config: Pick<Config, "publicBaseUrl" | "pathPrefix" | "mediaMaxBytes" | "mediaMaxDurationSeconds">;
    chatId: string;
    threadId: number | null;
    userId: string | null;
    wakeId: string;
    expiresAtMs: number;
  },
): { item: MediaItem; grant: MediaGrant | null } {
  const id = crypto.randomUUID();
  const blank = (reason: MediaUnavailableReason, partial: Partial<MediaItem> = {}): { item: MediaItem; grant: null } => ({
    item: {
      id,
      kind,
      mime_type: partial.mime_type ?? null,
      file_name: partial.file_name ?? null,
      duration_seconds: partial.duration_seconds ?? null,
      file_size: partial.file_size ?? null,
      available: false,
      unavailable_reason: reason,
      download_url: null,
    },
    grant: null,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return blank("bad_file");
  const record = raw as Record<string, unknown>;
  const fileName = safeDisplayName(record.file_name);
  const duration = readCount(record.duration, true);
  const size = readCount(record.file_size, false);
  const mime = normalizeMime(record.mime_type);
  const partial = {
    mime_type: typeof mime === "string" ? mime : null,
    file_name: fileName,
    duration_seconds: typeof duration === "number" ? duration : null,
    file_size: typeof size === "number" ? size : null,
  };
  if (duration === "bad" || size === "bad" || mime === "bad") return blank("bad_file", partial);
  const fileId = record.file_id;
  if (typeof fileId !== "string" || !isTelegramFileId(fileId)) return blank("bad_file", partial);
  const maxDuration = Math.min(options.config.mediaMaxDurationSeconds, ABSOLUTE_MEDIA_MAX_DURATION_SECONDS);
  const maxBytes = Math.min(options.config.mediaMaxBytes, ABSOLUTE_MEDIA_MAX_BYTES);
  if (typeof duration === "number" && duration > maxDuration) return blank("too_long", partial);
  if (typeof size === "number" && size > maxBytes) return blank("too_large", partial);
  if (mime !== null && !AUDIO_MIME.has(mime)) return blank("unsupported_type", partial);
  if (!Number.isFinite(options.expiresAtMs)) return blank("unavailable", partial);
  const grant = copyMediaGrant({
    mediaId: id,
    wakeId: options.wakeId,
    chatId: options.chatId,
    userId: options.userId,
    threadId: options.threadId,
    kind,
    fileId,
    mimeType: mime,
    fileName,
    durationSeconds: typeof duration === "number" ? duration : null,
    fileSize: typeof size === "number" ? size : null,
    expiresAtMs: options.expiresAtMs,
  });
  if (!grant || !options.config.publicBaseUrl) return blank("unavailable", partial);
  return {
    item: {
      id,
      kind,
      mime_type: partial.mime_type,
      file_name: fileName,
      duration_seconds: partial.duration_seconds,
      file_size: partial.file_size,
      available: true,
      unavailable_reason: null,
      download_url: joinUrl(options.config.publicBaseUrl, options.config.pathPrefix, `/media/${id}`),
    },
    grant,
  };
}

function readCount(value: unknown, allowZero: boolean): number | null | "bad" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "bad";
  if (value < 0 || (!allowZero && value === 0)) return "bad";
  return value;
}

function normalizeMime(value: unknown): string | null | "bad" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "bad";
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) return null;
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) || base.length > 80) return "bad";
  return base;
}

function safeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.split(/[/\\]/).pop() ?? "";
  const cleaned = cleanLabel(base, 64);
  if (!cleaned || cleaned.includes("..") || /[/\\]/.test(cleaned)) return null;
  return cleaned;
}

type FetchFailure = "too_large" | "type_rejected" | "unreachable" | "redirect" | "bad_path" | "rejected" | "not_configured" | "empty";

async function downloadTelegramAudio(options: {
  token: string;
  fileId: string;
  declaredMime: string | null;
  maxBytes: number;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; bytes: Uint8Array; mime: string } | { ok: false; reason: FetchFailure }> {
  if (!isTelegramFileId(options.fileId)) return { ok: false, reason: "bad_path" };
  const meta = await telegramGetFile(options.fetchImpl, options.token, options.fileId);
  if (!meta.ok) return meta;
  if (meta.fileSize !== null && meta.fileSize > options.maxBytes) return { ok: false, reason: "too_large" };
  const path = sanitizeTelegramFilePath(meta.filePath);
  const url = path ? telegramFileUrl(options.token, path) : null;
  if (!url) return { ok: false, reason: "bad_path" };
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "redirect" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "rejected" };
  }
  if (!headerAllowsAudio(response.headers.get("content-type"))) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "type_rejected" };
  }
  const body = await readCappedBody(response, options.maxBytes);
  if (!body.ok) return body;
  const sniffed = sniffAudio(body.bytes);
  if (!sniffed) return { ok: false, reason: "type_rejected" };
  if (options.declaredMime && family(options.declaredMime) !== family(sniffed)) {
    return { ok: false, reason: "type_rejected" };
  }
  return { ok: true, bytes: body.bytes, mime: sniffed };
}

async function telegramGetFile(
  fetchImpl: typeof fetch,
  token: string,
  fileId: string,
): Promise<{ ok: true; filePath: string; fileSize: number | null } | { ok: false; reason: FetchFailure }> {
  const url = telegramMethodUrl(token, "getFile");
  if (!url) return { ok: false, reason: "not_configured" };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "redirect" };
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok || !json || typeof json !== "object") {
    const description = json && typeof json === "object" ? String((json as { description?: unknown }).description ?? "") : "";
    await response.body?.cancel().catch(() => undefined);
    if (/too big|too large/i.test(description)) return { ok: false, reason: "too_large" };
    return { ok: false, reason: "rejected" };
  }
  const record = json as { ok?: unknown; result?: unknown; description?: unknown };
  if (record.ok !== true || !record.result || typeof record.result !== "object") {
    const description = typeof record.description === "string" ? record.description : "";
    if (/too big|too large/i.test(description)) return { ok: false, reason: "too_large" };
    return { ok: false, reason: "rejected" };
  }
  const result = record.result as { file_path?: unknown; file_size?: unknown };
  if (typeof result.file_path !== "string") return { ok: false, reason: "bad_path" };
  if (result.file_size === undefined || result.file_size === null) {
    return { ok: true, filePath: result.file_path, fileSize: null };
  }
  if (typeof result.file_size !== "number" || !Number.isSafeInteger(result.file_size) || result.file_size < 1) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: true, filePath: result.file_path, fileSize: result.file_size };
}

/** Pin the download to https://api.telegram.org. Never follow a URL Telegram (or anyone else) supplies. */
function telegramFileUrl(token: string, filePath: string): string | null {
  const safe = sanitizeTelegramFilePath(filePath);
  if (!safe || !telegramMethodUrl(token, "getFile")) return null;
  const url = `https://api.telegram.org/file/bot${token}/${safe}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.telegram.org") return null;
  if (parsed.port !== "" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (!parsed.pathname.endsWith(`/${safe}`)) return null;
  return url;
}

function headerAllowsAudio(header: string | null): boolean {
  if (!header) return true;
  const base = header.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) return true;
  if (base === "application/octet-stream" || base === "binary/octet-stream" || base === "application/ogg") return true;
  return base.startsWith("audio/");
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "empty" | "rejected" }> {
  const declared = response.headers.get("content-length");
  if (declared !== null && declared !== "") {
    if (!/^\d+$/.test(declared)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "rejected" };
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "rejected" };
    }
    if (length === 0) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "empty" };
    }
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
  }
  if (!response.body) return { ok: false, reason: "empty" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let done = false;
    let value: Uint8Array | undefined;
    try {
      const next = await reader.read();
      done = next.done;
      value = next.value;
    } catch {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "rejected" };
    }
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  if (total === 0) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export function sniffAudio(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === "ftyp") return "audio/mp4";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (isAdts(bytes)) return "audio/aac";
  if (isMp3Frame(bytes)) return "audio/mpeg";
  return null;
}

function family(mime: string): string {
  switch (mime) {
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mpeg";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
    case "audio/aac":
      return "mp4";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    default:
      return mime;
  }
}

function isAdts(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff) return false;
  return bytes[1] === 0xf1 || bytes[1] === 0xf9;
}

function isMp3Frame(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff) return false;
  const second = bytes[1] ?? 0;
  if ((second & 0xe0) !== 0xe0) return false;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  return version !== 1 && layer !== 0;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function downloadName(kind: "voice" | "audio", mime: string): string {
  const ext: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
  };
  return `${kind}.${ext[mime] ?? "bin"}`;
}
