# Kiki Mail

Read and send mail for the IMAP and SMTP accounts you add. The Mail panel stores passwords and tokens. The chat tools do not accept them.

## Install

This directory already contains the bundled mail runtime in `vendor/`. From a Kiki chat:

```
/plugins install --trust <path-to-kiki-mail>
```

Enable **kiki-mail** and open the **Mail** panel. An offline zip of the same files is `kiki-mail-0.1.1.zip`, produced by `node plugins/kiki-mail/scripts/pack.mjs` from this repository. Installing it does not need another npm install and does not change the public plugin catalog.

Rebuilding that bundle from the lockfile is separate from installing:

```
npm install --ignore-scripts --prefix plugins/kiki-mail
node plugins/kiki-mail/scripts/build-vendor.mjs
```

## Add an account

1. Choose a preset or enter the IMAP and SMTP host, port, and TLS mode yourself.
2. Choose **Password or app password**, or **OAuth2 token**.
3. Enter the secret in the write-only fields and choose **Save**. The fields are cleared. The account line then says whether a password or token is stored. It does not say the server accepted it.
4. Choose **Test**. The status line shows this attempt only.

Cleartext passwords are accepted only when both hosts are loopback (`localhost`, `127.0.0.1`, or `::1`) and **Loopback cleartext** is checked. Any other host needs implicit TLS or STARTTLS.

Presets name common requirements. They are not a completed sign-in.

| Preset | What you still bring |
| --- | --- |
| Gmail | An app password, or your own OAuth client and a refresh token. IMAP must be enabled. Not signed in against Gmail here. |
| Outlook / Microsoft 365 | Many tenants reject basic auth. Bring an access token or a refresh token for your app registration. This panel does not open Microsoft's consent screen. Not signed in against Outlook here. |
| QQ Mail | The authorization code from mailbox settings, not the login password. Not signed in against QQ here. |
| NetEase 163 | An authorization code. Some accounts also expect an IMAP ID command. Not signed in against 163 here. |
| iCloud | An app-specific password. Not signed in against iCloud here. |
| Fastmail | An app password. Not signed in against Fastmail here. |
| Proton Bridge | Proton's own API is not implemented. Run Proton Bridge locally and use its password. Not signed in against Proton here. |

OAuth2 uses a stored access token, or a refresh token together with the client id, client secret, and token URL. There is no browser consent step in this plugin.

## Read and send

**Folders**, **Search**, **Read**, and **Save attachment** use the saved account. Search returns one page, up to 100 messages. The next page uses the cursor. A page is not a limit on the mailbox.

A message identity is the account, folder, UIDVALIDITY, and UID. After UIDVALIDITY changes, the old identity is not reused.

**Read** keeps the message bytes. Short text is inline. Longer text is a preview plus `textPath` or `htmlPath`. Attachments are saved only when you ask, under the plugin data directory.

**Send** and **Reply** submit one SMTP transaction. `accepted` means that server accepted the listed recipients. It is not a delivery receipt. If the connection stops after the message data was written, the result is uncertain and the same send is not repeated. **Send again** is the only control that submits it a second time. A failed login or a rejection before the message data is a definite failure and can be tried again.

Watch is off until you enable both **Watch while Kiki is open** and **Watch this inbox**. New mail is recorded while the plugin is active. Closing or cancelling stops the connection. Nothing is forwarded or answered automatically.

**Forward new mail to a notification channel** is off until you check it and choose a channel from the list. The list comes from Kiki's notification settings. This plugin does not ask for an IM session id and does not store that channel's credentials. A Kiki build without the bridge shows IM as unsupported, and mail still works. If outbound is not up yet, open the panel again after Kiki finishes starting. A preview is included only if you check **Include a short preview**. An unclear send is not forwarded again under a new id. If the channel's route changes, pick the channel again; the plugin does not switch targets by itself.

You can also ask Kiki through `/skill:kiki-mail`. The tools are `plugin__kiki_mail__MailAccount`, `plugin__kiki_mail__Mailbox`, and `plugin__kiki_mail__MailSend`.

Real Gmail, Outlook, QQ, 163, iCloud, Fastmail, and Proton accounts were not used to verify this build. The local checks speak IMAP and SMTP to a loopback fixture only.
