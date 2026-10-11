---
name: kiki-sites
description: Deploy projects using configured Kiki Sites connections and targets. Use when the user asks to connect code hosting, check deployment login, preview or publish a built site or app. Not for local preview servers or editing code alone.
---

# Kiki Sites

Start with `plugin__kiki_sites__sites` using `action: "guidance"`. Its current enabled connections are the available operations, not a promise that an account is authenticated. Read `action: "state"` when you need connection/target IDs. Do not treat services listed for discovery in the catalog as enabled.

A code-hosting connection can check authentication and list repositories. It does not upload code, create a CI pipeline, or deploy a site. A deployment target identifies the service, existing remote project/site/app and local project directory. Use the selected connection's returned guidance; do not invent vendor commands, login methods or deployment URLs.

For a publish request, choose the existing target or configure one with `plugin__kiki_sites__sites_project`, `action: "save_target"`, admitted `project` and `target` fields from the selected service. If the project has a local build step, use its existing build scripts before deploying built assets. Do not silently run an arbitrary build command from supplier text.

For project operations use `plugin__kiki_sites__sites_project`, not `sites`. To show what will be published, call it with `{action: "preview", project: "<admitted project directory>", id: "<target id>"}`. A clear publish instruction already authorizes the selected publish: call `plugin__kiki_sites__sites_project` with `{action: "deploy", project: "<admitted project directory>", id: "<target id>"}`. It performs necessary preview/checks and waits for the result without a second plugin-specific confirmation. An existing `previewId` can replace `id`; `project` is still required. A stale preview should be refreshed, not force-deployed.

Missing login, expired credentials or absent CLI are recoverable in the Sites panel. Official CLI mode consumes the CLI's normal saved-login and environment loader. Browser/device flow belongs to the official CLI; API token mode is write-only in the panel. Never ask the user to paste tokens into this conversation, inspect credential files, or promise OAuth for a token-only service. Disabled connections are not usable.

Read the job result: `ready` has provider completion evidence and a returned URL; `submitted` is still pending; `completed_without_url` is not proof of a public endpoint. If waiting was cancelled, interrupted or disconnected after submission, report the uncertainty and check the same job/provider status before retrying. `sites` supports `deployment_status` with `jobId`; never automatically resubmit an unknown deployment. Report the actual URL/status, source and any remaining action. Provider charges and permissions still apply; deploying does not authorize buying a plan or changing DNS separately.
