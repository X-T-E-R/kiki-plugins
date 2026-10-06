# Kiki Media

Install one media plugin, then choose sources inside Media. OpenAI, Google, Ark, xAI, MiniMax, StepFun, Novita, Agnes, NewAPI and ComfyUI adapters are included; vendor packages are not required.

## Configure a source

Install and enable `kiki-media`, open its Media view, and configure the service you want to use. Each source has its own endpoint, key and optional Kiki connection. Image, video and speech defaults are independent. Selecting an existing connection reuses its endpoint and authentication; OAuth refresh stays in Kiki. A text subscription or OAuth login does not by itself grant media API access. Cloud generation can incur charges.

Disabling or removing one source leaves other sources, saved configuration and completed files alone. Restore the source with the same endpoint and credentials to continue a compatible saved handle. Resume polls or downloads an accepted job; it does not purchase another generation. A lost submission without a handle is reported as unknown rather than retried.

On upgrade, installed legacy vendor packages remain installed. Their settings and keys are read as defaults for the matching built-in source until you override or clear a field. New generation uses the built-in adapter; existing jobs keep their original package, configuration and handle. Keep the original package enabled while those jobs need it. No user configuration or OAuth refresh token is copied or deleted.

## Add your own script

A custom source runs a local command with an argument array, optional working directory and environment variables. It runs under your user account after the plugin's installation trust decision, not in a sandbox. Install the command's own runtime and dependencies as you normally would; the script can read external files and environment variables and can run independently of Kiki.

Use **file output** for an ordinary command that writes one image, video or speech file. In arguments, `{output}` becomes the output filename, `{prompt}` the image/video prompt and `{text}` the speech text. For example, a script already usable as `node speech.mjs "Hello" out.mp3` can be configured as command `node` and arguments `["/path/to/speech.mjs", "{text}", "{output}"]`. Configure the resulting file extension and MIME if they differ from PNG, MP4 or MP3.

Use **JSON bridge** when the command needs asynchronous handles, polling, cancellation, multiple files or subtitles. Arguments may use `{action}`, `{input}`, `{output}`, `{result}` and `{job_id}`. The command receives an input JSON file containing `action`, `input`, `output`, `resultFile` and `jobId`, and writes its result to `resultFile`. These paths are also available as `KIKI_MEDIA_INPUT`, `KIKI_MEDIA_OUTPUT`, `KIKI_MEDIA_RESULT` and `KIKI_MEDIA_ACTION` environment variables. The bridge wraps your command; it does not require importing a Kiki API.

For submit or poll, write a media outcome such as:

```json
{"state":"complete","artifacts":[{"path":"OUTPUT_PATH","name":"speech.mp3","mime":"audio/mpeg","kind":"audio","role":"original","complete":true}]}
```

An accepted asynchronous operation returns `{"state":"pending","phase":"generation","handle":{"version":1,"data":{"id":"REMOTE_ID"}}}`. Later `poll` receives that handle as `input` and must not create a new paid job. Files must be written under the supplied output directory so Kiki can publish original `file_id` artifacts. `cancel` returns a remote cancellation result; unsupported cancellation never promises a refund. Environment values are not returned by source inspection.

## Generate and retrieve files

`generate` accepts image, video or TTS requests. `media` discovers models and voices on demand and gets, stops or resumes jobs. Both use the existing session-owned Task, notification and artifact path. TTS returns a finite audio file, including streamed HTTP/SSE responses saved to disk; playback and download use the original artifact. Bidirectional live voice sessions are not included.

ComfyUI uses your running endpoint, workflows and installed models; this plugin does not bundle an engine, GPU runtime or model files. Novita, Agnes and NewAPI remain explicit compatible endpoint profiles, not promises that every vendor endpoint implements the same protocol.
