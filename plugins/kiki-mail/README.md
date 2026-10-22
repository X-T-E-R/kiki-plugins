# Kiki Mail

Read and send mail for the IMAP and SMTP accounts you add. The Mail panel stores passwords and tokens. The chat tools do not accept them.

## Install

This directory already contains the bundled mail runtime in `vendor/`. From a Kiki chat:

```
/plugins install --trust <path-to-kiki-mail>
```

Enable **kiki-mail** and open the **Mail** panel. An offline zip of the same files is `kiki-mail-0.2.3.zip`, produced by `node plugins/kiki-mail/scripts/pack.mjs` from this repository. Installing it does not need another npm install and does not change the public plugin catalog.

Rebuilding that bundle from the lockfile is separate from installing:

```
npm install --ignore-scripts --prefix plugins/kiki-mail
node plugins/kiki-mail/scripts/build-vendor.mjs
```

## Manage accounts in Mail

Open **Mail**. The project section is where a Gmail or Outlook OAuth app is entered once. Each mailbox then needs a provider, address, display name, and note. It does not ask for another client ID. Several Gmail mailboxes stay in one group. Each row shows whether credentials are saved, the last connection test and its time, and whether it is the default sender. Test, edit, delete, set default, or open the mailbox from that row.

Choose **New account**, then provider, address, and either an app password or OAuth. OAuth generates a link. Copy it and open it in your own browser. Mail does not open a browser. When the provider returns to the loopback listener, or you paste the callback URL, Mail exchanges the code, tests IMAP and SMTP, and saves only if that test succeeds. A button click is not authorization.

The test authenticates IMAP and SMTP without sending a message. Secret fields clear after the test or successful save and never show stored values. **Clear saved credentials** removes that mailbox's password or tokens. **Clear secret** on the project removes only the project client secret. Those two stores are not mixed. Cancel discards an unsaved draft. Editing a label, note, or server field does not require pasting a saved password again.

A mailbox that already has its own OAuth client keeps it. The project app is only the default for mailboxes that do not. Changing the project client or secret applies to those inheriting mailboxes on the next connection. A refresh token from the previous client is not sent to the new client; that mailbox shows that it needs authorization again. An in-flight link or test cannot be saved after the project changes.

**Watch while Kiki is open** applies to every mailbox. **Watch this inbox**, notification forwarding, the short preview, and the channel apply only to the mailbox you are editing. The connection timeout is also per mailbox.

Plugin settings keep the global watch switch and point back to Mail. Account, credential, and project values stay `hidden: true` and the project value stays a secret. Older hosts that do not implement hidden settings still display them. Do not edit those fields. Their existing storage keys and secret designation are unchanged.

Cleartext authentication is allowed only when both hosts are loopback (`localhost`, `127.0.0.1`, or `::1`) and **Loopback cleartext** is checked. Other hosts need implicit TLS or STARTTLS.

| Provider | Authorization |
| --- | --- |
| Gmail | An app password, or the Mail project's Google OAuth client. |
| Outlook / Microsoft 365 | The Mail project's Entra app, with IMAP/SMTP permissions and a loopback redirect. The tenant may need to allow SMTP AUTH. |
| QQ / NetEase 163 | The authorization code generated in mailbox settings, not the login password. IMAP ID name/version are sent automatically and can be customized. |
| iCloud / Fastmail | An app-specific password. |
| Proton Bridge | A running local Bridge and its password. Proton's own API is not used. |

### Gmail and Outlook setup

Gmail can use an app password on each mailbox: turn on 2-Step Verification, create an app password, and paste it. The panel copies the App passwords link.

OAuth is the other Gmail path, and the required path for Outlook. Create one OAuth client for the Mail project, not one per mailbox.

- Google Cloud Console: an OAuth client of type Desktop. Paste the client ID and client secret under **Gmail app**. If the client is still in Testing, add each mailbox address as a test user. Mail reads and sends with the IMAP/SMTP scope; this build has not completed a real Google consent screen.
- Microsoft Entra: register an application, create a client secret, and add delegated `IMAP.AccessAsUser.All`, `SMTP.Send`, and `offline_access`. The tenant may also have to allow SMTP AUTH. Paste the application ID and secret under **Outlook app**. If Entra requires the redirect URI, use the loopback URI shown next to that mailbox's link. This build has not completed a real Microsoft consent screen.

Choose **OAuth**, then **Generate authorization link**. Copy the link and open it yourself. The plugin does not open or focus a browser. A listener on `127.0.0.1` accepts the callback for two minutes. **Check authorization** only reports the listener. If the browser cannot reach it, paste the complete callback URL, or the code together with the returned state. Mail checks the state and PKCE, exchanges the code, tests IMAP and SMTP, and saves only when that test succeeds. After a timeout or a rejected exchange, generate a new link.

Tokens are stored for that mailbox only. The project client secret is not copied into the mailbox. Expiring tokens refresh automatically, including refresh-token rotation. A public client can omit the secret. Transient refresh failures retry twice. Revoked authorization, or a project client that no longer matches the saved token, needs a new link. Existing tokens can still be pasted under **Paste existing tokens**. An access token without a refresh token must be replaced when it expires.

If the browser runs on a different machine from Kiki, paste the callback. The listener belongs to the machine running the plugin. No new browser host API is required.

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
