import { cleanText } from "./text.js";
import { DEFAULT_WAKE_COMMANDS, TELEGRAM_REACTION_EMOJI } from "./types.js";

export interface Config {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  telegramBotUsername: string;
  telegramBotId: string | null;
  grokWebhookUrl: string;
  grokWebhookSenderKey: string;
  replyTokenSecret: string;
  publicBaseUrl: string;
  pathPrefix: string;
  allowlistUserIds: ReadonlySet<string>;
  allowlistChatIds: ReadonlySet<string>;
  wakeCommands: ReadonlySet<string>;
  replyTokenTtlSeconds: number;
  typingRefreshMs: number;
  /** Initial lease per wake; each interim /send or heartbeat renews it from "now". */
  typingLeaseMs: number;
  /** Hard ceiling per wake, measured from the wake's start. */
  typingMaxMs: number;
  /** Emoji set on the triggering message while the wake runs, or null when disabled. */
  progressReaction: string | null;
  /** Silent line sent when Grok Bot does not accept a wake, or null when disabled. */
  forwardFailureText: string | null;
  /** Phase 3 experiment: sendMessageDraft "Thinking…" placeholder in private chats. */
  draftPlaceholder: boolean;
  contextLimit: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  bridgeAck: boolean;
  fastGreeting: boolean;
  outboundApiKey: string | null;
  maxBodyBytes: number;
  /** Voice and audio bytes served by GET /media. Clamped to the 20 MiB getFile limit. */
  mediaMaxBytes: number;
  /** Voice and audio duration, in seconds, above which no download is offered. */
  mediaMaxDurationSeconds: number;
  dedupeTtlMs: number;
  allowInsecureWebhook: boolean;
  /** Names of settings that were present but rejected. Never contains values. */
  problems: string[];
}

/** Reply-token signing key. Tokens can be brute-forced offline, so require real entropy. */
export const MIN_REPLY_SECRET_LENGTH = 32;
/** Long-lived bearer key for proactive sends. */
export const MIN_OUTBOUND_KEY_LENGTH = 32;
/** Telegram's secret_token: 1-256 chars of A-Z, a-z, 0-9, _ and -. We also require a floor. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

export type EnvSource = Record<string, string | undefined> | {
  [key: string]: unknown;
};

function readString(env: EnvSource, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

function readBool(env: EnvSource, key: string): boolean {
  const value = readString(env, key).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readInt(env: EnvSource, key: string, fallback: number): number {
  const raw = readString(env, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function readBoundedInt(env: EnvSource, key: string, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, readInt(env, key, fallback)));
}

export const DEFAULT_PROGRESS_REACTION = "👀";
export const DEFAULT_FORWARD_FAILURE_TEXT = "Sorry — I couldn't pick that up just now. Mind sending it again?";
/** Default voice/audio download cap. Telegram's getFile limit is 20 MiB; we stay under it. */
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** Official Bot API getFile ceiling. Configuration is never allowed above this. */
export const ABSOLUTE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MEDIA_MAX_DURATION_SECONDS = 5 * 60;
/** Hard ceiling so a mis-set env value cannot request hour-long downloads. */
export const ABSOLUTE_MEDIA_MAX_DURATION_SECONDS = 10 * 60;
const DISABLED_VALUES = new Set(["off", "none", "false", "0", "no", "disabled"]);

export function isAllowedReaction(emoji: string): boolean {
  const bare = emoji.replaceAll("\uFE0F", "");
  return TELEGRAM_REACTION_EMOJI.includes(bare);
}

/** "" means the default, "off" (and friends) disables, anything else must be an allowed emoji. */
export function parseReaction(raw: string, problems: string[]): string | null {
  if (!raw) return DEFAULT_PROGRESS_REACTION;
  if (DISABLED_VALUES.has(raw.toLowerCase())) return null;
  if (isAllowedReaction(raw)) return raw;
  problems.push("PROGRESS_REACTION");
  return DEFAULT_PROGRESS_REACTION;
}

export function parseFailureText(raw: string): string | null {
  if (!raw) return DEFAULT_FORWARD_FAILURE_TEXT;
  if (DISABLED_VALUES.has(raw.toLowerCase())) return null;
  return cleanText(raw, 500).trim() || DEFAULT_FORWARD_FAILURE_TEXT;
}

/** Canonical decimal form of a Telegram id, or null. "042" and "+42" are not ids. */
export function canonicalId(raw: string): string | null {
  const id = raw.trim();
  if (!/^-?(?:0|[1-9]\d*)$/.test(id)) return null;
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value === 0) return null;
  return String(value);
}

export function parseIdList(raw: string, rejected?: string[]): string[] {
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const id = canonicalId(part);
    if (id) ids.push(id);
    else rejected?.push(part.trim());
  }
  return ids;
}

export function isValidWebhookSecret(value: string): boolean {
  return value.length >= MIN_WEBHOOK_SECRET_LENGTH && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * PUBLIC_BASE_URL goes into every wake as reply.send_url, so the assistant will
 * send its bearer token there. Require https (http only for localhost), and no
 * credentials, query, or fragment.
 */
export function normalizePublicBaseUrl(raw: string): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  const httpsOk = url.protocol === "https:";
  const localOk = url.protocol === "http:" && isLocalHost(url.hostname);
  if (!httpsOk && !localOk) return "";
  if (url.username || url.password || url.search || url.hash) return "";
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function parseCommandList(raw: string): string[] {
  const names: string[] = [];
  const source = raw.trim() ? raw : DEFAULT_WAKE_COMMANDS.join(",");
  for (const part of source.split(",")) {
    const name = part.trim().replace(/^\//, "").toLowerCase();
    if (/^[a-z0-9_]{1,32}$/.test(name)) names.push(name);
  }
  return names;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

export function loadConfig(env: EnvSource): Config {
  const username = normalizeUsername(readString(env, "TELEGRAM_BOT_USERNAME"));
  const botId = readString(env, "TELEGRAM_BOT_ID");
  const outbound = readString(env, "OUTBOUND_API_KEY");
  const prefixRaw = readString(env, "PATH_PREFIX");
  let pathPrefix = "";
  if (prefixRaw && prefixRaw !== "/") {
    pathPrefix = prefixRaw.startsWith("/") ? prefixRaw : `/${prefixRaw}`;
    pathPrefix = pathPrefix.replace(/\/+$/, "");
  }
  const problems: string[] = [];
  const webhookSecret = readString(env, "TELEGRAM_WEBHOOK_SECRET");
  if (webhookSecret && !isValidWebhookSecret(webhookSecret)) problems.push("TELEGRAM_WEBHOOK_SECRET");
  const replySecret = readString(env, "REPLY_TOKEN_SECRET");
  if (replySecret && replySecret.length < MIN_REPLY_SECRET_LENGTH) problems.push("REPLY_TOKEN_SECRET");
  if (outbound && outbound.length < MIN_OUTBOUND_KEY_LENGTH) problems.push("OUTBOUND_API_KEY");
  const baseRaw = readString(env, "PUBLIC_BASE_URL");
  const publicBaseUrl = normalizePublicBaseUrl(baseRaw);
  if (baseRaw && !publicBaseUrl) problems.push("PUBLIC_BASE_URL");
  const rejectedUsers: string[] = [];
  const rejectedChats: string[] = [];
  const allowlistUserIds = new Set(parseIdList(readString(env, "ALLOWLIST_USER_IDS"), rejectedUsers));
  const allowlistChatIds = new Set(parseIdList(readString(env, "ALLOWLIST_CHAT_IDS"), rejectedChats));
  if (rejectedUsers.length > 0) problems.push("ALLOWLIST_USER_IDS");
  if (rejectedChats.length > 0) problems.push("ALLOWLIST_CHAT_IDS");
  const grokWebhookUrl = readString(env, "GROK_WEBHOOK_URL");
  const allowInsecureWebhook = readBool(env, "ALLOW_INSECURE_WEBHOOK");
  if (grokWebhookUrl && !isUsableGrokUrl(grokWebhookUrl, allowInsecureWebhook)) problems.push("GROK_WEBHOOK_URL");
  // Typing lasts "5 seconds or less", so refresh well inside that.
  const typingRefreshMs = readBoundedInt(env, "TYPING_REFRESH_MS", 3000, 1000, 4500);
  const typingMaxMs = readBoundedInt(env, "TYPING_MAX_MS", 1_800_000, 60_000, 7_200_000);
  const typingLeaseMs = Math.min(typingMaxMs, readBoundedInt(env, "TYPING_LEASE_MS", 600_000, 60_000, 3_600_000));
  const progressReaction = parseReaction(readString(env, "PROGRESS_REACTION"), problems);
  return {
    telegramBotToken: readString(env, "TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: isValidWebhookSecret(webhookSecret) ? webhookSecret : "",
    telegramBotUsername: /^[A-Za-z0-9_]{1,32}$/.test(username) ? username : "",
    telegramBotId: /^\d+$/.test(botId) ? botId : null,
    grokWebhookUrl,
    grokWebhookSenderKey: readString(env, "GROK_WEBHOOK_SENDER_KEY"),
    replyTokenSecret: replySecret.length >= MIN_REPLY_SECRET_LENGTH ? replySecret : "",
    publicBaseUrl,
    pathPrefix,
    allowlistUserIds,
    allowlistChatIds,
    wakeCommands: new Set(parseCommandList(readString(env, "WAKE_COMMANDS"))),
    replyTokenTtlSeconds: readBoundedInt(env, "REPLY_TOKEN_TTL_SECONDS", 1800, 60, 3600),
    typingRefreshMs,
    typingLeaseMs,
    typingMaxMs,
    progressReaction,
    forwardFailureText: parseFailureText(readString(env, "FORWARD_FAILURE_TEXT")),
    draftPlaceholder: readBool(env, "TELEGRAM_DRAFT_PLACEHOLDER"),
    contextLimit: Math.max(1, readInt(env, "CONTEXT_LIMIT", 10)),
    rateLimitMax: Math.max(1, readInt(env, "RATE_LIMIT_MAX", 20)),
    rateLimitWindowMs: Math.max(1000, readInt(env, "RATE_LIMIT_WINDOW_MS", 60_000)),
    bridgeAck: readBool(env, "BRIDGE_ACK"),
    fastGreeting: readBool(env, "FAST_GREETING"),
    outboundApiKey: outbound.length >= MIN_OUTBOUND_KEY_LENGTH ? outbound : null,
    maxBodyBytes: Math.max(1024, readInt(env, "MAX_BODY_BYTES", 1_000_000)),
    mediaMaxBytes: readBoundedInt(env, "MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES, 1024, ABSOLUTE_MEDIA_MAX_BYTES),
    mediaMaxDurationSeconds: readBoundedInt(
      env,
      "MEDIA_MAX_DURATION_SECONDS",
      DEFAULT_MEDIA_MAX_DURATION_SECONDS,
      1,
      ABSOLUTE_MEDIA_MAX_DURATION_SECONDS,
    ),
    dedupeTtlMs: Math.max(1000, readInt(env, "DEDUPE_TTL_MS", 86_400_000)),
    allowInsecureWebhook,
    problems,
  };
}

/**
 * Settings without which a long-running process should refuse to start: no
 * webhook secret means no authentication, and without a reply secret or public
 * base URL every wake would be dropped.
 */
export function fatalConfigProblems(config: Config): string[] {
  const fatal: string[] = [];
  if (!config.telegramWebhookSecret) fatal.push("TELEGRAM_WEBHOOK_SECRET");
  if (!config.replyTokenSecret) fatal.push("REPLY_TOKEN_SECRET");
  if (!config.publicBaseUrl) fatal.push("PUBLIC_BASE_URL");
  return fatal;
}

export function isUsableGrokUrl(raw: string, allowInsecure: boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === "https:" || (allowInsecure && url.protocol === "http:");
}

export interface ConfigStatus {
  telegram_bot_token: boolean;
  telegram_webhook_secret: boolean;
  bot_username: boolean;
  grok_webhook_url: boolean;
  grok_webhook_sender_key: boolean;
  reply_token_secret: boolean;
  public_base_url: boolean;
  allowlist: boolean;
}

export function configStatus(config: Config): ConfigStatus {
  return {
    telegram_bot_token: isPlausibleBotToken(config.telegramBotToken),
    telegram_webhook_secret: config.telegramWebhookSecret.length > 0,
    bot_username: config.telegramBotUsername.length > 0,
    grok_webhook_url: isUsableGrokUrl(config.grokWebhookUrl, config.allowInsecureWebhook),
    grok_webhook_sender_key: config.grokWebhookSenderKey.length > 0,
    reply_token_secret: config.replyTokenSecret.length > 0,
    public_base_url: config.publicBaseUrl.length > 0,
    allowlist: config.allowlistUserIds.size > 0 || config.allowlistChatIds.size > 0,
  };
}

export function isPlausibleBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(token);
}
