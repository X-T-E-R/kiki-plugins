# Kiki Mail

Read and send mail for the IMAP and SMTP accounts you add. The Mail panel stores passwords and tokens. The chat tools do not accept them.

## Install

This directory already contains the bundled mail runtime in `vendor/`. From a Kiki chat:

```
/plugins install --trust <path-to-kiki-mail>
```

Enable **kiki-mail** and open the **Mail** panel. An offline zip of the same files is `kiki-mail-0.2.0.zip`, produced by `node plugins/kiki-mail/scripts/pack.mjs` from this repository. Installing it does not need another npm install and does not change the public plugin catalog.

Rebuilding that bundle from the lockfile is separate from installing:

```
npm install --ignore-scripts --prefix plugins/kiki-mail
node plugins/kiki-mail/scripts/build-vendor.mjs
```

## Manage accounts in Mail

Choose **New account**, then follow the provider, address, authorization, test, and save steps. Use a display name and a note (up to 200 characters) to distinguish work, personal, or project inboxes. Accounts are grouped by provider, including several Gmail accounts. Each row shows its default status and last connection test, with actions to test, edit, delete, set default, or open the mailbox.

The test authenticates IMAP and SMTP without sending a message. Successful draft tests keep credentials in memory for up to ten minutes until you save. Secret fields clear after the test or successful save and never show stored values. Cancel discards the draft. Editing non-secret details does not require entering a saved password again.

The panel summary shows account count, default account, watch status, and the most recent test. Plugin settings retain the global watch switch and direct you to Mail. The internal account and credential settings use `hidden: true`; older hosts that do not implement hidden settings still display them. Do not edit those fields. Their existing storage keys and secret designation are unchanged.

Cleartext authentication is allowed only when both hosts are loopback (`localhost`, `127.0.0.1`, or `::1`) and **Loopback cleartext** is checked. Other hosts need implicit TLS or STARTTLS.

| Provider | Authorization |
| --- | --- |
| Gmail | An app password, or your own desktop OAuth client with mail access. |
| Outlook / Microsoft 365 | Your OAuth app registration with IMAP/SMTP permissions and a loopback redirect. The tenant may need to allow SMTP AUTH. |
| QQ / NetEase 163 | The authorization code generated in mailbox settings, not the login password. IMAP ID name/version are sent automatically and can be customized. |
| iCloud / Fastmail | An app-specific password. |
| Proton Bridge | A running local Bridge and its password. Proton's own API is not used. |

### Authorize Gmail or Outlook

Choose **OAuth2**, then **Authorize in your browser**. Enter your client ID and choose **Generate authorization link**. Copy the full link, open it in your own browser, grant access, and return to Mail. The plugin never opens or focuses a browser.

A one-time listener on `127.0.0.1` receives the provider callback for two minutes. Choose **Check authorization** to see the result. If that browser cannot reach the listener, paste its complete callback URL in **Paste a callback instead**, or paste the code together with the returned state. The plugin validates the state and redirect, then exchanges the code with PKCE. A button click or a timeout never counts as authorization. After a timeout or rejected exchange, generate a new link.

Choose **Test now**, then **Save**. Access and refresh tokens use the existing write-only credential storage, separately for each account. Expiring tokens refresh automatically, including refresh-token rotation. Public clients do not require a client secret. Transient refresh failures retry twice; revoked authorization requires signing in again. Existing access/refresh tokens can still be pasted under **Paste existing tokens**. An access token without a refresh token must be replaced when it expires.

If your browser runs on a different machine from Kiki, use the pasted callback path. The listener belongs to the machine running the plugin. No new browser host API is required.

### Custom account declarations

Under **Client identity, folders & declarations**, set IMAP ID `name`/`version`, map `sent`, `drafts`, `trash`, and `archive` to server paths, and add outgoing non-secret `X-` message headers. Folder listings show the mapped roles; searches accept either the role or the exact server path. Mail is not moved or appended automatically.

Hooks are visible, removable data declarations with two allowed actions:

- `beforeConnect / setTimeout`: set the IMAP and SMTP connection timeout to 200-120000 milliseconds.
- `afterSend / recordEvent`: append a named local event after SMTP acceptance. An event-write failure is reported as a warning and never changes acceptance or resends the message.

Commands, scripts, `eval`, authentication headers, line breaks, and unsupported fields are rejected. Chat account tools accept these non-secret declarations and notes, but never passwords or tokens.

## Read and send

**Folders**, **Search**, **Read**, and **Save attachment** use the saved account. Search returns one page, up to 100 messages. The next page uses the cursor. A page is not a limit on the mailbox.

A message identity is the account, folder, UIDVALIDITY, and UID. After UIDVALIDITY changes, the old identity is not reused.

**Read** keeps the message bytes. Short text is inline. Longer text is a preview plus `textPath` or `htmlPath`. Attachments are saved only when you ask, under the plugin data directory.

**Send** and **Reply** submit one SMTP transaction. `accepted` means that server accepted the listed recipients. It is not a delivery receipt. If the connection stops or the send is cancelled after the message data was written, the result is uncertain and that send is not repeated. **Send again** appears only for a definite failure before the data was submitted. An accepted message whose local receipt cannot be saved stays accepted and is not sent again.

Watch is off until you enable both **Watch while Kiki is open** and **Watch this inbox**. New mail is recorded while the plugin is active. If the connection drops while Kiki stays open, watch tries again: the wait starts at one second and doubles up to one minute, then returns to one second after the mailbox opens. A failed login or STARTTLS stops watch. Closing Kiki, cancelling, or turning watch off stops it immediately. Nothing is forwarded or answered automatically.

**Forward new mail to a notification channel** is off until you check it and choose a channel from the list. The list comes from Kiki's notification settings. This plugin does not ask for an IM session id and does not store that channel's credentials. A Kiki build without the bridge shows IM as unsupported, and mail still works. If outbound is not up yet, open the panel again after Kiki finishes starting. A preview is included only if you check **Include a short preview**. An unclear send is not forwarded again under a new id. If the channel's route changes, pick the channel again; the plugin does not switch targets by itself.

You can also ask Kiki through `/skill:kiki-mail`. The tools are `plugin__kiki_mail__MailAccount`, `plugin__kiki_mail__Mailbox`, and `plugin__kiki_mail__MailSend`.

Real Gmail, Outlook, QQ, 163, iCloud, Fastmail, and Proton accounts were not used to verify this build. The local checks speak IMAP and SMTP to a loopback fixture only.
