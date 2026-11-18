---
name: kiki-mail
description: Read archived or direct mail, search a configured mailbox, save an attachment, send, or reply through Kiki Mail. Use when the user asks to check, find, read, save, send, or reply to mail. Not for documents, chat, or calendar.
---

# Kiki Mail

Use configured Mail accounts via `plugin__kiki_mail__MailAccount`, `plugin__kiki_mail__Mailbox`, and `plugin__kiki_mail__MailSend`. Passwords, OAuth tokens, and Open Archiver API keys stay write-only inside the Mail panel—never ask the user to paste credentials into chat or pass them in tool arguments.

## Account Selection

- Call `MailAccount` with `action: "list"` to inspect configured accounts and capabilities. `Mailbox` without `accountId` uses `defaultReadAccountId`; `defaultAccountId` selects the default direct SMTP sender independently.
- Direct accounts use IMAP for `folders`, `search`, `read`, and `attachment`, and SMTP for `send` and `reply`. An account marked `sendOnly` retains SMTP while suspending direct reading and inbox watch.
- The `open-archiver` preset searches one aggregate read-only archive over `X-API-KEY` (never Basic auth) and has no `folders`, `unseen`, `watch`, `send`, or `reply` operations. Never pass IMAP `uid`, `uidValidity`, or `partId` to an Open Archiver account.

## Open Archiver Flow

1. Call `Mailbox` `action: "sources"` when listing ingestion sources is needed.
2. Call `Mailbox` `action: "search"` with optional `sourceIds` and `mailboxes` arrays (`mailboxes` are archived owner addresses, not IMAP folders). Reuse `nextCursor` as `cursor` with identical filters.
3. Read a hit using `accountId` and `archiveId`. Save an attachment with `accountId`, `archiveId`, and the `attachmentId` returned by `read` (`eml:<partId>` or `stored:<recordId>`).
4. When `textComplete` or `htmlComplete` is `false`, read `textPath` or `htmlPath` for complete content; use returned attachment `path` for saved bytes.

## Direct IMAP & SMTP Flow

- Identify direct IMAP messages by `accountId`, `mailbox`, `uidValidity`, and `uid` together; if `UIDVALIDITY` changes, re-search before reading.
- Call `MailSend` (`send` or `reply`) only when the user requested sending. `accepted` means the SMTP server accepted the recipients.
- If a send is cancelled or disconnects after SMTP `DATA` begins, the outcome is `uncertain`: keep the same `accountId` and `requestId` and never resend automatically (even with `confirmResend`). Retry only definite pre-submission rejections.

## Inbox Watch & Notifications

- Forwarding runs only when enabled on that direct mailbox with an explicit notification channel selected in the Mail panel. Reuse the same idempotency key on uncertain outcomes; if routes change, ask the user to re-select in the panel.
