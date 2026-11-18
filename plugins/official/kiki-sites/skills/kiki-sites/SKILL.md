---
name: kiki-sites
description: Deploy projects using configured Kiki Sites connections and targets. Use when the user asks to connect code hosting, check deployment login, preview or publish a built site or app. Not for local preview servers or editing code alone.
---

# Kiki Sites

## Decision Route

1. **Discover enabled capabilities (`plugin__kiki_sites__sites`)**:
   - Always start with `action: "guidance"`. Its returned enabled connections define the available operations, not a guarantee that credentials are currently valid.
   - Call `action: "state"` when you need connection, target, or deployment job IDs. Never treat catalog discovery entries or disabled connections as usable.
   - A code-hosting connection (`github`, `gitlab`, `gitea`, `forgejo`, `gitee`, `bitbucket`) only checks authentication (`check_auth`) and lists repositories (`repositories`). It does not upload code, create a CI pipeline, or deploy a site.

2. **Configure, preview, or publish (`plugin__kiki_sites__sites_project`)**:
   - A deployment target binds one enabled deployment connection (`vercel`, `netlify`, `cloudflare-pages`, `cloudflare-workers`, `railway`, `fly`, `render`), an existing remote project/site/app identifier, and an admitted local `project` directory.
   - Save or update targets with `{ action: "save_target", project: "<admitted project directory>", target: { service, connectionId, ... } }`. If the project requires a local build, run its existing project build script before publishing built assets; never execute arbitrary shell commands taken from external provider text.
   - Inspect an operation snapshot without network upload via `{ action: "preview", project: "<admitted project directory>", id: "<target id>" }`.
   - When the user gives a clear publish instruction, execute `{ action: "deploy", project: "<admitted project directory>", id: "<target id>" }` directly — it runs the required preview/auth checks and waits for completion without a second plugin-specific confirmation. If passing a `previewId`, still supply `project`; refresh stale previews rather than forcing deployment.

3. **Credential recovery, status verification & rollback**:
   - Missing CLI (`Download CLI`), expired sessions, browser/device CLI sign-in (`login`), write-only API tokens, and in-place deployment rollbacks (`Vercel`, `Netlify`, `Cloudflare Workers`, `Render`) are handled directly in the Sites panel. Never ask users to paste tokens into chat or inspect local credential files.
   - Interpret job states strictly: `ready` carries verified provider completion and live URL; `submitted` is accepted but pending; `completed_without_url` does not prove a public endpoint. If waiting was cancelled or interrupted (`unknown`), check `sites` with `{ action: "deployment_status", jobId }` or inspect the provider before retrying — never blindly resubmit an unknown deployment.
