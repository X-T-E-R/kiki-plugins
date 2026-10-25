# Kiki Voice

Generate playable speech in Kiki and reuse the original audio in connected chats. Voice uses **Kiki Media** for every TTS request; provider connections, credentials, generation tasks and files stay in Media.

## Set up speech

Install and enable `kiki-media` and `kiki-voice` for the session. Configure a speech source in Media settings, then use `plugin__kiki_voice__voice` to discover it:

```json
{ "action": "providers" }
```

Use the returned provider id with `action: "voices"` to list actual voice ids. Voice settings can remember a source, voice, model and language; individual tool arguments override them. An empty model uses the source's configured model. With several enabled speech sources, choose one explicitly rather than having Voice guess.

## Generate and play

Call `plugin__kiki_voice__speak` with `request_id`, `text`, and a discovered `voice` id. Set `provider` unless a Voice default or a single enabled source resolves it.

The result is Kiki's existing `media_generation` job. Completed original audio artifacts carry a canonical `file_id`; Kiki displays them with its media player and download controls. A pending job carries its `task_id` and `job_id`, not a finished file.

To inspect a job:

```json
{ "action": "get", "job_id": "<returned job_id>" }
```

Use `resume` only when the job reports `can_resume: true`. It continues the accepted provider handle or download. Keep the same `request_id` for the same speech request; an unknown submission is inspected rather than submitted again. `cancel` preserves the provider's cancellation status, including a provider that only stops the local wait.

## Send the original audio

Use the completed original audio's `file_id` with `SendMessage`, selecting the intended bound output channels and `attachments[].kind: "voice"`. Channel receipts report delivery, unsupported media, failure or an unknown outcome. A voice request is not silently downgraded to a file. A generated file is not itself evidence that a chat received it.

Voice's direct generate-and-send action and enforced manifest dependency are being connected to the Host's public plugin channel contract. The current source supports generation, playback results and explicit follow-up through `SendMessage`; it does not register a second IM listener.

## Development

```bash
node plugins/official/kiki-voice/scripts/sync-manifest.mjs --check
node --test plugins/official/kiki-voice/test/voice.test.mjs
```

Set `KIKI_HOST_RUNNER` to the Host's `hostRunner.mjs` to include the real JSON-RPC runner test. Tests use fixture media responses and make no provider purchases or chat sends.
