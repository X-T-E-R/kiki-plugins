# Engineering guide

- Use Node >=24.15.0 and `npm ci --ignore-scripts`; commit dependency locks with changes.
- Plugin Host and SDK source belong to X-T-E-R/kiki. Consume the pinned SDK artifact; do not fork Host or SDK implementations here.
- Preserve package and vendor licenses. Catalog references do not grant redistribution permission.
- Published package versions are immutable. Bump the affected manifest version for runtime changes; shared media-runtime changes affect ten providers.
- Run targeted `npm run check -- <id>` and `npm test`. HTTP fixtures must deny unexpected requests; do not run paid services or real OAuth in CI.
- Use temporary data under ignored `.tmp/`, never the user's Kiki home.
- Check staged paths for credentials, local paths, session logs, caches, and accidental artifacts before commits or public pushes.
- Release only through the serialized workflow documented in RELEASING.md. This repository's Pages site must not overwrite the Kiki main site.

## Product principles and handoffs

- Design the complete user path, not a collection of adapters. Reuse mature implementations and existing Kiki connections, credentials, tasks, and panels where they fit; current implementation limits are evidence, not permanent product requirements.
- One clear user action should carry through the necessary work. Keep meaningful consent and user-controlled limits; remove redundant confirmations, manual continuation steps, speculative restrictions, and repeated checks.
- Follow Kiki's paper-and-ink design: compact hierarchy, whitespace, and in-place actions rather than stacked cards or explanation walls. Show facts needed to choose, act, or recover; omit internal mechanisms and empty diagnostic sections that do not help the current task.
- Keep normal defaults useful and the full result accessible. Use progressive loading, caching, and virtualization for responsiveness rather than permanent truncation or repeated requests to load more.
- Apply these principles during implementation and before handing work over. A handoff preserves the intended user flow, actual contracts, decisive evidence, and remaining work; it must not turn a temporary backend limitation into a required UI workaround. Reuse valid checks and inspect the changed behavior without adding a separate review ceremony.
