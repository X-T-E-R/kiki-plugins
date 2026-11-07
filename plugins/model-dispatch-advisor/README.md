# Model Dispatch Advisor

Information-only Kiki plugin that presents shared model/harness quota snapshots alongside explicit user selection preferences scoped by functional group.

This plugin never computes a "winner" or ranked recommendation, never hardcodes protected roles or candidate profiles, and never rewrites agent profiles, default models, `config.toml`, credentials, or in-flight dispatches. The AI reads the returned quota readings, timestamps, and scoped user preferences, then makes its own dispatch decision through standard `AgentRun` / profile contracts.

## Tools

| Tool | Model-visible name | Purpose |
| --- | --- | --- |
| `dispatch_advisor_recommend` | `plugin__model_dispatch_advisor__dispatch_advisor_recommend` | Present cached quota readings (remaining quota, unit, source, `readAt`/`resetsAt`, and `unknown`/`exhausted` status) together with the user's latest saved preference for a requested functional `group` (optionally filtered by `targets`, `engineIds`, `accountIds`, or `includeModels: true`). |
| `dispatch_preference_update` | `plugin__model_dispatch_advisor__dispatch_preference_update` | Save (`set`), inspect (`get`), or remove (`clear`) explicit user selection preferences keyed by functional `group`. |

## Contract Guarantees

1. **Pure information supply—no selection engine:** Returns raw quota readings and stored preferences (`informationOnly: true`). Contains zero hardcoded role lists, default model bindings, candidate injection, unit comparisons, or `recommended` winners.
2. **Functional scope isolation:** Preferences are stored under the caller-supplied `group` key (for example `"implementation"`). Querying another scope returns `preference: null` without leaking rules across scopes or altering any profile defaults.
3. **Explicit user provenance:** `dispatch_preference_update` with `action: "set"` requires `userAuthorized: true` and a `userQuote` or `sourceNote` recording what the user stated. Model-inferred guesses are rejected.
4. **Honest quota states:** Unavailable, missing, unlimited, text-only, or failed/stale fallback readings (`asOf` / `error` / `lapsed`) are reported as `status: "unknown"` with `remaining: null` while preserving `readAt` / `asOf` timestamps—never fabricated as `0` or infinite. True `0` remaining is reported as `status: "exhausted"`.

## Storage & Lifecycle

Preferences are persisted exclusively in `$KIKI_HOME/plugin-data/model-dispatch-advisor/preferences.json` via serialized atomic rename writes, surviving process restarts and plugin reloads. Use `dispatch_preference_update` with `action: "clear"` (`group` or `clearAll: true`) to remove saved preferences.

```sh
/plugins install --trust ./plugins/model-dispatch-advisor
/plugins enable model-dispatch-advisor
```

Disabling the plugin withdraws both tools immediately without altering profiles, active sessions, or credentials.
