---
name: kiki-mail
description: Read archived or direct mail, search a configured mailbox, save an attachment, send, or reply through Kiki Mail. Use when the user asks to check, find, read, save, send, or reply to mail. Not for documents, chat, or calendar.
---

# Kiki Mail

Use the configured Mail accounts. Passwords, OAuth tokens, and Open Archiver API keys stay in the Mail panel; never ask the user to paste them into chat or put them in tool arguments. The tools are `plugin__kiki_mail__MailAccount`, `plugin__kiki_mail__Mailbox`, and `plugin__kiki_mail__MailSend`.

## Choose the account

- Use `MailAccount` `list` to see configured accounts and capabilities. `Mailbox` without `accountId` uses `defaultReadAccountId`, independent of `defaultAccountId`, the default direct SMTP sender.
- Direct accounts use IMAP for folders/search/read and SMTP for send/reply. A direct account marked `sendOnly` keeps SMTP credentials but suspends direct reading and inbox watch.
- The Mail `open-archiver` preset is one aggregate account across sources, used for reading. In the Mail panel, enter its service URL and read-only API key, test, and save. The key is write-only and requests use `X-API-KEY`, never Basic authentication.

## Open Archiver flow

1. Use `Mailbox` `sources` to list ingestion sources when the user needs to choose one.
2. Use `search` across the archive. Pass `sourceIds` and/or `mailboxes` as arrays; `mailboxes` are archived mailbox-owner addresses, not IMAP folders. Reuse `nextCursor` as `cursor` with the same account, page size, and filters.
3. Read a search hit with its `accountId` and `archiveId`. Save an attachment with the same IDs and the `attachmentId` returned by `read`: `eml:<partId>` identifies a parsed EML part and `stored:<recordId>` identifies an Open Archiver stored record.
4. If `textComplete` or `htmlComplete` is false, use `textPath` or `htmlPath` for the complete body. Use attachment `path` for complete saved bytes.

The Open Archiver account in Mail has no `folders`, `unseen`, `watch`, `send`, or `reply` action. Do not substitute IMAP or SMTP when one of these archive operations is unsupported or fails; select a direct account when the user wants that capability. Never pass IMAP `uid`, `uidValidity`, or `partId` for an Open Archiver identity.

## Direct Mail flow

- `Mailbox` `folders`, `search`, `read`, and `attachment` use direct IMAP. Search returns one page of 1–100 messages; use its cursor for the next page. Identify a message by `accountId`, folder, `uidValidity`, and `uid` together. A changed UIDVALIDITY makes the old identity unusable.
- Inline body fields may be previews. Use `textPath`, `htmlPath`, or returned attachment `path` for complete content.
- `MailSend` `send` or `reply` submits one SMTP transaction. Send only when the user asked. `accepted` means SMTP accepted the listed recipients, not that delivery is complete.

If a send is cancelled or loses connection after message data was written, stop with the uncertain result. Keep the same account and `requestId`; do not send again, including with `confirmResend`. Retry only a definite failure before submission. A receipt failure after SMTP acceptance is still accepted and is not resent. An Open Archiver hit is not a direct IMAP reply identity.

## Notifications

New-mail forwarding is off unless the user enabled it for that direct mailbox and chose a listed notification channel. It targets that channel, not this chat/session or a webhook. Do not forward autonomously or copy notification credentials into Mail. Reuse the same idempotency key after an accepted or unknown result; never retry under a new key. If the route changes, refresh the list and ask the user to choose again. If notifications are unsupported or unavailable, report that; it does not change the mail operation.

Do not claim an account is connected from a preset or an unrun test. Report the actual result and the next user action when setup, authentication, a route, or a complete body/attachment path is missing.
