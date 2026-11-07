# Voice and audio

A text wake is unchanged. A private voice or audio message, or a group voice or audio message sent as a reply to the bot, adds optional `message.media_items`. The routine downloads the original bytes from this bridge. The bridge calls Telegram `getFile` and the file URL itself. The wake does not contain the bot token, the Telegram `file_id`, or a `api.telegram.org/file/...` URL.

Production origin for this fork: `https://grokbot-telegram.shai-israel.workers.dev`. Bot username: `izraelis_bot`.

Download before `"final": true`. A final reply deletes the grant. The reply token's expiry does too. Default limits are 10 MiB and 5 minutes. Configuration cannot raise the size above Telegram's 20 MiB `getFile` limit, or the duration above 10 minutes.

## Wake excerpt

Values below are shape only. Copy `download_url`, `reply.token`, `reply.chat_id`, and `message.message_id` from the live wake. Do not invent them.

```json
{
  "schema_version": 2,
  "message": {
    "message_id": 1001,
    "text": "",
    "message_thread_id": null,
    "media": ["voice"],
    "media_items": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "kind": "voice",
        "mime_type": "audio/ogg",
        "file_name": null,
        "duration_seconds": 16,
        "file_size": 48000,
        "available": true,
        "unavailable_reason": null,
        "download_url": "https://grokbot-telegram.shai-israel.workers.dev/media/11111111-1111-4111-8111-111111111111"
      }
    ]
  },
  "reply": {
    "token": "<reply.token from this wake>",
    "expires_at": "<ISO-8601 from this wake>",
    "wake_id": "<reply.wake_id from this wake>",
    "send_url": "https://grokbot-telegram.shai-israel.workers.dev/send",
    "typing_stop_url": "https://grokbot-telegram.shai-israel.workers.dev/typing/stop",
    "heartbeat_url": "https://grokbot-telegram.shai-israel.workers.dev/typing/heartbeat",
    "chat_id": "<reply.chat_id from this wake>",
    "message_thread_id": null
  }
}
```

`available: false` has `download_url: null` and `unavailable_reason` of `too_large`, `too_long`, `unsupported_type`, `bad_file`, or `unavailable`. Do not guess a URL.

## Fetch, transcribe, delete

Run this on the bot computer, which has the offline Hebrew speech-to-text runner. Do this before the final Telegram reply. Refuse the download unless the URL's origin is exactly `https://grokbot-telegram.shai-israel.workers.dev`.

```bash
DOWNLOAD_URL="<message.media_items[0].download_url>"
REPLY_TOKEN="<reply.token>"
# Both values come from the wake. Do not write them into the repo, a log, or the chat.

case "$DOWNLOAD_URL" in
  https://grokbot-telegram.shai-israel.workers.dev/media/*) ;;
  *) echo "refusing download url" >&2; exit 1 ;;
esac

rm -f /tmp/telegram-voice.ogg /tmp/telegram-voice.headers
curl --fail-with-body -sS \
  -H "Authorization: Bearer ${REPLY_TOKEN}" \
  -D /tmp/telegram-voice.headers \
  -o /tmp/telegram-voice.ogg \
  "$DOWNLOAD_URL"

# Headers must show HTTP 200, a content-type starting with audio/, and cache-control: no-store.
# The body is the original audio, not JSON.

/workspace/telegram-voice-test/run.sh /tmp/telegram-voice.ogg
# One JSON line: {ok:true, model, language:"he", audio_seconds, load_seconds, transcribe_seconds, text}
# The runner deletes its converted WAV. Then delete the source:

rm -f /tmp/telegram-voice.ogg /tmp/telegram-voice.headers
unset REPLY_TOKEN DOWNLOAD_URL
```

Send the transcript back with `"final": true` only after that cleanup. A progress line, if you need one, uses `"final": false` and does not retire the download.

```json
{
  "chat_id": "<reply.chat_id>",
  "text": "<the transcript or the answer>",
  "message_thread_id": null,
  "reply_to_message_id": 1001,
  "final": true
}
```

`POST` that JSON to `reply.send_url` with `Authorization: Bearer <reply.token>`. Include `message_thread_id` only when `reply.message_thread_id` is a number, and use that same number.

## Download errors

| Status | Error | Meaning |
| --- | --- | --- |
| 200 | audio body | The bytes. `content-type` is the sniffed audio type. `cache-control` is `no-store`. |
| 401 | `unauthorized`, `malformed`, `bad_signature`, `expired` | The bearer is missing, damaged, or past `reply.expires_at`. |
| 401 | `wake_closed` | This wake already had a final reply. |
| 403 | `scope` | The token's topic does not own this file. |
| 403 | `not_allowlisted` | The sender or chat is no longer allowlisted. |
| 404 | `media_not_found` | Unknown id, another chat, another wake, or the grant expired. |
| 404 | `not_found` | The request host is not `PUBLIC_BASE_URL`. |
| 413 | `media_too_large` | Telegram reported, or the stream exceeded, the size cap. `reason` is `too_large`. |
| 415 | `media_type_rejected` | The response type or the bytes were refused. `reason` is `mime_rejected` or `magic_rejected`. |
| 502 | `media_fetch_failed` | Telegram could not be used. `reason` says which step failed. The body has no token, file id, file path, or upstream URL. |
| 405 | `method_not_allowed` | Only `GET` downloads. |

An outbound API key cannot download media. The bearer is the wake's reply token.

`reason` is also written as one JSON log line (`event` `media_download_failed`) with the chat, wake, and bridge media id. It never includes the bot token, the Telegram file URL, or the Telegram `file_id`.

| `reason` | Meaning |
| --- | --- |
| `too_large` | Declared size or the stream is over the cap. |
| `mime_rejected` | The download `content-type` is not audio, `application/ogg`, or `application/octet-stream`. |
| `magic_rejected` | The bytes are not a known audio file, or they disagree with the voice `mime_type`. |
| `getfile_http_<status>` | `getFile` returned that HTTP status. `<status>` is three digits. |
| `download_http_<status>` | The file download returned that HTTP status. |
| `getfile_redirect`, `download_redirect` | Telegram answered with a redirect. It is not followed. |
| `getfile_unreachable`, `download_unreachable` | The fetch threw, and the error was not one of the known workerd cases below. |
| `getfile_reset`, `download_reset` | Workerd reported `Network connection lost.` The file download is tried once more. |
| `getfile_timeout`, `download_timeout` | The fetch hit its timeout. The file download is tried once more. |
| `getfile_bad_content_length`, `download_bad_content_length` | Workerd rejected the response `Content-Length` (including a repeated value). Not retried. |
| `getfile_bad_response` | `getFile` returned 2xx without a File object. |
| `getfile_bad_size` | `file_size` was present and not a positive integer. |
| `bad_path` | `file_path` was not a relative Telegram path. |
| `bad_file_id` | The stored `file_id` failed the same check used when the grant was saved. |
| `empty` | The download body was empty. |
| `download_bad_length` | `content-length` was not a plain integer. |
| `download_stream_error` | The body stream failed while it was read. |
| `not_configured` | The bot token is missing or not a Telegram token. |

`application/octet-stream` with a body that starts `OggS`, including a `voice/file_N.oga` path and a missing `content-length`, is a successful voice download. A non-2xx JSON body from Telegram stays a `getfile_http_<status>` or `download_http_<status>` failure and is not sniffed as audio.

## Deploy and roll back

Do not deploy until the parent has reviewed this change. Deploying uploads the Worker script only. It does not rotate secrets, and this branch does not change Durable Object classes or migrations (`wrangler.toml` stays on tag `v1`). Do not edit that migration, the `ChatSession` class name, or the `CHAT_SESSION` binding. Do not run `wrangler delete`, `wrangler secret delete`, or `wrangler deploy --secrets-file`.

`wrangler.toml` sets `keep_vars = true`. Wrangler otherwise deletes plain-text variables that exist only in the Cloudflare dashboard, including `ALLOWLIST_CHAT_IDS`, `PUBLIC_BASE_URL`, `TELEGRAM_BOT_USERNAME`, and `GROK_WEBHOOK_URL`. Secrets survive a deploy either way. Keep those values in the dashboard (or in the host's secret store). Do not commit them. A deploy with `keep_vars` does not put back variables that an earlier deploy already removed; set those again in the dashboard if `/healthz` or the allowlist shows them missing.

From a checkout of the reviewed revision, with Wrangler already logged in as the account that owns the Worker:

```bash
npx wrangler deploy
```

Existing Worker secrets and the SQLite Durable Object data stay in place. `PUBLIC_BASE_URL` remains `https://grokbot-telegram.shai-israel.workers.dev`. No new secret is required. `MEDIA_MAX_BYTES` and `MEDIA_MAX_DURATION_SECONDS` are optional.

Roll back the script without touching secrets, bindings, or stored chat state:

```bash
npx wrangler rollback
```

After a rollback, new wakes no longer include `media_items`. `/send` and typing keep working.

## What was verified here

Verified with Vitest and with workerd (Miniflare, compatibility date 2026-01-15): text wakes unchanged, a voice wake's download contract, a realistic voice response (`voice/file_N.oga`, `application/octet-stream`, body starting `OggS`), Durable Object grant storage, one final send, grant close, a fetch function that rejects a wrong `this` value, a reset on the first file connection, and a repeated `Content-Length`. A fake-token `getFile` through workerd to `api.telegram.org` returns `getfile_http_401`. The Hebrew transcription runner was not run here.

Not done from this environment: no request to the production Worker, no live Telegram voice note, no call to `/workspace/telegram-voice-test/run.sh` (that runner is on the bot computer and is not in this VM).
