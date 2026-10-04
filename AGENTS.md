# Engineering guide

- Use Node >=24.15.0 and `npm ci --ignore-scripts`; commit dependency locks with changes.
- Plugin Host and SDK source belong to X-T-E-R/kiki. Consume the pinned SDK artifact; do not fork Host or SDK implementations here.
- Preserve package and vendor licenses. Catalog references do not grant redistribution permission.
- Published package versions are immutable. Bump the affected manifest version for runtime changes; shared media-runtime changes affect ten providers.
- Run targeted `npm run check -- <id>` and `npm test`. HTTP fixtures must deny unexpected requests; do not run paid services or real OAuth in CI.
- Use temporary data under ignored `.tmp/`, never the user's Kiki home.
- Check staged paths for credentials, local paths, session logs, caches, and accidental artifacts before commits or public pushes.
- Release only through the serialized workflow documented in RELEASING.md. This repository's Pages site must not overwrite the Kiki main site.
