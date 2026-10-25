# Kiki Voice

Generate playable speech in Kiki, optionally send it to connected chats, and send the original audio again without another generation. Voice uses **Kiki Media** for every TTS request; sources, credentials, generation tasks and files stay in Media.

## Set up speech

Use a Host with the public plugin Media and messages APIs. Install and enable `kiki-media` and `kiki-voice`. Configure a speech source in Media settings, then call `plugin__kiki_voice__voice`:

```json
{ "action": "providers" }
```

Use a returned provider id with `action: "voices"` to list actual voice ids:

```json
{ "action": "voices", "provider": "kiki-media/minimax-speech", "language": "zh" }
```

Voice settings remember a source, voice, model and language. Tool arguments override those defaults. An empty model uses the source's configured model. If several speech sources are enabled, select one with `provider` or the Voice setting; Voice does not guess.

## Generate and play

Call `plugin__kiki_voice__speak` with a stable `request_id`, the full `text`, and a discovered `voice` id. Set `provider` unless a Voice default or a single enabled source resolves it:

```json
{
  "request_id": "greeting-1",
  "text": "Hello. Your report is ready.",
  "provider": "kiki-media/minimax-speech",
  "voice": "<discovered voice id>"
}
```

The result contains Kiki's existing `media_generation` job. Its completed original audio has a canonical `file_id` and uses Kiki's existing playback and download controls. Omitting `delivery` generates audio without sending a chat message.

## Generate and send

Add `delivery` to the same `speak` call. Its `request_id` identifies the message send, separately from the speech generation:

```json
{
  "request_id": "greeting-1",
  "text": "Hello. Your report is ready.",
  "provider": "kiki-media/minimax-speech",
  "voice": "<discovered voice id>",
  "delivery": {
    "request_id": "greeting-send-1",
    "channel": "<bound output channel id>",
    "kind": "voice"
  }
}
```

`channel` selects one output; `channels` selects several. Omitting both uses the Host's enabled outputs bound to the current thread. `to` and `reply_to` use the same routing as Host messages. The optional `delivery.text` is one complete caption, including any line breaks. Voice sends one message with the original audio `file_id`, not one message per line. Use `kind: "audio"` for an ordinary audio attachment instead of a voice message.

A succeeded generation with one complete original audio file is sent immediately. If the job has several originals, select one with `delivery.file_id`. A running or pending generation returns `delivery.status: "awaiting_generation"` with its delivery id; inspect the job, then send it after completion. Failed, unknown, stopped or partial generation results keep their Media state and are not sent automatically.

The returned `delivery` is the Host's receipt, including each channel's delivery, unsupported media, failure, partial or unknown outcome. A pending receipt remains pending; cancelled and not-sent batch items remain unsent. If the send's response is lost, Voice keeps the generated job and returns an unknown delivery with the message `request_id`. Inspect the destination before deciding whether to send again; Voice never automatically retries an unknown outcome or downgrades a voice message to a file.

## Inspect, resume or send existing audio

Call `plugin__kiki_voice__voice` to inspect a job:

```json
{ "action": "get", "job_id": "<returned job_id>" }
```

`get` is read-only. If the job reports `can_resume: true`, `resume` continues the accepted provider handle or download without another generation. `cancel` preserves the provider's cancellation and billing status, including unsupported remote cancellation. These actions do not send messages.

To send a succeeded job's original audio without generating again:

```json
{
  "action": "send",
  "job_id": "<returned job_id>",
  "delivery": {
    "request_id": "greeting-send-1",
    "channel": "<bound output channel id>",
    "kind": "voice"
  }
}
```

Use the same generation `request_id` only for the same speech request, and the same delivery `request_id` only for the same file, caption and destination. Host Media and messages own deduplication. To deliberately send the existing audio again, use `voice send` with a new delivery id. Voice accepts only a complete original audio `file_id` belonging to that Media job; it does not open a home path or create another IM connection.

## Development

```bash
node plugins/official/kiki-voice/scripts/sync-manifest.mjs --check
node --test plugins/official/kiki-voice/test/voice.test.mjs
```

Tests use explicit Media and message fixtures, including Host-owned deduplication, and make no provider purchases or chat sends. Set `KIKI_HOST_RUNNER` to the supported Host runner entry to include JSON-RPC integration tests. Without it, the three runner tests are skipped.
