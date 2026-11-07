# Model Dispatch Advisor

Advisory tools for reading shared model/harness quota snapshots and keeping explicit user selection preferences across equivalent functional candidate groups (`implementation`, `frontend`, `review`, `research`, `writing`, `thinking`, `director`, or custom groups).

This plugin is strictly advisory: it never rewrites agent profiles, `config.toml`, credentials, or in-flight dispatches.

## Tools

| Tool | Model-visible name | Purpose |
| --- | --- | --- |
| `dispatch_advisor_recommend` | `plugin__model_dispatch_advisor__dispatch_advisor_recommend` | Read `context.models.list()`, shared cached quota readings, and saved user preferences for a functional group; return ranked candidates with quota status, provenance, and concise reasons. |
| `dispatch_preference_update` | `plugin__model_dispatch_advisor__dispatch_preference_update` | Save (`set`), inspect (`get`), or clear (`clear`) explicit user selection preferences, or define/remove custom functional groups (`define_group`, `remove_group`). |

## Selection Rules

1. **Hard constraints first:** Profile or caller `allowedModels`, `deniedModels`, `allowedProfiles`, and `deniedProfiles` are never overridden by soft preferences or turn overrides.
2. **Explicit turn target wins over soft rules:** Passing `explicitTarget` (when the user names a specific model, profile, or harness for the current task) ranks that eligible candidate first.
3. **Functional group isolation & protected roles:** Saving an `implementation` preference (for example, `avoid: ["gpt"]`, `prefer: ["implementer-grokbuild", "implementer-argon"]`) applies only to `implementation`. Protected roles (`writer`, `think`, `director`) keep their configured role defaults unless the user explicitly authorizes changing that role (`authorizedRoles: ["writer"]` on that group's preference) or names `explicitTarget`.
4. **Explicit user provenance:** `dispatch_preference_update` with `action: "set"` requires `userAuthorized: true` and a `userQuote` or `sourceNote` recording what the user asked for. Model-inferred guesses are rejected.
5. **Honest quota handling:** Reads consume Kiki's shared cached quota API when attached and fall back cleanly when unavailable. Unknown or incomparable quota units are reported as `unknown` / `incomparable_units`—never fabricated as `0` or unlimited. External harnesses (`grok-acp`, `agy-cli`, etc.) are labeled `external-harness` rather than dropped when absent from `context.models.list()`.

## Storage & Lifecycle

Preferences and custom groups are stored only under `$KIKI_HOME/plugin-data/model-dispatch-advisor/preferences.json` via atomic rename writes, surviving process restarts and plugin reloads. Use `dispatch_preference_update` with `action: "clear"` (`group` or `clearAll: true`) to remove saved rules.

```sh
/plugins install --trust ./plugins/model-dispatch-advisor
/plugins enable model-dispatch-advisor
```

Disabling the plugin withdraws both tools immediately without altering profiles, active sessions, or credentials.
