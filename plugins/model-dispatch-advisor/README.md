# Model Dispatch Advisor

Advisory tools for reading shared model/harness quota snapshots and keeping explicit user selection preferences across equivalent functional candidate groups (`implementation`, `frontend`, `review`, `research`, `writing`, `thinking`, `director`, or custom groups).

This plugin is strictly advisory: it never rewrites agent profiles, `config.toml`, credentials, or in-flight dispatches, and ships zero hardcoded private model aliases, efforts, or external harness assumptions.

## Tools

| Tool | Model-visible name | Purpose |
| --- | --- | --- |
| `dispatch_advisor_recommend` | `plugin__model_dispatch_advisor__dispatch_advisor_recommend` | Read connected models via `context.models.list()`, shared cached quota readings, and saved user preferences for a functional group; return ranked candidates with quota status, provenance, and concise reasons. |
| `dispatch_preference_update` | `plugin__model_dispatch_advisor__dispatch_preference_update` | Save (`set`), inspect (`get`), or clear (`clear`) explicit user selection preferences, or define/remove custom functional groups (`define_group`, `remove_group`). |

## Selection Rules

1. **Hard constraints first (including empty allowlists):** Profile or caller `allowedModels`, `deniedModels`, `allowedProfiles`, and `deniedProfiles` are never overridden. Explicitly empty allowlists (`allowedModels: []` or `allowedProfiles: []`) admit nothing.
2. **Explicit turn target & protected role defaults never silently switch models:** Passing `explicitTarget` or evaluating a protected role (`writer`, `think`, `director`) preserves that target/default ahead of soft preferences and quota soft-sorting—even when no preferences are stored or when quota is `0%` (`exhausted`). Exhausted quota is surfaced honestly on `recommended.quota` instead of quietly swapping models.
3. **Zero-configuration first run via `context.models.list()`:** With no custom group or caller `candidates`, connected chat models from `context.models.list()` are evaluated directly, and protected roles without an explicit `roleDefaultModel` preserve `profile:<role>` inheritance. External harnesses (`kind: "external-harness"`) require explicit `available: true` from caller/configuration because `models.list()` only proves native model connections, not profile or harness readiness.
4. **Functional group isolation & explicit user provenance:** Saving an `implementation` preference (for example, `avoid: ["gpt"]`, `prefer: ["grok", "gemini"]`) applies only to `implementation`. Protected roles stay unchanged unless authorized in `authorizedRoles`. `action: "set"` requires `userAuthorized: true` and `userQuote`/`sourceNote`; model-inferred guesses are rejected.
5. **Honest quota handling:** Unknown or incomparable quota units are reported as `unknown` / `incomparable_units` (`remaining: null`)—never fabricated as `0` or unlimited.

## Storage & Lifecycle

Preferences and custom groups are stored only under `$KIKI_HOME/plugin-data/model-dispatch-advisor/preferences.json` via serialized atomic rename writes, surviving process restarts and plugin reloads. Use `dispatch_preference_update` with `action: "clear"` (`group` or `clearAll: true`) to remove saved rules.

```sh
/plugins install --trust ./plugins/model-dispatch-advisor
/plugins enable model-dispatch-advisor
```

Disabling the plugin withdraws both tools immediately without altering profiles, active sessions, or credentials.
