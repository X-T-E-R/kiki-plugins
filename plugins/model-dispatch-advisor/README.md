# Model Dispatch Advisor

Information-only Kiki plugin that reads shared cached harness quota snapshots via `context.harnessQuota.cached()` alongside explicit user selection preferences scoped by functional group.

This plugin never polls Magpie or any quota backend directly, never computes a "winner" or ranked recommendation, never hardcodes protected roles or candidate profiles, and never rewrites agent profiles, default models, `config.toml`, credentials, or in-flight dispatches. The AI reads the returned quota snapshots, timestamps, and scoped user preferences, then makes its own dispatch decision through standard `AgentRun` / profile contracts.

## Tools

| Tool | Model-visible name | Purpose |
| --- | --- | --- |
| `dispatch_advisor_recommend` | `plugin__model_dispatch_advisor__dispatch_advisor_recommend` | Read `context.harnessQuota.cached()` (`{ sources: [{ id, label, engineIds, minRefreshIntervalMs, readAt?, readings? }] }`) together with the user's latest saved preference for a requested functional `group` (optionally filtered by `targets`, `engineIds`, `accountIds`, or accompanied by `context.models.list({ candidates })` via `includeModels: true`). |
| `dispatch_preference_update` | `plugin__model_dispatch_advisor__dispatch_preference_update` | Save (`set`), inspect (`get`), or remove (`clear`) explicit user selection preferences keyed by functional `group`. |

## Contract Guarantees

1. **Sole read-only quota cache consumer:** Consumes `context.harnessQuota.cached()` exclusively—no top-level `readings`, no legacy fallback guesses, and zero direct CLI/backend calls. When `readings` is omitted on a source (not yet cached or failed within the refresh interval) or when the host predates `context.harnessQuota`, status is reported honestly as `"unknown"` / `"unavailable"` (`remaining: null`), never fabricated as `0` or unlimited. True `0` remaining is reported as `status: "exhausted"`.
2. **Pure information supply—no selection engine:** Returns raw source snapshots and stored preferences (`informationOnly: true`). Contains zero hardcoded role lists, default model bindings, candidate injection, unit comparisons, or `recommended` winners.
3. **Functional scope isolation & explicit provenance:** Preferences are stored under the caller-supplied `group` key (for example `"implementation"`). Querying another scope returns `preference: null` without leaking rules across scopes or altering any profile defaults. `action: "set"` requires `userAuthorized: true` and `userQuote`/`sourceNote`; model-inferred guesses are rejected.

## Storage & Lifecycle

Preferences are persisted exclusively in `$KIKI_HOME/plugin-data/model-dispatch-advisor/preferences.json` via serialized atomic rename writes, surviving process restarts and plugin reloads. Use `dispatch_preference_update` with `action: "clear"` (`group` or `clearAll: true`) to remove saved preferences.

```sh
/plugins install --trust ./plugins/model-dispatch-advisor
/plugins enable model-dispatch-advisor
```

Disabling the plugin withdraws both tools immediately without altering profiles, active sessions, or credentials.
