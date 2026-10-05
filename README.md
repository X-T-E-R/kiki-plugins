# Kiki Plugins

Independently versioned plugins for [Kiki](https://github.com/X-T-E-R/kiki): Office, Writing, Extract, Notion, Media, and ten media provider packages. Kiki's Host, SDK, permission preview, and installer remain in the Kiki repository.

**[Browse the catalog](https://x-t-e-r.github.io/kiki-plugins/)** · **[Catalog JSON](https://x-t-e-r.github.io/kiki-plugins/marketplace.json)** · **[Versioned packages](https://github.com/X-T-E-R/kiki-plugins/releases)**

## Install a plugin

Use a Kiki Host with checksum-pinned catalog installation support. If your build still opens an older catalog, set `KIKI_PLUGIN_MARKETPLACE_URL=https://x-t-e-r.github.io/kiki-plugins/marketplace.json` when starting Kiki. Open the plugin market, choose a package, and review the installation preview. Enable it after checking its contributions and requested permissions. Each first-party entry points to a versioned Release ZIP and its SHA-256 digest; old packages stay available.

The catalog targets **plugin engine 0.4.0**, not the Kiki product version or the SDK package version. SDK 0.1.0 is the current build-time contract. A package's `x-kiki.engines.kiki` range determines Host compatibility.

| Package | What you need to use it |
| --- | --- |
| Writing | No external service; contributes a manuscript panel and draft command. |
| Extract | Text and HTML work locally. PDF and Office conversion need Python and MarkItDown; MinerU upload is explicit and opt-in. See [Extract setup](plugins/official/kiki-extract/README.md). |
| Office | OfficeCLI **1.0.152**, installed with consent; Windows x64, macOS arm64, and Linux x64 are supported by its pinned binary resolver. |
| Notion | Notion's HTTP MCP service and its OAuth authorization. See [Notion](plugins/official/kiki-notion/README.md). |
| Media | Install the Media entry plus a provider; configure an entitled API connection or key. Cloud generation may incur charges. ComfyUI needs your running endpoint and installed workflow/models; no GPU engine or models are included. |

The two Moonshot entries are **author-hosted references**, not mirrored source in this repository. Their original license and external daemon/service requirements apply. The three community entries keep pinned author commits; their Claude-plugin import compatibility is marked unverified, so inspect Kiki's unsupported-contribution diagnostics before enabling them.

## Build and test locally

Use Node **24.15.0 or newer** (CI uses 24.18.0). Dependencies and the SDK tarball are locked; npm publication is not required.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run dev
```

`check` validates all 15 packages, manifest synchronization, media distribution, Extract behavior, and mocked provider protocols. It downloads only the checksum-pinned Host RPC runner from the public Kiki ref in `sdk.lock.json`; it does not read your Kiki home or use paid API credentials. To test one package, use `npm run check -- kiki-extract`.

With a Kiki checkout and its dependencies installed beside this repository, run the real Host installation test against the public catalog:

```sh
KIKI_HOST_REPO=../kiki KIKI_CATALOG_URL=https://x-t-e-r.github.io/kiki-plugins/marketplace.json \
  ../kiki/node_modules/.bin/tsx --tsconfig ../kiki/tsconfig.json test/host.integration.mts --all
```

This verifies ZIP checksums, preview/install, enablement, and loaded contributions for all 15 first-party packages. It creates its own Kiki home and temporary files under `.tmp/host-proof`, uses no OAuth or paid generation, and leaves external engines uninstalled. Omit `--all` for the four-package Writing/Extract/Media/OpenAI smoke test; omit `KIKI_CATALOG_URL` to use local prebuilt ZIPs.

Office's real document-engine tests require `OFFICECLI_TEST_BINARY` pointing to the pinned executable. Without it, those three tests are explicitly skipped; manifest, consent, path, and package-safety tests still run. Optional Python extraction tests use `NB_EXTRACT_TEST_PYTHON`. Neither dependency is silently installed.

`build` writes a local candidate to `dist/`; production Release URLs become available only after publication. `dev` prints a loopback catalog URL and serves one prebuilt set of ZIPs, so index digests always match downloaded bytes. It exposes neither source tests nor build scripts. Restart it after source changes.

## Repository layout

- `plugins/official/<id>/`: first-party manifests, runtime, skills/panels, icons, and licenses.
- `plugins/official/media-runtime/`: shared source distributed into ten self-contained providers; not a catalog package.
- `plugins/marketplace.json`: descriptions and author-hosted external entries.
- `scripts/`: packaging, validation, development server, and release tooling.
- `vendor/kiki-plugin-sdk-0.1.0.tgz`: compiled SDK artifact from the fixed Kiki source ref, not a second SDK implementation. CI recompiles that ref and compares the public output.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to change packages or propose third-party entries, and [RELEASING.md](RELEASING.md) to publish or recover a deployment.

## Licenses

First-party files retain their applicable MIT notices; see each package's `LICENSE` and `NOTICE`. StepFun-derived material also retains its Apache-2.0 license. Extract's bundled dependencies retain their vendor license and [third-party notices](plugins/official/kiki-extract/THIRD_PARTY_NOTICES.md). The root MIT license does not relicense third-party references or proprietary Moonshot packages.
