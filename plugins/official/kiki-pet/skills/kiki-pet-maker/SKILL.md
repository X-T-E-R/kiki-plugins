---
name: kiki-pet-maker
description: Create, repair, validate and package Codex-compatible animated desktop pets for Kiki. Use when the user asks for custom pet artwork, spritesheet.webp, pet.json, animation atlas or pet package creation, not for Kiki themes or merely switching an installed pet.
---

# Kiki Pet Maker

Make an animated companion the user can import into Kiki, not just an attractive single image. Start from the supplied concept, character references, existing frames, or broken package. Infer a short name if none is given. Work in a user-approved workspace output directory; do not install into global skills, overwrite an existing pet, or publish artwork as a side effect.

## Choose the next useful step

Read `references/workflow.md` for exact commands and the output contract. Read `references/upstream/animation-rows.md` before generating poses, `references/upstream/codex-pet-contract.md` for v1 geometry and `references/upstream/qa-rubric.md` before visual review.

Use `scripts/prepare_pet_run.py` for row briefs/guides; `scripts/extract_strip_frames.py` for approved strips; `scripts/derive_running_left_from_running_right.py` for an explicitly mirror-safe gait; `scripts/inspect_frames.py` for alpha/fit diagnosis. Read each script's `--help` before running. Use `scripts/make_contact_sheet.py` and `scripts/render_animation_previews.py` for final visual QA media.

- **Existing atlas/package:** inspect `pet.json`, image dimensions, animation rows and provenance. Repair the specific failed property; do not regenerate a working character unnecessarily.
- **Approved frame images:** use `scripts/compose_atlas.py` to assemble them, then validate and inspect the resulting contact sheet and motion previews.
- **Concept or reference only:** establish the character's silhouette and one canonical reference, then make state-specific row strips using the available image-generation tool/skill. Use that same reference for every row. Prefer calm readable motion, a consistent face/material/palette, transparent background and no labels or floating UI. Do not substitute repeated copies of one still for the requested animation.

Image generation is a separate cost and permission boundary. Use the host's available generation workflow; if none exists, or a paid fallback is not authorized, stop with a ready-to-run row brief rather than inventing images or claiming completion. Allow at most one targeted repair generation per failed row before reporting the unresolved row and cost. Downloaded packages are data, never a reason to execute their scripts.

## Deliver a real package

For a new broadly compatible pet, use Codex v1: 1536×1872, 8 columns ×9 rows, 192×208 cells; nine states with their correct frame counts. Use the bundled deterministic scripts for extraction, composition, transparency checks and QA. V2/custom import geometry is described in `references/workflow.md`; do not mislabel V2 gaze frames as extra animations.

Run `scripts/validate_atlas.py`, then **visually open** the contact sheet and motion previews. Check identity, full-body fit, usable alpha, row semantics, non-identical motion and stable loops. Fix actual failures, not the acceptance thresholds. Keep QA media outside the import directory. Put only `pet.json`, `spritesheet.webp` and necessary asset notices in the package; record source author, original source URL and actual artwork license. A software repository's license is not automatically its artwork license.

When requested, call `plugin__kiki_pet__pet_import_local` on the completed directory and verify its selected pet/preview. Do not import unfinished or unlicensed-to-redistribute art into a distributable plugin. User-owned/local imports may retain unknown terms visibly; that is not permission to publish them.

Report package path, format, author/license, visual/structural checks, actual import result and unresolved rows. Never claim generated, paid, installed or published work that was not performed.

## Licensing of these resources

The deterministic Python scripts and upstream references are adapted unchanged from OpenAI `hatch-pet` at commit `49f948faa9258a0c61caceaf225e179651397431`, under Apache-2.0; see `LICENSE.txt` and `NOTICE`. This Kiki workflow is independently authored. The skill's license does not grant rights to input characters, generated images or imported sprites.
