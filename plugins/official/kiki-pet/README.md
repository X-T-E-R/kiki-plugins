# Kiki Desktop Pet

A small native companion for Kiki work. Momo, the original bundled pet, is ready immediately. The transparent desktop window can be dragged, paused or closed without closing Kiki. Working, approval/question waiting, completion and failure change its animation; clicking its status bubble focuses the relevant session.

## Compatibility and installation

This candidate requires the Kiki **0.4 App-plugin Host integration**: application activation/deactivation, a plugin data directory, activity observation and session-focus receipts. It is **not install-compatible with stock Kiki 0.3.2**. Once that Host integration is present, import the plugin archive through Kiki's plugin installer, review its declared access and enable Desktop Pet. No global skill installation or separate app setup is needed.

The supplied native binary is Windows x64 and uses installed Microsoft Edge WebView2. Linux/macOS binaries are not included or verified. The management panel can import and select pets, start/recover or stop the window, adjust scale and pause, and reveal optional movement/feedback settings. Closing or disabling the plugin stops only its owned pet process; installed pets remain in the plugin data directory. A failed or unresponsive renderer is closed after a bounded heartbeat timeout. **Recover** starts it explicitly; there is no automatic restart loop.

## Import a pet

Paste a local directory, `pet.json`, PNG/WebP spritesheet, `.zip`/`.petpack`, public HTTPS detail link or direct download into the import field. One import downloads/validates the package, preserves its source information and selects it. Package scripts are never executed. Codex v1 (1536×1872, 8×9), Codex v2 (1536×2288, 8×11 including 16 static gaze frames) and custom atlases with explicit `atlas`/`animations` metadata are supported. Each image is limited to 11 MiB, 4096 pixels per side and 8 megapixels. Images are fully decoded in a bounded separate process; malformed or oversized files fail in place without replacing the current pet. Remote downloads must use public HTTPS; authenticated/private-address URLs and private redirects are rejected.

The source menu adds two popular catalogs, measured on 2026-10-06: **OpenPets** (1,265 stars, 1,304 directory entries) and **Awesome Codex Pet / codexpet.top** (1,063 stars, 303 pets). Chen checksumed `.petpack` downloads are additional compatibility, not the second popular catalog. Public Petdex and Codex Pets links and generic pages exposing a spritesheet are also adapted; website changes may require a direct download link.

Catalog/code licenses do not automatically license every pet. Source URL, author, asset hash, original manifest and supplied notices are retained. Terms that are missing remain **unknown**, rather than being replaced with a permissive label. User-chosen imports are permitted, but importing is not permission to republish or use commercially. Only original CC0 Momo artwork is bundled.

## Agent tools and making pets

`pet_control` manages state, recovery, pause/scale, actions, short text bubbles and session focus. `pet_import_local` and `pet_import_url` perform the same validated imports. Do not place task content or secrets in bubbles. Activity observation contains only session identifier, phase/reason and timestamps—not prompt or tool argument bodies.

The included `kiki-pet-maker` skill walks through character design, row production, frame inspection, composition, structural validation and visual review before an actual local import. It reuses the official Apache-2.0 hatch-pet deterministic Python utilities, requires Python/Pillow for those utilities, and accepts already available or authorized art tools. It does **not** silently invoke paid image generation, install Codex or require a Codex-only image tool. Generated art still needs human/model visual judgment: passing the atlas validator does not prove appealing movement or character consistency.

## Build and source

In the plugin repository, run `python plugins/official/kiki-pet/scripts/make-default.py` to recreate Momo, then `node plugins/official/kiki-pet/scripts/build.mjs` to compile Rust and synchronize declared panel resources. Run `node plugins/official/kiki-pet/scripts/check.mjs` and `node --test test/pet.test.mjs` before packaging. The repository catalog must include this plugin before the shared `npm run check -- kiki-pet` can validate it.

The archive carries corresponding native Rust/renderer source in `vendor/runtime-source`, with its lockfile, capabilities, icons and configuration. From that directory, a Rust toolchain and platform Tauri build prerequisites can rebuild with `cargo build --release`; Cargo retrieves the pinned upstream dependencies. `vendor/build-source` also carries the original repository build/art scripts for reconstruction. See `LICENSE` and `THIRD_PARTY_NOTICES.md` for GPL-3.0-or-later, dependency licenses, donor revisions and CC0 artwork terms.
