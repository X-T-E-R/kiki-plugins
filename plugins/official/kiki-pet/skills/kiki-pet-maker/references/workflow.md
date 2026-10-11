# Produce and check the pet package

## Resources and prerequisites

Python 3 + Pillow are needed for deterministic raster work. Use an existing approved interpreter; do not silently install packages globally. The skill root below is the installed plugin's skill directory, not `$HOME/.codex/skills`. Always quote paths.

Read `upstream/animation-rows.md` for row semantics and frame counts. `upstream/qa-rubric.md` is the visual checklist. `upstream/codex-pet-contract.md` describes v1 geometry. The scripts are Apache-2.0 OpenAI hatch-pet code retained with their license; they are deterministic raster tools, not an image generator.

## Generation and frame pipeline

For a new character, prepare a work run with `scripts/prepare_pet_run.py --pet-name NAME --pet-notes CONCEPT --output-dir RUN`. This produces row prompt/layout resources. The donor's `imagegen-jobs.json` records dependencies; Kiki must use its actually available, authorized image workflow, not assume Codex's `$imagegen` is installed. Select one canonical generated/reference character before generating rows. The scripts do not authorize costs or third-party character rights.

For approved strips use `scripts/extract_strip_frames.py --help` to supply exact row/frame geometry; inspect extraction rather than guessing thresholds. To mirror safe directional frames, use `scripts/derive_running_left_from_running_right.py --help` only when asymmetric markings/props do not change meaning. `scripts/inspect_frames.py --help` measures alpha/fit for diagnosis.

Assemble approved per-state frame directories (e.g. frames/idle, frames/running-right) into v1:

```text
python "<skill>/scripts/compose_atlas.py" --frames-root "<run>/frames" --output "<run>/atlas.png" --webp-output "<package>/spritesheet.webp"
```

Or normalize an existing exact v1 atlas using `--source-atlas` instead of `--frames-root`. Do not resize an arbitrary image into an atlas to hide a bad frame layout. Keep 192×208 cells, no gutters and transparent unused cells.

Validate, generate QA and inspect them:

```text
python "<skill>/scripts/validate_atlas.py" "<package>/spritesheet.webp"
python "<skill>/scripts/make_contact_sheet.py" --help
python "<skill>/scripts/render_animation_previews.py" --help
```

Use the latter scripts' actual CLI flags (read `--help`) for their output directories. Save contact sheets/previews outside package. Visually open the final contact sheet and at least idle, directional and one state reaction loop. A positive structural result does not prove good animation.

## Manifest and import

Write `pet.json`:

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "A quiet companion.",
  "spritesheetPath": "spritesheet.webp",
  "author": "Artwork author",
  "license": "Actual artwork license",
  "sourceUrl": "https://example.com/original-art"
}
```

Do not invent an author/license; preserve unknown terms as unknown. Source URL is optional for genuinely original local art. New v1 leaves spriteVersionNumber absent. Codex v2 uses `spriteVersionNumber:2`, image1536×2288/8×11; rows0–8 unchanged, neutral row0col6 and16 static clockwise gaze cells in rows9–10. The official scripts bundled here target v1, so do not run v1 normalization over a v2 atlas.

Kiki also accepts custom atlas geometry with `atlas:{columns,rows}` and explicit `animations:{idle:{row,frameCount,frameDurationsMs},...}`. Image dimensions must divide exactly. For interoperability prefer v1 rather than this Kiki extension.

Call `plugin__kiki_pet__pet_import_local` with `{source:"<package-directory>"}` when the user asks to import. A package ZIP/.petpack is also accepted; only data files are read. Expected result is the actual selected pet and retained source/license. Bad/truncated images, out-of-bounds frames, unsafe sprite paths and oversized packages must fail before selection.

## Trigger / utility matrix

| Prompt | Trigger | Observable success |
|---|---|---|
| Make a desktop pet from my cat drawing | yes | consistent animated atlas, metadata, visual QA, importable directory |
| My pet.json points to ../secret; repair this package | yes | safe local sprite reference and validation; no outside file read |
| Assemble these approved idle/wave/etc frames | yes | deterministic scripts produce real atlas; no paid call |
| Set the installed pet to another character | no | use pet_control/select, no generation workflow |
| Make Kiki's background darker | no | appearance/theme workflow, not a pet atlas |
