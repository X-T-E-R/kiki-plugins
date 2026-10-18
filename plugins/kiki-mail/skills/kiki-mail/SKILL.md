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

If the outcome is `uncertain`, or the code is `uncertain_send`, `uncertain_not_resent`, or `already_accepted`, stop. The same account and `requestId` is not sent again, including with `confirmResend`. Retry only when the earlier attempt is a definite failure before the message data was submitted, such as authentication failure or rejection. Do not invent a second send after a timeout or cancellation once the data was written.

Inline `text` or `html` can be a preview (`textComplete` or `htmlComplete` is false). Use `textPath`, `htmlPath`, or the attachment `path` for the complete bytes. Do not describe a preview as the whole message.

New-mail forwarding uses the host bridge on the app activate context: `capabilities`, `listRoutes`, and `send` with `channelId`, `routeRevision`, `idempotencyKey`, `accountRef`, and `text`. Do not add `pluginId`. `text` is counted in UTF-8 bytes, from 1 through 16384. The plugin does not truncate it. Empty or control-bearing text is `bad_format`. A longer digest is `too_long`, is not sent, and is not stored, so a shorter digest may use the same key. It is off until the user enables it and chooses a listed channel. The target is that channel, not a Kiki session. Do not substitute the current chat, `focusSession`, `session.sendMessage`, or a webhook, and do not copy IM credentials into mail settings. `im_unsupported` means this host has no bridge; mail still works. `outbound-unavailable` means the process cannot send yet, so probe again before the next send. `accepted` and `unknown` keep the same idempotency key and are not forwarded again. `route_changed` means refresh the route list and wait for the user to choose again.

Provider presets for Gmail, Outlook, QQ, 163, iCloud, Fastmail, and Proton Bridge are unverified against those services. Say which requirement is still missing instead of claiming the account is signed in. This plugin does not open an OAuth consent screen.
