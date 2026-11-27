# Kiki Plugins

Independently versioned plugins for [Kiki](https://github.com/X-T-E-R/kiki).

**[Browse the catalog](https://x-t-e-r.github.io/kiki-plugins/)** · **[Catalog JSON](https://x-t-e-r.github.io/kiki-plugins/marketplace.json)** · **[Versioned packages](https://github.com/X-T-E-R/kiki-plugins/releases)**

## Install a plugin

Use a Kiki Host with checksum-pinned catalog installation support. If your build still opens an older catalog, set `KIKI_PLUGIN_MARKETPLACE_URL=https://x-t-e-r.github.io/kiki-plugins/marketplace.json` when starting Kiki. Open the plugin market, choose a package, and review the installation preview. Enable it after checking its contributions and requested permissions. Each first-party entry points to a versioned Release ZIP and its SHA-256 digest; old packages stay available.

Voice needs a Kiki Host with plugin dependencies and the Media and messages APIs. Each package declares its engine compatibility in `x-kiki.engines.kiki`.

| Package | What you need to use it |
| --- | --- |
| Computer Control (`kiki-cua`) | Local multi-DPI desktop control (`win32`, macOS, Linux) and cross-plugin `kiki.cua.provider.v1` remote display/input bus with live preview and human-takeover guard; zero native compilation. See [Computer Control](plugins/official/kiki-cua/README.md). |
| UU Remote / PVE / VNC (`kiki-uu-remote`) | NetEase UU Remote (`GameViewer` + `uuyc-cli`) for `uu:` targets, passwordless `ssh` + `qm`/`python3` for Proxmox VE `pve:` VMs (RFB 3.8 primary with QMP/QGA fallback), or a reachable VNC server for `vnc:` targets; bridges into `kiki-cua`. See [UU Remote](plugins/official/kiki-uu-remote/README.md). |
| Encrypted Relay (`kiki-relay`) | Self-hosted Node.js 24+ or Docker WebSocket rendezvous server for reaching Kiki spaces without a public IP; inner traffic stays end-to-end TLS 1.3 pinned to the space's P-256 SPKI fingerprint. See [Encrypted Relay](plugins/official/kiki-relay/README.md). |
| Phone (`kiki-phone`) | Prepare the runtime, then operate a connected phone with semantic Mobilewright scripts or Mobile MCP. Needs Node.js 22.12+ with npm; Android uses official platform-tools and USB or wireless debugging; iOS needs a signed upstream device agent. See [Phone setup](plugins/official/kiki-phone/README.md). |
| Cloudflare Tunnel (`kiki-cloudflare`) | Existing Cloudflare Tunnel token, local tunnel config + UUID, or `cloudflared` browser login; downloads a SHA-256-verified `cloudflared` binary into Kiki's plugin data directory on demand. See [Cloudflare Tunnel](plugins/official/kiki-cloudflare/README.md). |
| Bilibili (`kiki-bilibili`) | Isolated Python 3.10+ environment with `bili-agent==1.0.0` (plus FFmpeg for real frames and `sherpa-onnx` for local ASR); supports multi-profile isolation and creator operations. See [Bilibili setup](plugins/official/kiki-bilibili/README.md). |
| Task Board (`kiki-task-board`) | No external service; adds persistent workspace requirement cards and a workspace panel (requires plugin protocol `0.4.1+`). See [Task Board](plugins/official/kiki-task-board/README.md). |
| Output Layer (`kiki-output-layer`) | Uses a configured Kiki model or connection to stream translations and plain-language rewrites without modifying the original conversation. |
| Sites (`kiki-sites`) | Existing code-hosting login/token (`gh`, `glab`, Gitea, Forgejo, Gitee, Bitbucket) or deployment CLI/token (Vercel, Netlify, Cloudflare Pages/Workers, Railway, Fly.io, Render); provider quotas and billing apply. See [Sites](plugins/official/kiki-sites/README.md). |
| Voice (`kiki-voice`) | Requires `kiki-media` (`^0.2.1`) with an enabled speech source plus Host messages APIs to generate playable audio and send originals to connected chats. See [Voice](plugins/official/kiki-voice/README.md). |
| Media (`kiki-media`) | Grouped media plugin covering OpenAI, Google, Ark, xAI, MiniMax, StepFun, Novita, Agnes, NewAPI, ComfyUI, and local scripts; configure an entitled API connection or local ComfyUI endpoint (cloud generation may incur charges). |
| Extract (`kiki-extract`) | Text and HTML work locally. PDF and Office conversion need Python and MarkItDown; MinerU OCR upload is explicit and opt-in. See [Extract setup](plugins/official/kiki-extract/README.md). |
| Office (`kiki-office`) | OfficeCLI **1.0.152**, installed with consent; Windows x64, macOS arm64, and Linux x64 are supported by its pinned binary resolver. |
| Work (`kiki-work`) | No external service or network; read-only local CSV/TSV key audit and two-table reconciliation. |
| Writing (`kiki-writing`) | No external service; contributes a manuscript panel and draft command. |
| Notion (`kiki-notion`) | Notion's HTTP MCP service and its OAuth authorization. See [Notion](plugins/official/kiki-notion/README.md). |
| Everything Search (`kiki-everything`) | Windows with the Everything 1.5 index running and voidtools `es.exe` (`>=1.1.0.37`) installed. |
| QQ (`kiki-qq`) | An official QQ Bot account or a OneBot 11 endpoint. |
| Mail (`kiki-mail`) | An IMAP/SMTP account for direct mail or an Open Archiver URL and read-only key for archives. |
| Desktop Pet (`kiki-pet`) | Local desktop companion that reacts to Kiki tasks and imports local or public Codex pet packs (`GPL-3.0-or-later`). |

The two Moonshot entries are **author-hosted references**, not mirrored source in this repository. Their original license and external daemon/service requirements apply. The three community entries keep pinned author commits; their Claude-plugin import compatibility is marked unverified, so inspect Kiki's unsupported-contribution diagnostics before enabling them.

## Build and test locally

Use Node **24.22.1**, also used by CI. Dependencies and the SDK tarball are locked. For the local integration candidate, keep a matching Kiki checkout beside this repository and select its runner:

```sh
npm ci --ignore-scripts
KIKI_HOST_RUNNER=../kiki/packages/agent-core-v2/src/app/plugin/hostRunner.mjs npm run check
npm test
npm run build
npm run dev
```

`check` validates catalog-listed local packages and non-marketplace packages under `plugins/`, including exact manifest/entry registration, manifest synchronization and routed fixtures. To select one package, use `npm run check -- kiki-phone` with the same `KIKI_HOST_RUNNER`; unknown IDs fail. `npm run check -- catalog` validates only catalog metadata for CI's metadata-only route.

The runner must match the checksum in `sdk.lock.json`. Without `KIKI_HOST_RUNNER`, `check` downloads it from the fixed Kiki commit; that commit must be available on GitHub first. Checks use temporary fixtures without Kiki-home access or paid API credentials.

With a Kiki checkout and its dependencies installed beside this repository, run the real Host installation test against the public catalog:

```sh
KIKI_HOST_REPO=../kiki KIKI_CATALOG_URL=https://x-t-e-r.github.io/kiki-plugins/marketplace.json \
  ../kiki/node_modules/.bin/tsx --tsconfig ../kiki/tsconfig.json test/host.integration.mts --all
```

The harness checks ZIP checksums, preview/install, enablement, and loaded contributions for the selected public catalog entries. It creates its own Kiki home and temporary files under `.tmp/host-proof`, uses no OAuth or paid generation, and leaves external engines uninstalled.

Office's real document-engine tests require `OFFICECLI_TEST_BINARY` pointing to the pinned executable. Without it, those three tests are explicitly skipped; manifest, consent, path, and package-safety tests still run. Optional Python extraction tests use `NB_EXTRACT_TEST_PYTHON`. Neither dependency is silently installed.

`build` writes a local candidate to `dist/`; production Release URLs become available only after publication. `dev` prints a loopback catalog URL and serves one prebuilt set of ZIPs, so index digests always match downloaded bytes. It exposes neither source tests nor build scripts. Restart it after source changes.

## Repository layout

- `plugins/official/<id>/`: first-party manifests, runtime, skills/panels, icons, and licenses.
- `plugins/official/media-runtime/`: shared source distributed into ten self-contained providers; not a catalog package.
- `plugins/<id>/`: additional source packages that are not listed in the public marketplace.
- `plugins/marketplace.json`: descriptions and author-hosted external entries.
- `scripts/`: packaging, validation, development server, and release tooling.
- `vendor/kiki-plugin-sdk-0.1.1-host-5c649def1.tgz`: compiled SDK artifact selected by `sdk.lock.json`; older artifacts remain intact. CI recompiles the fixed Kiki ref and compares its public exports and compiled files.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to change packages or propose third-party entries, and [RELEASING.md](RELEASING.md) to publish or recover a deployment.

## Licenses

First-party files retain their applicable MIT notices; see each package's `LICENSE` and `NOTICE`. StepFun-derived material also retains its Apache-2.0 license. Extract's bundled dependencies retain their vendor license and [third-party notices](plugins/official/kiki-extract/THIRD_PARTY_NOTICES.md). The root MIT license does not relicense third-party references or proprietary Moonshot packages.
