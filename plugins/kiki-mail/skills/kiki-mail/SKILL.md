---
name: kiki-mail
description: Read, search, and send mail through accounts configured in Kiki Mail. Use when the user asks to check a mailbox, find a message, read a body or attachment, reply, or send mail. Not for documents, chat, or calendar.
---

# Kiki Mail

Use the configured accounts. Passwords and tokens stay in the Mail panel. Do not ask the user to paste them into the chat, and do not put them in tool arguments.

The tools are `plugin__kiki_mail__MailAccount`, `plugin__kiki_mail__Mailbox`, and `plugin__kiki_mail__MailSend`.

## What the user asked for

- Accounts, presets, or a connection test: `MailAccount`. `presets` names requirements and is not a completed sign-in. `test` reports that attempt only. `save` rejects passwords and tokens.
- Folders, a page of messages, one body, or one attachment: `Mailbox`. Keep `accountId` on every call. A page size is 1 to 100 and is not a mailbox cap. Use `cursor` for the next page.
- A new message or a reply: `MailSend` with `send` or `reply`. Send only when the user asked to send or reply. Do not forward or auto-reply on your own.

Identify a message by account, folder, UIDVALIDITY, and UID together. A changed UIDVALIDITY means the old identity is a different message. Do not reuse another account's identity.

## Read the result

`accepted` means the SMTP server accepted the named recipients. It is not proof the message was delivered. `finalDelivery` stays false.

If the outcome is `uncertain`, or the code is `uncertain_send` or `uncertain_not_resent`, stop. The same `requestId` is not sent again unless the user explicitly wants another attempt. Then call `MailSend` once more with that `requestId` and `confirmResend: true`. A definite authentication failure or a rejection before the message data can be retried with a new attempt. Do not invent a second send after a timeout once the data was written.

Inline `text` or `html` can be a preview (`textComplete` or `htmlComplete` is false). Use `textPath`, `htmlPath`, or the attachment `path` for the complete bytes. Do not describe a preview as the whole message.

`im` on a watch event is delivered only when a host sender exists. `host-im-unavailable` means this host has no IM bridge. Do not substitute the current chat, `focusSession`, or a webhook. Leave watch and IM off unless the user enabled them.

Provider presets for Gmail, Outlook, QQ, 163, iCloud, Fastmail, and Proton Bridge are unverified against those services. Say which requirement is still missing instead of claiming the account is signed in. This plugin does not open an OAuth consent screen.
