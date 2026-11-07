# Magpie Harness Quota

Read Antigravity (`agy-cli`) account quota windows through the official `magpie` CLI (`magpie accounts antigravity --json`) without running a reverse proxy, importing credentials, or altering provider endpoints and native homes.

## Source ID & Host Configuration

Registers `plugin:magpie-harness-quota/antigravity` with a 5-minute (`300000` ms) minimum refresh interval and single-flight batch reads across all configured Antigravity accounts.

To enable automatic instance selection on AGY CLI while keeping `main` as the fallback when quota is unknown:

```toml
[agent_executor_overrides."agy-cli".defaults]
executor_instance = "auto"

[agent_executor_overrides."agy-cli"]
quota_source = "plugin:magpie-harness-quota/antigravity"
```

Bind each named `agent_executor_instances` entry's `quota_account_id` to the exact `user` string reported by `magpie accounts antigravity --json`.

## Plugin Settings

- `magpiePath` (optional): Absolute path to `magpie` or `magpie.exe` on the Kiki server. When omitted, `magpie` is resolved from `PATH` using the host's normal OS user home.
- `modelWindows` (optional JSON): Magpie collapses per-model windows when projecting shared quota pools (`Gemini`, `Claude & GPT`, `Gemini 4 Argon`, etc.). Map exact native AGY model IDs to exact Magpie `pool` and/or `name` values so `auto` routing knows which pool serves each model:

```json
{
  "gemini-4-argon-high": { "pool": "Gemini 4 Argon" },
  "gemini-4-argon-medium": { "pool": "Gemini 4 Argon" },
  "gemini-3.8-flash-high": { "pool": "Gemini", "name": "5 hours" },
  "claude-opus-5-5-high": { "pool": "Claude & GPT", "name": "5 hours" }
}
```

Pooled readings without a matching `modelWindows` entry omit `modelIds` so they remain visible in quota displays without misrouting requests. Unknown, lapsed, unlimited, or text-only windows retain `remaining: undefined` rather than fabricating `0` or an infinite value.

## Install & Disable

```sh
/plugins install --trust ./plugins/magpie-harness-quota
/plugins enable magpie-harness-quota
```

Disabling or removing the plugin stops future quota reads while leaving existing executor instances, accounts, and sessions intact.
