# Magpie Harness Quota

Read Antigravity (`agy-cli`) account quota windows through the official `magpie` CLI (`magpie accounts antigravity --json`) without running a reverse proxy, importing credentials, or altering provider endpoints and native homes.

## Source ID & Host Contract

- Manifest contribution: `x-kiki.harnessQuotaSources` (`schemaVersion: 1`, `id: "antigravity"`, `engineIds: ["agy-cli"]`, `minRefreshIntervalMs: 300000`).
- Runtime registration: `api.registerHarnessQuotaSource(definition, { read({ signal, settings, kikiHome }) })` returning `{ readings }`.
- Refresh throttling (`>= 300000` ms) and single-flight caching are owned by the Kiki Host; each `read()` executes one batch CLI read across all configured Antigravity accounts and respects `AbortSignal` cancellation.

To enable automatic instance selection on AGY CLI while keeping `main` as the fallback when quota is unknown:

```toml
[agent_executor_overrides."agy-cli".defaults]
executor_instance = "auto"

[agent_executor_overrides."agy-cli"]
quota_source = "plugin:magpie-harness-quota/antigravity"
```

Bind each named `agent_executor_instances` entry's `quota_account_id` to the exact `user` string reported by `magpie accounts antigravity --json`.

## Plugin Settings & Window Semantics

- `magpiePath` (optional): Absolute path to `magpie` or `magpie.exe` on the Kiki server. When omitted, `magpie` is resolved from `PATH`.
- `modelWindows` (optional JSON): Magpie collapses per-model windows into shared quota pools (`Gemini`, `Claude & GPT`, `Gemini 4 Argon`, etc.). Map exact native AGY model IDs to exact Magpie `pool` and/or `name` values so `auto` routing knows which pool serves each model:

```json
{
  "gemini-4-argon-high": { "pool": "Gemini 4 Argon" },
  "gemini-4-argon-medium": { "pool": "Gemini 4 Argon" },
  "gemini-3.8-flash-high": { "pool": "Gemini", "name": "5 hours" },
  "claude-opus-5-5-high": { "pool": "Claude & GPT", "name": "5 hours" }
}
```

- **Strict pool separation:** Ordinary `Gemini` hourly/weekly windows (`pool: "Gemini"`) never masquerade as `Gemini 4 Argon` (`pool: "Gemini 4 Argon"`). Pooled readings without a matching `modelWindows` rule omit `modelIds` so they remain visible in quota displays without misrouting requests.
- **Honest unknown & exhausted states:** True `0` remaining is emitted as `remaining: 0` (exhausted). Unknown, lapsed, unlimited, text-only, or failed/stale fallback readings (`asOf != nil` or `error != ""`) omit `remaining` (unknown) while preserving `readAt` and `resetAt` timestamps.

## Install & Disable

Requires a Kiki Host build that includes `@kiki/plugin-sdk/harness-quota` support:

```sh
/plugins install --trust ./plugins/magpie-harness-quota
/plugins enable magpie-harness-quota
```

Disabling or removing the plugin stops future quota reads while leaving existing executor instances, accounts, and sessions intact.
