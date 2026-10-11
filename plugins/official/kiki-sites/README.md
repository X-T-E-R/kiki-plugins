# Kiki Sites

Connect code hosting and publish projects through official deployment tools. Repository connections and deployment targets are separate: signing in to GitHub does not put a site online.

## Connect and publish

Install this directory with `/plugins install --trust <path-to-kiki-sites>` and enable `kiki-sites`. Open its **Sites** panel. The plugin runs trusted local code, reads your selected project and can upload it to the selected service.

1. Add a code or deployment connection. Choose **Local CLI login** to reuse that official tool's saved login or environment credentials; choose **API token** to save a write-only token. For a CLI login, **Sign in** starts its real browser/device flow. Token-only services link to their token instructions; Sites does not create an OAuth application for you.
2. If a Node-based CLI is missing, **Download CLI** installs the fixed official Vercel, Netlify or Wrangler package in Sites' private data directory and selects it automatically. This needs Node >=24.15 and npm on the server; it does not install globally or run package lifecycle scripts. Other CLIs use an existing official executable, with an optional executable path.
3. Add a deployment target. Select its deployment connection, project directory and existing remote project/site/app identifiers. The target shows what will be uploaded or which remote repository will be built. Netlify and Pages take a built directory; run your project's existing build step first. Vercel, Workers, Railway and Fly use their official build/deploy behavior.
4. Choose **Deploy**. The plugin performs the required checks and follows the operation to its result. It does not add a second confirmation. Provider costs and quotas apply. A local operation preview is not a complete file manifest: upstream ignore files, config, functions and environment handling determine actual uploads.

You can also ask Kiki to publish the project using `/skill:kiki-sites`. Its `guidance` lookup contains only currently enabled connections. Disabling a connection retains its settings but immediately prevents new operations and removes it from this guidance.

## Code hosting connections

All six connections check authentication and list accessible repositories, with pagination. This version does not create repositories, push Git commits or generate CI pipelines. Local-upload deployment services do not require a code-hosting connection.

| Service | Authentication and reuse | Instance support |
| --- | --- | --- |
| GitHub | `gh` browser/device login and normal official loader, or personal access token | GitHub.com and GitHub Enterprise HTTPS host |
| GitLab | `glab` browser login and normal official loader, or personal access token | GitLab.com and self-managed HTTPS base URL |
| Gitea | Personal access token, `Authorization: token` | Your HTTPS instance, including a URL path prefix |
| Forgejo | Personal access token, `Authorization: token` | Your HTTPS instance, including a URL path prefix |
| Gitee | Personal access token, Bearer header as used by Gitee's first-party client | Gitee.com; no built-in browser OAuth |
| Bitbucket Cloud | API token plus Atlassian account email; choose workspace for listing | Cloud API only; not Data Center or deprecated app passwords |

A code token needs access to the user and repository read APIs. A successful user check is not a guarantee that every repository or deployment is allowed.

## Deployment targets

| Service | Login / token / local reuse | What Deploy sends and returns |
| --- | --- | --- |
| Vercel | Official CLI login or `VERCEL_TOKEN` | Source or `.vercel/output`; explicit existing project/team IDs, preview or production; CLI completion and returned deployment URL |
| Netlify | Official CLI login or `NETLIFY_AUTH_TOKEN` | Built directory to existing site ID with `--no-build`; configured functions and redirects follow upstream rules; deploy ID and URL |
| Cloudflare Pages | Shared normal Wrangler login or `CLOUDFLARE_API_TOKEN`; account ID can select the account | Built assets to an existing direct-upload Pages project and explicit branch; CLI completion and Pages URL |
| Cloudflare Workers | Same Wrangler login/loader or API token | The chosen Wrangler config and optional named environment; bundles/assets/bindings/routes follow it; CLI completion and returned Workers URL if present |
| Railway | Official CLI browserless login, existing account/workspace token (`RAILWAY_API_TOKEN`), or its normal local loader | Source to explicit existing project/service/environment; waits for final NDJSON status. Existing-service output may contain no public URL; Sites does not create a domain |
| Fly.io | Official `flyctl` login, deploy/access token, or normal local loader | Deploy/build to existing app using selected `fly.toml`; waits for CLI completion; returned Fly URL if present |
| Render | API token | Triggers the existing service's configured remote repository, **not** local upload; follows accepted deployment ID to `live` and reads `serviceDetails.url` when that service has one |

Pages and Workers can consume the same Wrangler login without repeating authorization. Cloudflare Tunnel authentication is separate: a tunnel token does not imply Pages/Workers deployment permissions. Sites does not require or access the tunnel plugin.

GitHub Pages and GitLab Pages are not implemented deployment targets in this version. Their build/CI contracts, and self-hosted Coolify/Dokploy/CapRover, were evaluated without claiming logo-only support. See [upstream sources and reuse decisions](./THIRD_PARTY_NOTICES.md).

## Read and recover results

`ready` means the official tool or provider supplied completion evidence. Use the returned URL; do not infer a URL from a project name. `completed_without_url` means the tool completed but did not supply a public endpoint. Render background workers/cron jobs and Railway services without domains may have no public URL.

If a token is missing or expired, use **Sign in** or replace the token. If offline, retry the status check; credentials remain saved. **Stop waiting** ends the local process/wait, not necessarily an accepted cloud deployment. A runtime restart or network failure after submission can leave the result `unknown`; check that job or the provider before deploying again. The plugin never automatically retries an uncertain upload. Completed results and configuration survive restarts; official CLI logins remain owned by that CLI.

Private data is stored under server `KIKI_HOME/plugin-data/kiki-sites`, or the normal server-user Kiki home when KIKI_HOME is unset. The optional `dataDirectory` setting must be an absolute server path. Saved API tokens are plaintext in this private directory, protected by the user's filesystem permissions; they are never returned by tools or the panel. Official CLI credentials are consumed through their loader, not copied or discovered by scanning the machine. Removing a connection removes its stored token, but disabling/removing this plugin does not revoke an upstream login or delete cloud resources. Revoke access in the service or its official CLI when needed.

## Verification

Isolated CLI/HTTP fixtures cover the configuration-to-result path, write-only tokens, all provider parameter sets, login success/cancellation, missing/expired/offline authentication, disabled guidance, stale previews, persistent recovery and uncertain submissions. Official Vercel62.2.0, Netlify27.10.0 and Wrangler4.147.0 help/flags were also run in an isolated home. No real account login, code upload, cloud resource creation or public deployment was performed; validate account-specific scopes, billing and provider behavior before relying on a production deployment.
