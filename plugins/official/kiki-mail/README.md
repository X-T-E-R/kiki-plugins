# Kiki Mail

Read and send mail through direct IMAP and SMTP accounts, or read archived mail through Open Archiver. Keep passwords, tokens, and API keys in the Mail panel, not chat or tool arguments.

## Install

This directory includes the bundled mail runtime in `vendor/`. From a Kiki chat, install it with:

```
/plugins install --trust <path-to-kiki-mail>
```

Enable **kiki-mail** and open the **Mail** panel. Build an offline package with `node plugins/official/kiki-mail/scripts/pack.mjs`. Rebuilding the bundle from the lockfile is separate from installing:

```
npm ci --ignore-scripts --prefix plugins/official/kiki-mail
node plugins/official/kiki-mail/scripts/build-vendor.mjs
```

## Manage accounts in Mail

For direct mailboxes, choose **New account**, then a provider, address, display name, and note. The Mail project holds a shared Gmail or Outlook OAuth app for mailboxes that do not already have their own client. Each row shows saved-credential status, the latest test, and whether the account is the default reader or default SMTP sender. Test, edit, delete, change a default, or open the mailbox from that row.

A connection test authenticates the account without sending mail. Secret fields clear after testing or saving and never show stored values. **Clear saved credentials** removes a direct mailbox's password or tokens, or an Open Archiver account's API key. **Clear secret** on the project removes only its client secret. Cancel discards an unsaved draft. Editing a label, note, or server field does not require entering the saved password again.

A mailbox that already has its own OAuth client keeps it. The project app is the default only for mailboxes without one, and its client secret is not copied into a mailbox. Changing the project client or secret applies to those mailboxes on their next connection; a refresh token from the previous client is not sent to the new client, so that mailbox needs authorization again. An in-flight link or test cannot be saved after the project changes.

**Watch while Kiki is open** is global. **Watch this inbox**, notification forwarding, its preview, channel, and connection timeout apply only to that direct mailbox. Plugin settings keep the global watch switch and point back to Mail. Account, credential, project, and default-account values are hidden; credentials and the project value are also marked secret. Do not edit those settings directly.

Cleartext authentication is allowed only when both direct IMAP and SMTP hosts are loopback (`localhost`, `127.0.0.1`, or `::1`) and **Loopback cleartext** is checked. Other hosts need implicit TLS or STARTTLS.

| Provider | Authorization |
| --- | --- |
| Gmail | An app password, or the Mail project's Google OAuth client. |
| Outlook / Microsoft 365 | The Mail project's Entra app, with IMAP/SMTP permissions and a loopback redirect. The tenant may need to allow SMTP AUTH. |
| QQ / NetEase 163 | The authorization code generated in mailbox settings, not the login password. IMAP ID name/version are sent automatically and can be customized. |
| iCloud / Fastmail | An app-specific password. |
| Proton Bridge | A running local Bridge and its password. Proton's own API is not used. |

### Gmail and Outlook setup

For Gmail, turn on 2-Step Verification and create an app password, or create one OAuth client for the Mail project. For OAuth, paste the client ID and secret under **Gmail app**. If the client is still in Testing, add each mailbox address as a test user. This build has not completed a real Google consent screen.

Outlook requires OAuth. Register an application in Microsoft Entra, create a client secret, and add delegated `IMAP.AccessAsUser.All`, `SMTP.Send`, and `offline_access`. The tenant may also need to allow SMTP AUTH. Paste the application ID and secret under **Outlook app**. If Entra requires a redirect URI, use the loopback URI shown next to the mailbox's link. This build has not completed a real Microsoft consent screen.

Choose **OAuth**, then **Generate authorization link**. Copy the link and open it in your own browser; the plugin does not open one. A listener on `127.0.0.1` accepts the callback for two minutes. **Check authorization** only reports the listener. If the browser cannot reach it, paste the complete callback URL, or the code with its returned state. Mail checks state and PKCE, exchanges the code, tests IMAP and SMTP, and saves only when that test succeeds. After a timeout or rejected exchange, generate a new link.

Tokens are stored for that mailbox and refresh automatically, including refresh-token rotation. A public client can omit its secret. Transient refresh failures retry twice. Revoked authorization or a project client that no longer matches the saved token needs a new link. Existing tokens can also be entered under **Paste existing tokens**; an access token without a refresh token must be replaced when it expires. If the browser is on another machine, paste the callback: the listener belongs to the machine running the plugin.

### Custom account declarations

Under **Client identity, folders & declarations**, set IMAP ID `name`/`version`, map `sent`, `drafts`, `trash`, and `archive` to server paths, and add outgoing non-secret `X-` message headers. Folder listings show mapped roles; searches accept either a role or the exact server path. Mail does not move or append messages automatically.

Hooks are removable declarations with two allowed actions:

- `beforeConnect / setTimeout`: set the IMAP and SMTP connection timeout to 200–120000 milliseconds.
- `afterSend / recordEvent`: append a named local event after SMTP acceptance. An event-write failure is reported as a warning and never changes acceptance or resends the message.

Commands, scripts, `eval`, authentication headers, line breaks, and unsupported fields are rejected. Chat account tools accept non-secret declarations and notes, but never passwords or tokens.

## Connect Open Archiver

Choose the **Open Archiver** preset in the Mail panel and enter its service URL and read-only API key. Use HTTPS unless the service is on loopback; do not include credentials, query parameters, or a fragment in the URL. Test the connection, then save. The API-key field is write-only and clears after testing or saving. Open Archiver uses an API key, not Basic authentication; do not put credentials in chat or tool arguments.

One Open Archiver account reads the aggregate archive across its ingestion sources. It does not represent one source or one IMAP mailbox. Its default-reader setting is independent of the default SMTP sender: choosing Open Archiver for reading does not change which direct account sends mail.

## Read and send

The tools are `plugin__kiki_mail__MailAccount`, `plugin__kiki_mail__Mailbox`, and `plugin__kiki_mail__MailSend`. `MailAccount` lists configured accounts and capabilities; a provider preset names requirements but does not mean sign-in succeeded. `test` reports that connection attempt only.

`Mailbox` without `accountId` uses the default reader. For Open Archiver, use `sources` to list ingestion sources, `search` to find mail across the archive, `read` to load a hit, and `attachment` to save an attachment. Search can use `sourceIds` and `mailboxes` arrays; `mailboxes` means the archived mailbox owner, not an IMAP folder. Without filters, search spans all sources. Reuse the result's `nextCursor` as `cursor` with the same account, page size, and search filters.

Read an Open Archiver hit with its `accountId` and `archiveId`, then save an attachment with the same IDs and the `attachmentId` returned by `read`. Attachment IDs identify either an EML MIME part (`eml:<partId>`) or an Open Archiver stored record (`stored:<recordId>`). Open Archiver identities use `archiveId`, never an IMAP UID or UIDVALIDITY. The Open Archiver account in Mail exposes no folders, unseen status, sending, replying, or inbox watch. These operations do not fall back to a direct account; select a direct account for them.

For direct IMAP, **Folders**, **Search**, **Read**, and **Save attachment** use the chosen account. Search returns one page of up to 100 messages; pass `cursor` for the next page. Identify a direct message by account, folder, UIDVALIDITY, and UID together. After UIDVALIDITY changes, do not reuse the old identity. Direct replies require that direct IMAP identity; an Open Archiver hit is not a reply identity.

Inline message text or HTML can be a preview. When `textComplete` or `htmlComplete` is false, use `textPath` or `htmlPath` for the complete body. Attachments are saved only when requested, under the plugin data directory; use the returned `path` for the complete attachment.

`MailSend` sends or replies through a direct account's SMTP server. Send only when the user explicitly asks. `accepted` means SMTP accepted the listed recipients, not that the message was delivered. If a send times out or is cancelled after message data was written, its outcome is uncertain: keep the same account and `requestId` and do not send it again, including with `confirmResend`. Retry only a definite failure before message data was submitted. An accepted message whose local receipt cannot be saved stays accepted and is not sent again. A direct account marked **Send-only** keeps its SMTP credentials while direct reading and watch are suspended.

Inbox watch is off until both **Watch while Kiki is open** and **Watch this inbox** are enabled. Watch runs only for a direct mailbox while the plugin is active; after a dropped connection it retries from one second, doubling up to one minute, and resets after the mailbox opens. A failed login or STARTTLS stops watch; close, cancellation, or switching it off stops it immediately. Mail is never forwarded or answered automatically.

Notification forwarding is also off until enabled for a direct mailbox and a listed notification channel is chosen. It targets that channel, not this chat or a Kiki session; Mail does not store channel credentials. A short preview is optional. If a route changes, ask the user to choose a listed channel again. Do not retry an `accepted` or `unknown` notification under a new idempotency key, or substitute another channel. If the host has no notification bridge or outbound is not ready, report that status; mail still works.

## Move direct readers to Open Archiver

Only an authorized operator should run this migration procedure after the Mail build with Open Archiver support is installed in Kiki and the destination is approved. Its commands contact local Kiki and Open Archiver and can create or reconnect sources.

Run `node plugins/official/kiki-mail/scripts/migrate-open-archiver.mjs` from the repository root. Every invocation needs the options for the running local Kiki owner: `--home <kiki-home> --session <session-id> --kiki <kiki-executable>`. Replace placeholders; never pass a key or secret itself on the command line. The `*-key-file` options take approved JSON file paths.

1. `inventory` lists configured account types, saved-credential presence, watch/send-only state, and the default reader and sender. Select only direct, readable accounts with a saved password and verified implicit IMAP TLS. OAuth accounts are not migrated; authorize them separately in Open Archiver. Existing Send-only accounts are not readers to migrate.
2. `connect --url https://archive.example.test --read-key-file <approved-key-file>` tests and saves the Open Archiver account through Mail. Replace the example URL with the approved service URL. This command uses only `readonly_user.api_key` from the approved JSON file. Choose an archive account ID with `--archive-account` if needed. Save no Basic credentials.
3. `prepare --archive-account <archive-account-id> --accounts <direct-account-id,...>` creates a local permit bound to the selected original accounts and destination. Its recovery metadata is kept under Mail's private data with owner-restricted filesystem permissions. Keep the returned plan ID private; the permit expires after seven days.
4. For each selected account, run `migrate --plan <plan-id> --account <direct-account-id> --admin-key-file <approved-key-file>`. This command uses only `admin_user.api_key` from the approved JSON file; use a separate management key, not the read-only key. The permit allows source creation only for its bound accounts and destination. It creates `generic_imap` with `preserveOriginalFile: true`, `secure: true`, and `allowInsecureCert: false`. A matching source is reused only when its mailbox owner matches or this permit already maps its source ID; unresolved same-name or owner mismatches stop for reconciliation. The service reads a saved password from Mail's private settings; the password is not included in the permit or public account/tool output. Open Archiver must reauthorize OAuth accounts; Mail does not copy OAuth tokens. Open Archiver reads original source bodies with `BODY.PEEK[]` and does not issue `STORE`, `MOVE`, or `DELETE` against source messages.
5. Wait for Open Archiver to ingest and index the source, then run `verify --plan <plan-id> --account <direct-account-id> [--archive-id <archiveId>]`. Without `--archive-id`, the CLI chooses available archived samples. Verification compares Message-ID, date, text, HTML, and each attachment's name, type, bytes, and occurrence count against the direct mailbox opened read-only with IMAP EXAMINE. It accepts both original EML and OA's detached-attachment mode, including independently stored inline parts that also remain in the EML. `verifiedAttachments` counts source attachments, not duplicate MIME/storage representations. Verification does not write message flags.
6. Run `reconnect --plan <plan-id> --account <direct-account-id> --admin-key-file <approved-key-file>` for each source. Check `status --plan <plan-id> --read-key-file <approved-key-file>` until every selected source reports `ready: true`: active status, matching mailbox owner, all archived messages indexed, verified samples, and a reconnect started after the request and finished after it started. The status command uses only `readonly_user.api_key` from the approved JSON file.
7. Run `cutover --plan <plan-id> --read-key-file <approved-key-file>` only when every source is ready and the original accounts still match the permit. Cutover sets the Open Archiver account as default reader and marks selected direct accounts Send-only; it preserves their SMTP credentials and the separate default sender. The CLI sends no mail. Cutover updates Kiki account settings; it does not delete Open Archiver sources.

If `migrate` reports `migration_source_rejected`, OA returned a recognized connection rejection after rollback and Mail confirmed no matching source exists. Correct the saved mailbox authorization or server connection, then rerun the same `migrate` command and plan. Only this confirmed failed attempt is released for retry. Other HTTP 400 responses, timeouts, proxy errors, or a failed source reconciliation keep the attempt blocked: inspect the source in Open Archiver before continuing, and do not delete its private attempt record to force a retry. If the source exists, rerunning `migrate` reconciles and reuses it without another create.

`restore --plan <plan-id>` restores the selected direct accounts' prior Send-only settings and the permit's original default reader. It does not delete Open Archiver sources.

Repository checks use local fixtures. Live source migration and cutover are separate authorized operator actions.
