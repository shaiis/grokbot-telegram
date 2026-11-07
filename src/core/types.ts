export const SCHEMA_VERSION = 2 as const;

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export const TELEGRAM_TEXT_LIMIT = 4096;

export const DEFAULT_WAKE_COMMANDS = ["ask", "help"] as const;

/**
 * ReactionTypeEmoji values the Bot API reference allows. Compared without
 * U+FE0F, because the reference does not show variation selectors.
 */
export const TELEGRAM_REACTION_EMOJI: readonly string[] = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
];

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  message_thread_id?: number;
  is_topic_message?: boolean;
  is_automatic_forward?: boolean;
  sender_chat?: TelegramChat;
  reply_to_message?: TelegramMessage;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  photo?: unknown[];
  sticker?: unknown;
  video?: unknown;
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  animation?: unknown;
  video_note?: unknown;
  contact?: unknown;
  location?: unknown;
  poll?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface PublicUser {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_bot: boolean;
}

export interface ContextMessage {
  message_id: number;
  text: string;
  date: number | null;
  message_thread_id: number | null;
  from: PublicUser | null;
}

export interface ReplyTo {
  message_id: number;
  text: string;
  from: PublicUser | null;
}

/** Why a voice or audio item has no download. Safe to show to the routine. */
export type MediaUnavailableReason = "too_large" | "too_long" | "unsupported_type" | "bad_file" | "unavailable";

/**
 * Voice or audio the routine may download from this bridge.
 * No Telegram file id and no Telegram file URL.
 */
export interface MediaItem {
  id: string;
  kind: "voice" | "audio";
  mime_type: string | null;
  file_name: string | null;
  duration_seconds: number | null;
  file_size: number | null;
  available: boolean;
  unavailable_reason: MediaUnavailableReason | null;
  download_url: string | null;
}

export interface WakeReply {
  token: string;
  expires_at: string;
  wake_id: string;
  send_url: string;
  typing_stop_url: string;
  heartbeat_url: string;
  chat_id: string;
  message_thread_id: number | null;
}

export interface WakeEvent {
  schema_version: typeof SCHEMA_VERSION;
  untrusted_content_notice: string;
  idempotency_key: string;
  update_id: number;
  timestamp: string;
  edited: boolean;
  addressed_how: "private" | "mention" | "command" | "reply";
  command: string | null;
  chat: {
    id: string;
    type: string;
    title: string | null;
    username: string | null;
  };
  from: PublicUser | null;
  message: {
    message_id: number;
    text: string;
    date: number | null;
    message_thread_id: number | null;
    media: string[];
    /** Present only when the message has a voice or audio file. Text wakes omit it. */
    media_items?: MediaItem[];
    reply_to: ReplyTo | null;
  };
  short_term: ContextMessage[];
  reply: WakeReply;
}

/** One wake inside a chat (and forum topic). Typing runs while a scope has any wake. */
export interface TypingWake {
  wakeId: string;
  /** The Telegram message that triggered the wake; the reaction target. */
  messageId: number | null;
  /** Emoji this wake set on `messageId` and must clear, or null when it owns no reaction. */
  reaction: string | null;
  /** Phase 3: keep a sendMessageDraft placeholder up (private chats only). */
  draft: boolean;
  draftAt: number | null;
  startedAt: number;
  leaseMs: number;
  leaseUntil: number;
  /** Hard ceiling: the lease is never extended past this. */
  deadline: number;
}

export interface TypingScope {
  scopeKey: string;
  chatId: string;
  threadId: number | null;
  refreshMs: number;
  wakes: Record<string, TypingWake>;
}

export interface TypingStart {
  scopeKey: string;
  chatId: string;
  threadId: number | null;
  refreshMs: number;
  wakeId: string;
  messageId: number | null;
  /** Emoji to set on `messageId`, or null for none. */
  reaction: string | null;
  draft: boolean;
  startedAt: number;
  leaseMs: number;
  deadline: number;
}

export interface ReplyClaims {
  v: 1;
  chat_id: string;
  thread_id: number | null;
  wake_id: string;
  exp: number;
}

export type AddressHow = WakeEvent["addressed_how"];

export interface AddressResult {
  addressed: boolean;
  how: AddressHow | null;
  command: string | null;
}
