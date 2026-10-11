# Third-party notices

## OpenPet

Desktop interaction, animation row conventions and native window behavior are adapted from [X-T-E-R/OpenPet](https://github.com/X-T-E-R/OpenPet), revision `0675f4932a41d66d1b1fdbc6ddd94c46d6bd0ccd`, under GPL-3.0-or-later. This plugin and its adapted renderer/runtime are distributed under GPL-3.0-or-later; see `LICENSE`. The corresponding Rust source, locked dependency manifest, Tauri configuration, capabilities, icons and renderer are included in `vendor/runtime-source`. No OpenPet or catalog pet artwork is bundled.

## Official hatch-pet utilities

The pet-making skill contains unchanged deterministic Python utilities and row/QA references from `openai/skills`, revision `49f948faa9258a0c61caceaf225e179651397431`, under Apache-2.0. See `skills/kiki-pet-maker/NOTICE` and `LICENSE.txt`. The Kiki workflow text is independently authored. Image generation is not called or installed by this plugin.

## Bundled JavaScript dependencies

- yauzl 3.3.0 — MIT; `vendor/yauzl/LICENSE`. Its fd-slicer requires the adjacent bundled pend module and CRC checks require the adjacent buffer-crc32 module.
- pend 1.2.0 — MIT; `vendor/pend/LICENSE`.
- buffer-crc32 0.2.13 — MIT; `vendor/buffer-crc32/LICENSE`.

Native dependency versions are pinned in `vendor/runtime-source/Cargo.lock`; full dependency copyright/license texts and the resolved build-platform inventory are included in `vendor/runtime-licenses`. Tauri, serde/serde_json and image are MIT/Apache-2.0. The graph includes build dependencies as well as linked libraries; its listing does not imply every crate is part of the binary. Original MPL-2.0 dependency source (cssparser, cssparser-macros, dtoa-short, option-ext and selectors) is also included unmodified in `vendor/native-dependency-source`, under its original terms. Supplemental licenses omitted from published crate contents are pinned to upstream revisions in `vendor/build-source/runtime-license-overrides/origin.json`. Microsoft Edge WebView2's browser engine is supplied by the operating system/runtime installation and is not redistributed in the plugin archive.

## Artwork and user imports

Momo is original deterministic artwork dedicated under CC0-1.0; see `lib/assets/momo/LICENSE.txt`. Catalog integrations only download assets explicitly chosen by a user. Imported records retain source URL, content hash, original manifest, attribution and supplied license/notices. Unknown terms remain unknown: importing does not grant redistribution or commercial rights. No third-party catalog artwork is shipped in this archive.
