import http from 'node:http';
import net from 'node:net';
import iconv from 'iconv-lite';

export async function startFixture(spec = {}) {
  const users = new Map((spec.users ?? []).map((user) => [user.user, {
    ...user,
    mailboxes: new Map(Object.entries(user.mailboxes ?? {}).map(([name, box]) => [name, {
      uidValidity: box.uidValidity,
      messages: box.messages.map((message) => ({ ...message, flags: new Set(message.flags ?? []) })),
    }])),
  }]));
  const state = { users, smtpMessages: [], smtpData: 0, smtpAuthFailures: 0, imapSockets: 0, imapAccepts: 0, imapAuthCommands: 0, idling: 0, tokenRequests: 0, held: [], dropRemaining: spec.dropFirst ?? 0 };
  const sessions = new Set();
  const imap = net.createServer((socket) => {
    state.imapAccepts += 1;
    if (spec.dropOnConnect || state.dropRemaining > 0) {
      if (state.dropRemaining > 0) state.dropRemaining -= 1;
      socket.destroy();
      return;
    }
    state.imapSockets += 1;
    const session = new ImapSession(socket, state, spec, sessions);
    sessions.add(session);
    socket.on('close', () => {
      if (session.idle) { session.idle = false; state.idling = Math.max(0, state.idling - 1); }
      sessions.delete(session);
      state.imapSockets -= 1;
    });
  });
  const smtp = net.createServer((socket) => new SmtpSession(socket, state, spec));
  const token = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      state.tokenRequests += 1;
      if (params.get('grant_type') !== 'refresh_token' || params.get('refresh_token') !== spec.refreshToken) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"invalid_grant"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: spec.accessToken, expires_in: 3600, token_type: 'Bearer' }));
    });
  });
  await listen(imap);
  await listen(smtp);
  await listen(token);
  return {
    imapPort: imap.address().port,
    smtpPort: smtp.address().port,
    tokenPort: token.address().port,
    state,
    append(user, mailbox, raw, flags = []) {
      const account = users.get(user);
      const box = account.mailboxes.get(mailbox);
      const uid = (box.messages.at(-1)?.uid ?? 0) + 1;
      box.messages.push({ uid, flags: new Set(flags), raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) });
      for (const session of sessions) {
        if (session.idle && session.user === user && session.selected === mailbox) session.send(`* ${box.messages.length} EXISTS\r\n`);
      }
      return uid;
    },
    releaseHold() {
      for (const held of state.held.splice(0)) held();
    },
    dropSockets() {
      for (const session of sessions) session.socket.destroy();
    },
    async close() {
      for (const session of sessions) session.socket.destroy();
      await Promise.all([closeServer(imap), closeServer(smtp), closeServer(token)]);
    },
  };
}

class ImapSession {
  constructor(socket, state, spec, sessions) {
    this.socket = socket;
    this.state = state;
    this.spec = spec;
    this.sessions = sessions;
    this.buffer = Buffer.alloc(0);
    this.phase = 'command';
    this.user = undefined;
    this.selected = undefined;
    this.idle = false;
    this.idleTag = '';
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    socket.on('error', () => {});
    if (spec.silentGreeting !== true) this.send('* OK IMAP4rev1 ready\r\n');
  }

  send(text) { if (!this.socket.destroyed) this.socket.write(text); }

  drain() {
    for (;;) {
      if (this.phase === 'literal') {
        if (this.buffer.length < this.literalLength) return;
        const literal = this.buffer.subarray(0, this.literalLength).toString('utf8');
        this.buffer = this.buffer.subarray(this.literalLength);
        this.phase = 'command';
        this.pending = `${this.pending} ${JSON.stringify(literal)}`;
      }
      const index = findCrlf(this.buffer);
      if (index < 0) return;
      const line = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 2);
      if (this.phase === 'auth') { this.finishAuth(line); continue; }
      if (this.phase === 'idle') {
        if (line.toUpperCase() === 'DONE') {
          if (this.idle) this.state.idling = Math.max(0, this.state.idling - 1);
          this.idle = false;
          this.phase = 'command';
          this.send(`${this.idleTag} OK IDLE completed\r\n`);
        }
        continue;
      }
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (literal && !line.includes('"')) {
        this.pending = line.slice(0, literal.index).trimEnd();
        this.literalLength = Number(literal[1]);
        this.phase = 'literal';
        if (!line.endsWith('+}' )) this.send('+ OK\r\n');
        continue;
      }
      this.command(line);
    }
  }

  command(line) {
    const tokens = tokenize(line);
    const tag = tokens.shift() ?? '*';
    const name = (tokens.shift() ?? '').toUpperCase();
    const reply = (status, text) => this.send(`${tag} ${status} ${text}\r\n`);
    if (name === 'AUTHENTICATE' || name === 'LOGIN') this.state.imapAuthCommands += 1;
    if (name === 'CAPABILITY') {
      this.send('* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2 IDLE ID\r\n');
      reply('OK', 'CAPABILITY completed');
      return;
    }
    if (name === 'ID') {
      (this.state.imapIds ??= []).push(line);
      this.send('* ID NIL\r\n');
      reply('OK', 'ID completed');
      return;
    }
    if (name === 'LOGOUT') {
      this.send('* BYE logged out\r\n');
      reply('OK', 'LOGOUT completed');
      this.socket.end();
      return;
    }
    if (name === 'NOOP') { reply('OK', 'NOOP completed'); return; }
    if (name === 'AUTHENTICATE') {
      this.authTag = tag;
      this.authMethod = (tokens[0] ?? '').toUpperCase();
      this.phase = 'auth';
      this.send('+\r\n');
      return;
    }
    if (!this.user) { reply('NO', 'Login required'); return; }
    if (name === 'LIST') return this.list(tokens, reply);
    if (name === 'SELECT' || name === 'EXAMINE') return this.select(tokens, reply);
    if (name === 'UID') return this.uid(tokens, reply);
    if (name === 'SEARCH') return this.search(tokens, reply, false);
    if (name === 'FETCH') return this.fetch(tokens, reply, false);
    if (name === 'IDLE') {
      if (!this.selected) { reply('BAD', 'Select a mailbox first'); return; }
      this.idle = true;
      this.idleTag = tag;
      this.state.idling += 1;
      this.phase = 'idle';
      this.send('+\r\n');
      return;
    }
    if (name === 'CLOSE' || name === 'UNSELECT') { this.selected = undefined; reply('OK', 'CLOSE completed'); return; }
    reply('BAD', 'Unknown command');
  }

  finishAuth(line) {
    const tag = this.authTag;
    this.phase = 'command';
    let user = '';
    let secret = '';
    try {
      const decoded = Buffer.from(line, 'base64').toString('utf8');
      if (this.authMethod === 'PLAIN') {
        const parts = decoded.split('\u0000');
        user = parts.at(-2) ?? '';
        secret = parts.at(-1) ?? '';
      } else if (this.authMethod === 'XOAUTH2') {
        user = /user=([^\u0001]*)/.exec(decoded)?.[1] ?? '';
        secret = /auth=Bearer ([^\u0001]*)/.exec(decoded)?.[1] ?? '';
      }
    } catch { /* bad base64 is an auth failure */ }
    const account = this.state.users.get(user);
    const expected = this.authMethod === 'XOAUTH2' ? account?.accessToken : account?.password;
    if (!account || secret !== expected || this.spec.failAuth === user) {
      this.send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed\r\n`);
      return;
    }
    this.user = user;
    this.send(`${tag} OK AUTHENTICATE completed\r\n`);
  }

  list(tokens, reply) {
    const pattern = tokens.at(-1) ?? '';
    if (pattern === '') {
      this.send('* LIST (\\Noselect) "/" ""\r\n');
      reply('OK', 'LIST completed');
      return;
    }
    const account = this.state.users.get(this.user);
    for (const name of account.mailboxes.keys()) this.send(`* LIST (\\HasNoChildren) "/" ${quote(name)}\r\n`);
    reply('OK', 'LIST completed');
  }

  select(tokens, reply) {
    const name = unquote(tokens[0] ?? '');
    const account = this.state.users.get(this.user);
    const box = findBox(account, name);
    if (!box) { reply('NO', 'Mailbox does not exist'); return; }
    this.selected = canonicalName(account, name);
    const next = (box.messages.at(-1)?.uid ?? 0) + 1;
    this.send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n`);
    this.send(`* ${box.messages.length} EXISTS\r\n`);
    this.send(`* 0 RECENT\r\n`);
    this.send(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n`);
    this.send(`* OK [UIDNEXT ${next}] Predicted next UID\r\n`);
    reply('OK', '[READ-WRITE] SELECT completed');
  }

  uid(tokens, reply) {
    const nested = (tokens.shift() ?? '').toUpperCase();
    if (nested === 'SEARCH') return this.search(tokens, reply, true);
    if (nested === 'FETCH') return this.fetch(tokens, reply, true);
    reply('BAD', 'Unknown UID command');
  }

  search(tokens, reply, uid) {
    const box = this.box();
    if (!box) { reply('NO', 'Select a mailbox first'); return; }
    if (this.spec.holdSearch) {
      this.state.held.push(() => this.finishSearch(box, tokens, reply, uid));
      return;
    }
    this.finishSearch(box, tokens, reply, uid);
  }

  finishSearch(box, tokens, reply, uid) {
    const messages = filterMessages(box.messages, tokens);
    const ids = messages.map((message, index) => uid ? message.uid : index + 1);
    this.send(`* SEARCH${ids.map((id) => ` ${id}`).join('')}\r\n`);
    reply('OK', 'SEARCH completed');
  }

  fetch(tokens, reply, uidMode) {
    if (this.spec.dropOnFetch) { this.socket.destroy(); return; }
    const run = () => {
      const box = this.box();
      if (!box) { reply('NO', 'Select a mailbox first'); return; }
      const wanted = tokens.join(' ').toUpperCase();
      const selected = selectMessages(box.messages, tokens[0], uidMode);
      for (const item of selected) {
        const fields = [`UID ${item.message.uid}`, `FLAGS (${[...item.message.flags].join(' ')})`, `RFC822.SIZE ${item.message.raw.length}`];
        if (wanted.includes('ENVELOPE')) fields.push(`ENVELOPE ${envelope(item.message.raw)}`);
        if (wanted.includes('INTERNALDATE')) fields.push(`INTERNALDATE ${quote(item.message.internalDate || '18-Oct-2026 00:00:00 +0000')}`);
        if (wanted.includes('BODY') || wanted.includes('RFC822')) {
          this.send(`* ${item.sequence} FETCH (${fields.join(' ')} BODY[] {${item.message.raw.length}}\r\n`);
          this.socket.write(item.message.raw);
          this.send(')\r\n');
        } else {
          this.send(`* ${item.sequence} FETCH (${fields.join(' ')})\r\n`);
        }
      }
      reply('OK', 'FETCH completed');
    };
    if (this.spec.holdFetch) { this.state.held.push(run); return; }
    run();
  }

  box() {
    const account = this.state.users.get(this.user);
    return account?.mailboxes.get(this.selected);
  }
}

class SmtpSession {
  constructor(socket, state, spec) {
    this.socket = socket;
    this.state = state;
    this.spec = spec;
    this.buffer = Buffer.alloc(0);
    this.mode = 'command';
    this.user = undefined;
    this.from = '';
    this.to = [];
    this.data = Buffer.alloc(0);
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    socket.on('error', () => {});
    if (spec.silentSmtp !== true) this.send('220 localhost ESMTP ready\r\n');
  }

  send(text) { if (!this.socket.destroyed) this.socket.write(text); }

  drain() {
    for (;;) {
      if (this.mode === 'data') {
        const end = this.buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        this.data = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 5);
        this.mode = 'command';
        this.finishData();
        continue;
      }
      const index = findCrlf(this.buffer);
      if (index < 0) return;
      const line = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 2);
      this.command(line);
    }
  }

  command(line) {
    const [verb, ...rest] = line.split(' ');
    const name = verb.toUpperCase();
    if (name === 'EHLO' || name === 'HELO') {
      this.send('250-localhost\r\n250-AUTH PLAIN XOAUTH2\r\n250 8BITMIME\r\n');
      return;
    }
    if (name === 'AUTH') return this.auth(rest.join(' '));
    if (name === 'MAIL') { this.from = addressOf(rest.join(' ')); this.send('250 2.1.0 OK\r\n'); return; }
    if (name === 'RCPT') { this.to.push(addressOf(rest.join(' '))); this.send('250 2.1.5 OK\r\n'); return; }
    if (name === 'DATA') { this.mode = 'data'; this.data = Buffer.alloc(0); this.state.smtpData += 1; this.send('354 End data with <CR><LF>.<CR><LF>\r\n'); return; }
    if (name === 'RSET') { this.from = ''; this.to = []; this.send('250 2.0.0 OK\r\n'); return; }
    if (name === 'QUIT') { this.send('221 2.0.0 Bye\r\n'); this.socket.end(); return; }
    if (name === 'NOOP') { this.send('250 2.0.0 OK\r\n'); return; }
    this.send('502 5.5.2 Command not implemented\r\n');
  }

  auth(argument) {
    const [mechanism, initial] = argument.split(' ');
    const method = (mechanism ?? '').toUpperCase();
    let decoded = '';
    try { decoded = Buffer.from(initial ?? '', 'base64').toString('utf8'); } catch { decoded = ''; }
    let user = '';
    let secret = '';
    if (method === 'PLAIN') {
      const parts = decoded.split('\u0000');
      user = parts.at(-2) ?? '';
      secret = parts.at(-1) ?? '';
    } else if (method === 'XOAUTH2') {
      user = /user=([^\u0001]*)/.exec(decoded)?.[1] ?? '';
      secret = /auth=Bearer ([^\u0001]*)/.exec(decoded)?.[1] ?? '';
    }
    const account = this.state.users.get(user);
    const expected = method === 'XOAUTH2' ? account?.accessToken : account?.password;
    if (!account || secret !== expected || this.spec.failSmtpAuth === user) {
      this.state.smtpAuthFailures += 1;
      this.send('535 5.7.8 Authentication failed\r\n');
      return;
    }
    this.user = user;
    this.send('235 2.7.0 Authentication successful\r\n');
  }

  finishData() {
    if (this.spec.dropAfterData) { this.socket.destroy(); return; }
    const accept = () => {
      const raw = unstuff(this.data);
      this.state.smtpMessages.push({ user: this.user, from: this.from, to: [...this.to], raw });
      this.from = '';
      this.to = [];
      this.send('250 2.0.0 Accepted message\r\n');
    };
    if (this.spec.holdAfterData) {
      this.state.held.push(accept);
      return;
    }
    accept();
  }
}

function filterMessages(messages, tokens) {
  let matched = messages.map((message, index) => ({ message, index }));
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const term = tokens[cursor].toUpperCase();
    if (term === 'ALL' || term === 'CHARSET') { if (term === 'CHARSET') cursor += 1; continue; }
    if (term === 'UNSEEN') { matched = matched.filter((item) => !item.message.flags.has('\\Seen')); continue; }
    if (term === 'SEEN') { matched = matched.filter((item) => item.message.flags.has('\\Seen')); continue; }
    if (['SUBJECT', 'FROM', 'BODY', 'TEXT', 'TO'].includes(term)) {
      const needle = String(tokens[++cursor] ?? '').toLowerCase();
      matched = matched.filter((item) => headerValue(item.message.raw, term).toLowerCase().includes(needle) || (['BODY', 'TEXT'].includes(term) && item.message.raw.toString('utf8').toLowerCase().includes(needle)));
      continue;
    }
    if (term === 'SINCE') {
      const since = parseWhen(tokens[++cursor] ?? '');
      matched = matched.filter((item) => parseWhen(headerValue(item.message.raw, 'DATE')) >= since);
      continue;
    }
    if (term === 'UID') {
      const range = tokens[++cursor] ?? '';
      matched = matched.filter((item) => uidMatches(item.message.uid, range));
    }
  }
  return matched.map((item) => item.message);
}

function selectMessages(messages, range, uidMode) {
  return messages.map((message, index) => ({ message, sequence: index + 1 })).filter((item) => uidMatches(uidMode ? item.message.uid : item.sequence, range));
}

function uidMatches(uid, range) {
  return String(range).split(',').some((part) => {
    if (part === '*') return true;
    const [start, end] = part.split(':');
    const from = start === '*' ? 1 : Number(start);
    const to = end == null ? from : end === '*' ? Number.MAX_SAFE_INTEGER : Number(end);
    return uid >= Math.min(from, to) && uid <= Math.max(from, to);
  });
}

function envelope(raw) {
  const date = headerValue(raw, 'DATE') || 'Mon, 18 Oct 2026 00:00:00 +0000';
  const subject = headerValue(raw, 'SUBJECT');
  const from = addressGroup(headerValue(raw, 'FROM'));
  const to = addressGroup(headerValue(raw, 'TO'));
  const messageId = headerValue(raw, 'MESSAGE-ID');
  const inReply = headerValue(raw, 'IN-REPLY-TO');
  return `(${atom(date)} ${atom(subject)} ${from} ${from} ${from} ${to} NIL NIL ${atom(inReply)} ${atom(messageId)})`;
}

function addressGroup(value) {
  const match = /^(?:"?([^"<]*)"?\s*)?<([^@>]+)@([^>]+)>$/.exec(value) || /^([^@\s]+)@([^>\s]+)$/.exec(value);
  if (!match) return 'NIL';
  if (match.length === 4) return `((${atom(match[1].trim())} NIL ${atom(match[2])} ${atom(match[3])}))`;
  return `((NIL NIL ${atom(match[1])} ${atom(match[2])}))`;
}

function headerValue(raw, name) {
  const text = raw.toString('utf8');
  const folded = text.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const line = folded.split(/\r?\n/).find((item) => item.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : '';
}

function atom(value) {
  if (!value) return 'NIL';
  return quote(value);
}

function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquote(value) {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function decodeMailbox(name) {
  if (!name.includes('&')) return name;
  try {
    const decoded = iconv.decode(Buffer.from(name, 'ascii'), 'utf-7-imap');
    return decoded || name;
  } catch {
    return name;
  }
}

function findBox(account, name) {
  const decoded = decodeMailbox(name);
  if (account.mailboxes.has(decoded)) return account.mailboxes.get(decoded);
  if (account.mailboxes.has(name)) return account.mailboxes.get(name);
  const upper = decoded.toUpperCase();
  for (const [key, box] of account.mailboxes) if (key.toUpperCase() === upper) return box;
  return undefined;
}

function canonicalName(account, name) {
  const decoded = decodeMailbox(name);
  if (account.mailboxes.has(decoded)) return decoded;
  if (account.mailboxes.has(name)) return name;
  const upper = decoded.toUpperCase();
  for (const key of account.mailboxes.keys()) if (key.toUpperCase() === upper) return key;
  return decoded;
}

function addressOf(value) {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value.replace(/^FROM:|^TO:/i, '')).trim();
}

function unstuff(buffer) {
  const lines = buffer.toString('binary').split('\r\n');
  return Buffer.from(lines.map((line) => line.startsWith('.') ? line.slice(1) : line).join('\r\n'), 'binary');
}

function tokenize(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '\\') { current += line[index + 1] ?? ''; index += 1; continue; }
      if (char === '"') { quoted = false; tokens.push(current); current = ''; continue; }
      current += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ' ' || char === '(' || char === ')') {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseWhen(value) {
  const imap = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (imap) return Date.parse(`${imap[1]} ${imap[2]} ${imap[3]} UTC`);
  return Date.parse(value);
}

function findCrlf(buffer) {
  return buffer.indexOf('\r\n');
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
