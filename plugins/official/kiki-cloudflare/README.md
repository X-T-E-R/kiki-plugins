# Cloudflare Tunnel for Kiki

Connect remote spaces through Cloudflare without installing an operating-system service. The plugin runs the official `cloudflared` connector as a Kiki-owned process; the plugin archive does not contain a binary. It is a connection capability, not a model provider.

Requires a Kiki build with App-plugin lifecycle support. For development builds, enable `KIKI_EXPERIMENTAL_PLUGIN_APP_LIFECYCLE=1`; released support must work without that extra setup. Catalog publication requires the matching Host, SDK and panel integration.

## Connect

1. Install and enable the plugin. If cloudflared is missing, choose **Install cloudflared**. The plugin downloads a SHA256-checked 2026.10.0 binary into Kiki's plugin data directory; it does not change PATH, register a Windows service, or add an OS startup item. An existing compatible cloudflared on PATH or an explicit executable path is reused.
2. For a new tunnel, choose **Create tunnel in Cloudflare**. Cloudflare's official dashboard handles creation, published hostname, origin service and any plan choices. Return with the connector token. For an existing tunnel, paste its token, choose a token file, or use **Browser login** to reuse/select a tunnel under your account.
3. Choose **Save and connect**. A running indicator appears only after cloudflared's local readiness endpoint reports a connection. Use the public HTTPS endpoint with Kiki's existing remote-space connection flow; keep Kiki's authentication and identity handshake enabled.

Configured tunnels start with Kiki by default. **Stop** pauses this run but keeps **Start with Kiki** unchanged. Turning that preference off prevents the next automatic start; it does not stop an already running tunnel. **Start** works with automatic start off. Disabling, updating or removing the plugin, and closing Kiki, stops the owned connector. No other cloudflared process is stopped. Cloudflared handles network reconnection; unexpected connector exits get five bounded retries before the panel offers a manual retry.

## Credentials

- A **tunnel connector token** runs one remotely-managed tunnel. It is not an account API credential and does not need browser login.
- **Browser login** is official `cloudflared tunnel login`, not a new Kiki OAuth client. It creates the account-wide `cert.pem` in the server user's `.cloudflared` directory. Existing certificates are reused and never overwritten. The certificate permits account tunnel management; it is more powerful than a tunnel token.
- An existing **local tunnel config + UUID** runs a locally-managed tunnel. The config can refer to its existing tunnel credentials JSON; an explicit credentials path is also supported. Selecting by UUID does not require the account certificate just to run.
- An optional **Cloudflare API token + account ID** supports account/tunnel selection through the Cloudflare API. Permissions must include the requested account/tunnel operations. Workers/Pages permissions are separate. Kiki stores token fields through its existing write-only plugin settings; the plugin never returns them in panel status or process arguments.

Certificate and token-file paths are on the Kiki server, not necessarily the machine displaying the GUI. The login link can be opened on the GUI machine if cloudflared's automatic browser opening happens on a remote server. Removing this plugin does not revoke Cloudflare credentials or delete cloud resources; revoke tokens in Cloudflare when needed.

Cloudflare carries traffic and is not Kiki end-to-end encryption. A public hostname can make its origin reachable through Cloudflare; do not expose an unauthenticated service. Cloudflare plans, domains and service terms remain the user's choices.

## Verification boundary

Directed tests use synthetic tokens/certificates, a local HTTP readiness server and owned Node process fixtures. The private Host candidate is exercised with real plugin installation, managed-copy discovery, settings calls and lifecycle RPC. No real account login, cloud resource creation, DNS modification or public exposure has been performed. The official dashboard route is the product's creation path, not a claim that development created a tunnel.

## Sources and adoption

Sources inspected on 2026-10-06:

- [cloudflared CLI run/token-file/list/ready commands](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/subcommands.go), [browser certificate login](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/login.go), and [certificate versus tunnel credential permissions](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/tunnel-permissions/). **Reuse** the official binary and CLI rather than implementing a tunnel protocol. cloudflared is [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/master/LICENSE); its releases and dependencies retain their own notices.
- [Wrangler cloudflared management](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/cloudflared.ts) and [tunnel run lifecycle](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/tunnel/run.ts). **Adapt the interaction/process pattern**: existing executable first, deliberate download, token through environment rather than command line, graceful termination then forced termination. The small Kiki adapter uses Node primitives and fixed verified release assets, not Wrangler's large dependency graph, interactive CLI, latest-version checksum fallback or global cache. This keeps maintenance limited to CLI compatibility and the release asset table. Workers SDK is dual [MIT](https://github.com/cloudflare/workers-sdk/blob/main/LICENSE-MIT)/[Apache-2.0](https://github.com/cloudflare/workers-sdk/blob/main/LICENSE-APACHE).
- [Wrangler account auth adapter](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/user.ts). **Defer Wrangler OAuth adoption**: its OAuth/client ID/scopes/refresh/keyring are distinct from cloudflared's account certificate. This plugin does not parse or copy Wrangler credentials into a new store, nor pretend that a certificate authorizes Workers/Pages. Future account consumers reuse this connection domain and the real credential type they need.
- [Coolify cloudflared configuration](https://github.com/coollabsio/coolify/blob/main/app/Actions/Server/ConfigureCloudflared.php). **Adapt readiness and restart semantics**, not its Docker/system deployment mechanism: Kiki owns a local child, so importing its remote shell commands, Docker host networking or container orchestration would add a second operational platform. Coolify is [Apache-2.0](https://github.com/coollabsio/coolify/blob/main/LICENSE).
- Fixed download assets/digests: [official 2026.10.0 release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0), [GitHub release metadata](https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.10.0). macOS checks the release archive digest before extracting only its cloudflared file; Windows/Linux check the binary digest. No checksum-free installation fallback.

No source from these donors is redistributed in this plugin. The original Kiki adapter and panel use the included MIT license. See `PANEL-CONTRACT.md` for UI and Host integration details.
