# Magpie Harness Quota (`magpie-harness-quota` `0.1.1`)

Unified Magpie quota & structured management plugin for Kiki:

1. **External harness quota sources (`x-kiki.harnessQuotaSources`):** Supplies Kiki's `auto` executor instance scheduler and `context.harnessQuota.cached()` consumers without running a reverse proxy, mutating Magpie's saved login files, or altering system/provider proxies:
   - **`antigravity` (`agy-cli`, `antigravity-acp`):** Uses the canonical built-in read-only direct Code Assist collector (`./lib/antigravity-direct-quota.mjs`, `MagpieAntigravityDirectQuotaService`) so each Magpie-managed Antigravity account queries `loadCodeAssist` / `fetchAvailableModels` / `retrieveUserQuotaSummary` strictly through that account's bound HTTP CONNECT or SOCKS5/SOCKS5h proxy, with exact Pro versioned-pool vs Ultra shared-family-group model assignment and a 5-minute single-flight floor. A still-valid access token is used directly. Refreshing an expired token uses the same proxy and an OAuth client supplied at runtime (see below). Other harness sources are unchanged.
   - **Verified 1:1 CLI harness sources (`grok`, `codex`, `claude`, `gemini`, `cursor`, `qoder[-cn]`, `workbuddy[-ai]`):** Read directly from the official `magpie` CLI (`magpie accounts <agent> --json`), without speculative catch-all bindings onto unrelated engines.
2. **Structured Magpie management tool (`magpie_manage`):** Provides a credential-safe, structured management entry point (`plugin__magpie_harness_quota__magpie_manage`) covering account inspection, global gateway switching (explicitly distinguished from native CLI sign-in), native Grok single-rotating-token status & locator discovery, quota cards & 45-day history, token/session usage, model catalog & per-model settings (`models_list`, `model_manage`, `sync_catalog`), routing groups (`groups_list`, `group_manage`), service/daemon/autostart controls (`service_status`, `daemon_manage`, `autostart_manage`, `proxy_status`), verified public settings (`settings_list`, `settings_get`, `settings_set`, `settings_reset`), provider pools (`providers_list`, `provider_pool`), plugins (`plugins_list`, `plugin_manage`), and structured log file locators (`log_locator`). Never executes arbitrary shell commands, never starts proxy/daemon services unless explicitly invoked via `daemon_manage`, never returns raw log contents, and never returns tokens or API keys.

## Declared Quota Sources & Host Engine Mapping

Each source is declared in `x-kiki.harnessQuotaSources` (`schemaVersion: 1`, `minRefreshIntervalMs: 300000`) and registered via `api.registerHarnessQuotaSource(definition, adapter)`. Refresh throttling (`>= 300000` ms) and single-flight caching are owned by the Kiki Host; each `read({ signal, settings, kikiHome })` performs one batch read for that source and respects `AbortSignal` cancellation.

| Source ID (`plugin:magpie-harness-quota/<id>`) | Backing reader | Kiki `engineIds` |
| --- | --- | --- |
| `antigravity` | Built-in `./lib/antigravity-direct-quota.mjs` (`MagpieAntigravityDirectQuotaService`) | `agy-cli`, `antigravity-acp` |
| `grok` | `magpie accounts grok --json` (`plugin:grok`) | `grok-acp` |
| `codex` | `magpie accounts codex --json` | `codex-app-server`, `codex-acp` |
| `claude` | `magpie accounts claude --json` | `claude-acp` |
| `gemini` | `magpie accounts gemini --json` | `gemini-acp` |
| `cursor` | `magpie accounts cursor --json` | `cursor-acp` |
| `qoder` / `qoder-cn` | `magpie accounts qoder[-cn] --json` | `qoder-acp` |
| `workbuddy` / `workbuddy-ai` | `magpie accounts workbuddy[-ai] --json` | `codebuddy-acp` |

Example `auto` instance configuration for Grok Build and Antigravity:

```toml
[agent_executor_overrides."grok-acp".defaults]
executor_instance = "auto"

[agent_executor_overrides."grok-acp"]
quota_source = "plugin:magpie-harness-quota/grok"

[agent_executor_overrides."agy-cli".defaults]
executor_instance = "auto"

[agent_executor_overrides."agy-cli"]
quota_source = "plugin:magpie-harness-quota/antigravity"
```

Bind each named `agent_executor_instances` entry's `quota_account_id` to the exact Magpie `user` identifier (`email` or seat ID).

## Structured Management Tool (`magpie_manage`)

Call `magpie_manage` with `action: "capabilities"` to inspect all 32 operations, their `subcommands`, and their explicit `mutates` / `sideEffectScope` boundaries:

- **Accounts & global switching (`accounts_list`, `accounts_switch`, `accounts_alias`, `accounts_switch_only`, `accounts_discovery`, `accounts_refresh`, `accounts_checkin`):**
  - Identities are redacted (`maskedAccount` + 12-char `accountHash`); callers can pass `accountHash` directly to `accounts_switch` / `accounts_alias` / `quota_refresh` so raw emails never need to transit prompts.
  - **Gateway priority vs native CLI sign-in:** Per Magpie's `switchSideLogin` (`internal/provider/side_logins.go:237-255`), `accounts_switch` on `grok`, `antigravity`, `gemini`, `cursor`, `qoder`, `workbuddy`, etc. returns `scope: "magpie_gateway_only"` and `nativeHarnessActivated: false` (it updates `logins.json` gateway routing priority only and does **not** rewrite the external CLI's native sign-in). Only `codex` and `claude` rewrite native CLI credentials (`scope: "native_cli_and_magpie"`, `nativeHarnessActivated: true`).
- **Native Grok single-rotating-token status & locator (`grok_native_status`, `grok_native_locator`):**
  - Discovers all current Magpie Grok slots from `logins.json` (`login.home`) + `plugin-auth.json` alongside `~/.grok` (`auth.json`, preserved `sessions`, and `auth.json.bak` recovery references) without copying rotating OIDC `refresh_token`s across directories or exposing tokens.
  - When the selected account already resides in the CLI native default home (`~/.grok`), returns `isCliNativeHome: true`, `locator.mode: "cli_native_default_home"`, `requiresEnvOverride: false`, `env: {}`.
  - When the selected account resides in a Magpie plugin private home, returns `isCliNativeHome: false`, `locator.mode: "preserve_grok_home_and_sessions"`, `env: { GROK_AUTH_PATH: "<slotHome>/auth.json" }` (plus `isolatedInstanceAlternative` `{ kind: "config_directory", path: "<slotHome>" }`).
- **Models & routing groups (`models_list`, `model_manage`, `sync_catalog`, `groups_list`, `group_manage`):**
  - `model_manage` supports `name`, `names`, `efforts`, `api`, `apis`, `context`, `output`, `spec`, `specs`, `wire`, `wires`, `id`, `ids`, `alias`, `aliases`, `disable`, `enable`, `disabled`, `suffix`, and `compact`.
  - `group_manage` supports `show`, `add`, `set`, `pick`, `copy`, `rm`, `restore`, `auto`, and `template`.
- **Plugins, daemon & autostart (`plugins_list`, `plugin_manage`, `service_status`, `daemon_manage`, `autostart_manage`, `proxy_status`):**
  - `plugins_list` projects installed/loaded plugins and provider metadata while stripping `accounts[].key` JWTs and raw `accountId` emails.
  - `plugin_manage` supports `add`, `rm`, `update`, `on`, `off`, `options` (validated non-secret JSON; reads project only non-secret options), `use`, `move`, `builtin`, `preset`, `registry` (credential-free HTTP/S URL), and `dump` (public plugin shell: file, preset, api, id, enablement, source, state, and non-secret config). JSON that does not parse is not returned as text.
  - `daemon_manage` (`status | install | uninstall | start | stop | restart | web`) and `autostart_manage` (`status | on | off`) execute only when explicitly called; `service_status` never starts any daemon or reverse proxy automatically.
- **Public settings registry & log file locator (`settings_list`, `settings_get`, `settings_set`, `settings_reset`, `log_locator`):**
  - All settings operations project strictly through `MAGPIE_PUBLIC_SETTINGS_REGISTRY` (`internal/settingsapi/settingsapi.go`); proxy credentials on both `value` and `default` are stripped, `otel` headers are projected as key names only (`writable: false`), and `settings_set` on `proxy` rejects any URL containing `user:pass@` so credentials never enter CLI `argv`.
  - `log_locator` returns openable log file paths and structured file metadata (`exists`, `sizeBytes`, `modifiedAt`) without returning raw log contents.

## Antigravity OAuth client

This plugin does not ship an OAuth client id or secret. Magpie's `accounts refresh` renews Claude and ChatGPT sign-ins only, so an expired Antigravity access token is refreshed here, through that account's saved proxy.

Set both halves outside the repository:

- **Kiki plugin settings** for `magpie-harness-quota`: `antigravityOAuthClientId` (ordinary text) and `antigravityOAuthClientSecret` (`secret: true`). The host injects them into `read({ settings })` for harness quota. The secret is stored with Kiki's plugin secrets, not in this tree.
- **Process environment**, for the standalone collector or a host that passes its environment through: `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET`.

Do not pass either value on a command line. While the saved access token is still valid, neither value is required. If they are missing, only accounts whose tokens are expired come back `unknown`; accounts with a live token are still queried. Several sources keep their own readers, and refreshes of the same token stay single-flight.

## Install (Task92 Host vs Current Kiki `0.4.3` Live Host)

On a Kiki Host build with `@kiki/plugin-sdk/harness-quota` (`x-kiki.harnessQuotaSources`):

```sh
/plugins install --trust ./plugins/magpie-harness-quota
/plugins enable magpie-harness-quota
```

On a current Kiki `0.4.3` Host before `x-kiki.harnessQuotaSources` is promoted, stage the zero-duplicate single-source compatible slice into `.tmp/magpie-harness-quota-compat`. Run it again to refresh that directory: a non-empty directory is replaced only when it already contains this plugin's `.kiki-live-compat-stage.json` marker. Any other non-empty directory, including the default path without that marker, is left unchanged.

```sh
node ./plugins/magpie-harness-quota/scripts/stage-live-compat.mjs
# Installs from ./.tmp/magpie-harness-quota-compat
```
