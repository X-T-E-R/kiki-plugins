# Model Dispatch Advisor (`model-dispatch-advisor` `0.1.1`)

Information-only Kiki plugin that reads shared cached harness quota snapshots across all registered quota sources (such as `plugin:magpie-harness-quota/grok`, `plugin:magpie-harness-quota/antigravity`, `plugin:magpie-harness-quota/codex`, etc.) via `context.harnessQuota.cached()` alongside explicit user selection preferences scoped by functional group.

This plugin never polls Magpie or any quota backend directly, never computes a "winner" or ranked recommendation, never hardcodes protected roles or candidate profiles, and never rewrites agent profiles, default models, `config.toml`, credentials, or in-flight dispatches. The AI reads the returned quota snapshots, timestamps, and scoped user preferences, then makes its own dispatch decision through standard `AgentRun` / profile contracts.

## Tools

| Tool | Model-visible name | Purpose |
| --- | --- | --- |
| `dispatch_advisor_recommend` | `plugin__model_dispatch_advisor__dispatch_advisor_recommend` | Read `context.harnessQuota.cached()` (`{ sources: [{ id, label, engineIds, minRefreshIntervalMs, readAt?, readings? }] }`) together with the user's latest saved preference for a requested functional `group` (optionally filtered by `targets`, `engineIds`, `accountIds`, or accompanied by `context.models.list({ candidates })` via `includeModels: true`). |
| `dispatch_preference_update` | `plugin__model_dispatch_advisor__dispatch_preference_update` | Save (`set`), inspect (`get`), or remove (`clear`) explicit user selection preferences keyed by functional `group`. |

## Contract Guarantees

1. **Sole read-only quota cache consumer:** Consumes `context.harnessQuota.cached()` exclusively—no top-level `readings`, no legacy fallback guesses, and zero direct CLI/backend calls. When `readings` is omitted on a source (not yet cached or failed within the refresh interval) or when the host predates `context.harnessQuota`, status is reported honestly as `"unknown"` / `"unavailable"` (`remaining: null`), never fabricated as `0` or unlimited. True `0` remaining is reported as `status: "exhausted"`.
2. **Engine-bounded filtering without dropping uncached unknown sources:** Explicit `engineIds` defines the boundary of relevant quota sources. When querying by model `targets` (for example `["gemini-4-argon-high"]`) or `accountIds` while an engine-admitted source has not yet populated `readings`, that uncached source is preserved as `status: "unknown"` (`readings: null`)—and top-level `quota.status` reports `"unknown"` when no cached source matched—rather than silently returning `status: "ok"` with `sources: []` or fabricating model ownership.
3. **Pure information supply—no selection engine:** Returns raw source snapshots and stored preferences (`informationOnly: true`). Contains zero hardcoded role lists, default model bindings, candidate injection, unit comparisons, or `recommended` winners.
4. **Functional scope isolation & explicit provenance:** Preferences are stored under the caller-supplied `group` key (for example `"implementation"`). Querying another scope returns `preference: null` without leaking rules across scopes or altering any profile defaults. `action: "set"` requires `userAuthorized: true` and `userQuote`/`sourceNote`; model-inferred guesses are rejected.

## Storage & Lifecycle

Preferences are persisted exclusively in `$KIKI_HOME/plugin-data/model-dispatch-advisor/preferences.json` via serialized atomic rename writes, surviving process restarts and plugin reloads. Use `dispatch_preference_update` with `action: "clear"` (`group` or `clearAll: true`) to remove saved preferences.

```sh
/plugins install --trust ./plugins/model-dispatch-advisor
/plugins enable model-dispatch-advisor
```

Disabling the plugin withdraws both tools immediately without altering profiles, active sessions, or credentials.
