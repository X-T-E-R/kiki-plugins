import path from 'node:path';
import { realpath, mkdir, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { definitions, fields } from './definitions.mjs';

const terminal = new Set(['accepted', 'cancelled', 'archived']);
const queues = new Map();
const json = (value) => JSON.stringify(value);
const equal = (a, b) => json(a) === json(b);
const hash = (value) => createHash('sha256').update(json(value)).digest('hex');
function fail(code, message, details, recovery) { const error = new Error(message); Object.assign(error, { code, details, recovery }); throw error; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function validate(value, schema, location = 'args') {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type === 'integer' ? !Number.isSafeInteger(value) : schema.type !== type) fail('invalid_input', `${location} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) fail('invalid_input', `${location} must be one of: ${schema.enum.join(', ')}`);
  if (type === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) fail('invalid_input', `${location} has invalid length or format`);
  if (type === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) fail('invalid_input', `${location} is out of range`);
  if (type === 'array') {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems) || (schema.uniqueItems && new Set(value.map(json)).size !== value.length)) fail('invalid_input', `${location} has invalid count or duplicates`);
    value.forEach((entry, index) => validate(entry, schema.items, `${location}[${index}]`));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) fail('invalid_input', `${location}.${key} is required`);
    for (const [key, entry] of Object.entries(value)) {
      if (!schema.properties?.[key]) fail('invalid_input', `Unknown field ${location}.${key}`);
      validate(entry, schema.properties[key], `${location}.${key}`);
    }
  }
}
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function storage(args, context, write) {
  context.signal?.throwIfAborted();
  const requested = args.workspace === '.' ? context.workspaceRoot : args.workspace;
  if (!requested) fail('workspace_required', 'No workspaceRoot: supply an explicitly admitted workspace root.');
  const root = await realpath(path.resolve(context.workspaceRoot ?? '.', requested));
  const current = context.workspaceRoot ? await realpath(context.workspaceRoot) : undefined;
  if (!current || !samePath(root, current)) {
    const approved = await Promise.all((context.approvedPaths ?? []).map((entry) => realpath(entry)));
    if (!approved.some((entry) => samePath(root, entry))) fail('path_not_admitted', 'External workspace root was not admitted by the host.', { root }, 'Call the native tool with this workspace path so host file admission can approve it.');
  }
  const directory = path.join(root, '.controller-ledger');
  const file = path.join(directory, 'ledger.sqlite');
  for (const target of [directory, file, `${file}-wal`, `${file}-shm`]) {
    const info = await lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) fail('unsafe_storage', 'Ledger storage must not contain symbolic links.', { target });
  }
  context.signal?.throwIfAborted();
  if (write) await mkdir(directory, { recursive: true });
  const exists = await lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  return { root, file, exists };
}
function openStore(file, write) {
  const db = new DatabaseSync(file, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    if (write) {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) fail('schema_version', 'This ledger was written by a newer plugin; install that version.');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS revisions_item ON revisions(id, revision);
        CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
    } else if (db.prepare('PRAGMA user_version').get().user_version !== 1) fail('schema_version', 'Unsupported ledger schema version.');
    return db;
  } catch (error) { db.close(); throw error; }
}
const load = (db) => db ? db.prepare('SELECT body FROM items ORDER BY id').all().map((row) => JSON.parse(row.body)) : [];
const generation = (db) => db ? db.prepare('SELECT coalesce(max(seq),0) AS value FROM revisions').get().value : 0;
function loadAt(db, watermark) {
  if (!db) return [];
  if (watermark === generation(db)) return load(db);
  const items = new Map();
  for (const row of db.prepare('SELECT body FROM revisions WHERE seq<=? ORDER BY seq').all(watermark)) {
    const revision = JSON.parse(row.body);
    const item = items.get(revision.id) ?? { id: revision.id, createdAt: revision.at };
    for (const [key, change] of Object.entries(revision.changes)) item[key] = change.after;
    if (revision.changes.state?.after === 'archived') item.archivedFrom = revision.changes.state.before;
    Object.assign(item, { revision: revision.revision, updatedAt: revision.at, updatedBy: revision.actor });
    items.set(item.id, item);
  }
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function* exportItemBodies(db, watermark) {
  if (!db) return;
  if (watermark === generation(db)) {
    yield* db.prepare('SELECT body FROM items ORDER BY id').iterate();
    return;
  }
  const ids = db.prepare('SELECT id FROM revisions WHERE seq<=? GROUP BY id ORDER BY id').iterate(watermark);
  for (const { id } of ids) {
    const rows = db.prepare('SELECT body FROM revisions WHERE id=? AND seq<=? ORDER BY seq').iterate(id, watermark);
    let item;
    for (const row of rows) {
      const revision = JSON.parse(row.body);
      item ??= { id: revision.id, createdAt: revision.at };
      for (const [key, change] of Object.entries(revision.changes)) item[key] = change.after;
      if (revision.changes.state?.after === 'archived') item.archivedFrom = revision.changes.state.before;
      Object.assign(item, { revision: revision.revision, updatedAt: revision.at, updatedBy: revision.actor });
    }
    yield { body: JSON.stringify(item) };
  }
}
function computed(item, byId) {
  const unmet = item.dependsOn.filter((id) => {
    const dependency = byId.get(id);
    return dependency?.state !== 'accepted' && !(dependency?.state === 'archived' && dependency.archivedFrom === 'accepted');
  });
  const missing = item.dependsOn.filter((id) => !byId.has(id));
  let cycle = null;
  const queue = item.dependsOn.map((id) => [item.id, id]), visited = new Set();
  for (let index = 0; index < queue.length; index++) {
    const trail = queue[index], id = trail.at(-1);
    if (id === item.id) { cycle = trail; break; }
    if (visited.has(id)) continue;
    visited.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) queue.push([...trail, dependency]);
  }
  const informationGaps = [];
  if (!item.goal.trim()) informationGaps.push('goal');
  if (!item.success.length) informationGaps.push('success');
  if (!item.owner.trim()) informationGaps.push('owner');
  if (!item.nextAction.trim() && !terminal.has(item.state)) informationGaps.push('nextAction');
  if (item.state === 'blocked' && !item.blocker.trim()) informationGaps.push('blocker');
  if (item.state === 'accepted' && !item.evidence.length) informationGaps.push('acceptanceEvidence');
  if (item.kind === 'decision' && item.state === 'accepted' && !item.decision.trim()) informationGaps.push('decision');
  const waitingDecisions = unmet.filter((id) => byId.get(id)?.kind === 'decision');
  const ready = !terminal.has(item.state) && item.kind === 'task' && ['planned', 'active'].includes(item.state) && unmet.length === 0 && cycle === null;
  return { unmetDependencies: unmet, missingDependencies: missing, dependencyCycle: cycle, waitingDecisions, ready, informationGaps };
}
async function serialized(key, action) {
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  queues.set(key, tail);
  await previous;
  try { return await action(); } finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}
export async function writeLedger(args, context) {
  validate(args, definitions[1].parameters);
  if (!args.requestKey.trim()) fail('invalid_input', 'requestKey must contain text.');
  args = { ...args, actor: args.actor ?? null, basis: args.basis ?? null };
  const location = await storage(args, context, true);
  return serialized(location.file, async () => {
    context.signal?.throwIfAborted();
    const db = openStore(location.file, true);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      const digest = hash(canonical({ actor: args.actor, basis: args.basis, operations: args.operations }));
      const prior = db.prepare('SELECT digest,receipt FROM requests WHERE key=?').get(args.requestKey);
      if (prior) {
        if (prior.digest !== digest) fail('request_key_reused', 'This requestKey already committed different input.', { requestKey: args.requestKey }, 'Use a new requestKey for a different write.');
        db.exec('ROLLBACK'); transaction = false;
        return { ...JSON.parse(prior.receipt), replayed: true };
      }
      const results = [], timestamp = new Date().toISOString();
      const seen = new Set();
      for (const operation of args.operations) {
        context.signal?.throwIfAborted();
        if (seen.has(operation.id)) fail('duplicate_operation', 'Use one operation per item in a batch.', { id: operation.id });
        seen.add(operation.id);
        const row = db.prepare('SELECT body FROM items WHERE id=?').get(operation.id);
        const before = row ? JSON.parse(row.body) : null;
        if (operation.action === 'create' && before) fail('item_exists', 'Item already exists; patch it instead.', { id: operation.id, revision: before.revision });
        if (operation.action === 'patch' && !before) fail('item_not_found', 'Item does not exist; read/search its ID or create it.', { id: operation.id });
        if (operation.action === 'create' && operation.baseRevision !== undefined) fail('invalid_input', 'create cannot have baseRevision.');
        if (operation.action === 'patch' && !Object.keys(operation.set).length && !Object.keys(operation.append ?? {}).length) fail('empty_patch', 'Supply at least one set or append field.');
        if (operation.baseRevision !== undefined) {
          if (operation.baseRevision > before.revision) fail('invalid_revision', 'baseRevision is newer than the stored revision.', { currentRevision: before.revision });
          if (operation.baseRevision < before.revision) {
            const revisions = db.prepare('SELECT body FROM revisions WHERE id=? AND revision>?').all(operation.id, operation.baseRevision).map((r) => JSON.parse(r.body));
            const conflicts = Object.entries(operation.set).filter(([key, value]) => revisions.some((r) => key in r.changes) && !equal(value, before[key])).map(([field, proposed]) => ({ field, current: before[field], proposed }));
            if (conflicts.length) fail('stale_conflict', 'Touched fields changed since baseRevision; the batch was rolled back.', { id: operation.id, baseRevision: operation.baseRevision, currentRevision: before.revision, conflicts }, 'Read get/history for this item, reconcile only these fields, then submit a new requestKey.');
          }
        }
        const after = { ...(before ?? { title: '', kind: 'task', goal: '', success: [], owner: '', state: 'planned', dependsOn: [], nextAction: '', blocker: '', decision: '', options: [], keyDecisions: [], refs: [], evidence: [], createdAt: timestamp }), ...operation.set };
        for (const [key, entries] of Object.entries(operation.append ?? {})) after[key] = [...new Map([...after[key], ...entries].map((entry) => [json(canonical(entry)), entry])).values()];
        if (!after.title.trim()) fail('title_required', 'Supply a title to capture this item; other information can be filled later.');
        const changed = Object.keys(fields).filter((key) => !equal(before?.[key], after[key]));
        validate(Object.fromEntries(Object.keys(fields).map((key) => [key, after[key]])), { type: 'object', properties: fields });
        if (after.state === 'archived' && before?.state !== 'archived') after.archivedFrom = before?.state ?? 'planned';
        after.id = operation.id; after.revision = (before?.revision ?? 0) + 1; after.updatedAt = timestamp; after.updatedBy = args.actor;
        const changes = Object.fromEntries(changed.map((key) => [key, { before: before?.[key] ?? null, after: after[key] }]));
        const history = { id: after.id, revision: after.revision, at: timestamp, actor: args.actor, basis: args.basis, requestKey: args.requestKey, changes };
        db.prepare('INSERT INTO items(id,revision,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(after.id, after.revision, json(after));
        db.prepare('INSERT INTO revisions(id,revision,body) VALUES(?,?,?)').run(after.id, after.revision, json(history));
        results.push({ id: after.id, revision: after.revision, state: after.state, changed });
      }
      const byId = new Map(load(db).map((item) => [item.id, item]));
      for (const result of results) Object.assign(result, computed(byId.get(result.id), byId));
      const receipt = { workspace: location.root, dataPath: location.file, requestKey: args.requestKey, replayed: false, results, generation: generation(db) };
      db.prepare('INSERT INTO requests(key,digest,receipt) VALUES(?,?,?)').run(args.requestKey, digest, json(receipt));
      await yieldTurn();
      context.signal?.throwIfAborted();
      db.exec('COMMIT'); transaction = false;
      return receipt;
    } finally { if (transaction) db.exec('ROLLBACK'); db.close(); }
  });
}
function compact(item, byId) {
  const shortenedFields = [];
  const short = (value, field) => { if (value.length > 240) shortenedFields.push(field); return value.length > 240 ? `${value.slice(0, 240)}…` : value; };
  return { id: item.id, revision: item.revision, kind: item.kind, title: item.title, state: item.state, owner: short(item.owner, 'owner'), goal: short(item.goal, 'goal'), nextAction: short(item.nextAction, 'nextAction'), blocker: short(item.blocker, 'blocker'), success: item.success.map((v) => short(v, 'success')), keyDecisions: item.keyDecisions.map((v) => short(v, 'keyDecisions')), decision: short(item.decision, 'decision'), evidenceCount: item.evidence.length, referenceCount: item.refs.length, ...computed(item, byId), shortenedFields: [...new Set(shortenedFields)], detail: { view: 'get', id: item.id } };
}
function detach(text, offset, end) {
  if (offset === 0 && end === text.length) return text;
  // A JS slice of the snapshot keeps that whole string alive. Callers retain every page.
  return Buffer.from(text.slice(offset, end), 'utf16le').toString('utf16le');
}
function chunk(text, args) {
  const offset = args.textOffset ?? 0, count = args.maxChars ?? 16000;
  if (offset > text.length) fail('invalid_offset', 'textOffset is beyond the complete text.', { totalChars: text.length });
  let end = Math.min(offset + count, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: detach(text, offset, end), textOffset: offset, totalChars: text.length, nextTextOffset: end < text.length ? end : null, complete: offset === 0 && end === text.length };
}
function payload(value, args, key) {
  const part = chunk(JSON.stringify(value, null, 2), args);
  return part.complete ? { [key]: value, complete: true, totalChars: part.totalChars, nextTextOffset: null } : part;
}
function indentJson(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return JSON.stringify(value, null, 2).split('\n').map((line) => `${prefix}${line}`).join('\n');
}
function detachExportChunk(text, start, end) {
  return start === 0 && end === text.length ? text : Buffer.from(text.slice(start, end), 'utf16le').toString('utf16le');
}
async function* exportPieces(db, location, version, format, signal) {
  const items = exportItemBodies(db, version);
  const history = db?.prepare('SELECT body FROM revisions WHERE seq<=? ORDER BY seq').iterate(version) ?? [][Symbol.iterator]();
  signal?.throwIfAborted();
  if (format === 'markdown') {
    yield '# Controller Ledger';
    let item = items.next();
    while (!item.done) {
      signal?.throwIfAborted();
      const value = JSON.parse(item.value.body);
      yield `\n\n## ${value.id}: ${value.title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
      item = items.next();
    }
    yield '\n\n# Revisions';
    let revision = history.next();
    while (!revision.done) {
      signal?.throwIfAborted();
      yield `\n\n\`\`\`json\n${JSON.stringify(JSON.parse(revision.value.body), null, 2)}\n\`\`\``;
      revision = history.next();
    }
    yield '\n';
    return;
  }
  yield `{\n  "schemaVersion": 1,\n  "workspace": ${JSON.stringify(location.root)},\n  "generation": ${version},\n  "items": `;
  let item = items.next();
  if (item.done) {
    yield '[]';
  } else {
    yield '[\n' + indentJson(JSON.parse(item.value.body), 4);
    item = items.next();
    while (!item.done) {
      signal?.throwIfAborted();
      yield ',\n' + indentJson(JSON.parse(item.value.body), 4);
      item = items.next();
    }
    yield '\n  ]';
  }
  yield ',\n  "history": ';
  let revision = history.next();
  if (revision.done) {
    yield '[]';
  } else {
    yield '[\n' + indentJson(JSON.parse(revision.value.body), 4);
    revision = history.next();
    while (!revision.done) {
      signal?.throwIfAborted();
      yield ',\n' + indentJson(JSON.parse(revision.value.body), 4);
      revision = history.next();
    }
    yield '\n  ]';
  }
  yield '\n}';
}
async function* exportChunks(db, location, version, format, signal, pageChars = 24000) {
  let carry = '';
  for await (const piece of exportPieces(db, location, version, format, signal)) {
    signal?.throwIfAborted();
    let offset = 0;
    while (offset < piece.length) {
      const available = pageChars - carry.length;
      let end = Math.min(offset + available, piece.length);
      if (end < piece.length && /[\uD800-\uDBFF]/.test(piece[end - 1])) end--;
      if (end === offset) {
        yield carry;
        carry = '';
        continue;
      }
      carry += detachExportChunk(piece, offset, end);
      offset = end;
      if (carry.length === pageChars) {
        yield carry;
        carry = '';
      }
    }
  }
  if (carry.length > 0) yield carry;
}
async function exportPage(db, location, version, format, signal, offset, count) {
  const endOffset = offset + count;
  let totalChars = 0;
  let text = '';
  for await (const piece of exportPieces(db, location, version, format, signal)) {
    signal?.throwIfAborted();
    const pieceStart = totalChars;
    totalChars += piece.length;
    const start = Math.max(offset, pieceStart);
    const end = Math.min(endOffset, totalChars);
    if (end > start) text += detachExportChunk(piece, start - pieceStart, end - pieceStart);
  }
  if (offset > totalChars) fail('invalid_offset', 'textOffset is beyond the complete text.', { totalChars });
  if (offset + text.length < totalChars && /[\uD800-\uDBFF]$/.test(text)) text = detachExportChunk(text, 0, text.length - 1);
  const nextTextOffset = offset + text.length < totalChars ? offset + text.length : null;
  return { text, textOffset: offset, totalChars, nextTextOffset, complete: offset === 0 && nextTextOffset === null };
}
export async function* exportPages(workspaceRoot, format, signal, pageChars = 24000) {
  const args = { workspace: '.', view: 'export', format };
  const context = { workspaceRoot, approvedPaths: [], signal };
  validate(args, definitions[0].parameters);
  if (!Number.isSafeInteger(pageChars) || pageChars < 1000 || pageChars > 24000) fail('invalid_input', 'pageChars is out of range');
  const location = await storage(args, context, false);
  const db = location.exists ? openStore(location.file, false) : null;
  try {
    db?.exec('BEGIN');
    signal?.throwIfAborted();
    const version = generation(db);
    yield* exportChunks(db, location, version, args.format ?? 'json', signal, pageChars);
  } finally { if (db) { db.exec('ROLLBACK'); db.close(); } }
}
export async function readLedger(args, context) {
  validate(args, definitions[0].parameters);
  const location = await storage(args, context, false);
  const db = location.exists ? openStore(location.file, false) : null;
  try {
    db?.exec('BEGIN');
    const currentGeneration = generation(db), view = args.view ?? 'overview';
    const fingerprint = hash({ view, id: args.id ?? null, query: args.query ?? null, includeCompleted: args.includeCompleted ?? false, limit: args.limit ?? (view === 'brief' ? 10 : 25) });
    let cursor = null;
    if (args.cursor) {
      try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()); } catch { fail('invalid_cursor', 'Invalid cursor; restart the view.'); }
      if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.generation) || cursor.generation < 0) fail('invalid_cursor', 'Cursor belongs to different query parameters; keep the original view/query/limit.');
      if (args.atGeneration !== undefined && args.atGeneration !== cursor.generation) fail('invalid_cursor', 'Cursor and atGeneration describe different snapshots.');
    }
    const version = cursor?.generation ?? args.atGeneration ?? currentGeneration;
    if (version > currentGeneration) fail('invalid_generation', 'Snapshot watermark is beyond this ledger.', { requested: version, current: currentGeneration });
    if ((args.textOffset ?? 0) > 0 && args.atGeneration === undefined && !cursor) fail('generation_required', 'Continuing text requires atGeneration from the first response.');
    const base = { workspace: location.root, dataPath: location.file, generation: version, currentGeneration, snapshot: 'Committed revisions at or before generation; later edits/new items are excluded. Start a fresh read for current state.', view };
    if (view === 'export') return { ...base, format: args.format ?? 'json', ...await exportPage(db, location, version, args.format ?? 'json', context.signal, args.textOffset ?? 0, args.maxChars ?? 16000) };
    const items = loadAt(db, version), byId = new Map(items.map((item) => [item.id, item]));
    if (['get', 'history'].includes(view) && !args.id) fail('id_required', `${view} requires id.`);
    if (view === 'get') {
      const item = byId.get(args.id);
      if (!item) fail('item_not_found', 'No item with this ID; search or overview to locate it.', { id: args.id });
      return { ...base, ...payload({ ...item, ...computed(item, byId) }, args, 'item') };
    }
    let selected;
    if (view === 'history') {
      if (!byId.has(args.id)) fail('item_not_found', 'No item with this ID.');
      selected = db.prepare('SELECT body FROM revisions WHERE id=? AND seq<=? ORDER BY revision DESC').all(args.id, version).map((r) => JSON.parse(r.body));
    } else {
      selected = items.filter((item) => args.includeCompleted || !terminal.has(item.state));
      if (view === 'ready' || view === 'next') selected = selected.filter((item) => computed(item, byId).ready);
      if (view === 'blocked') selected = selected.filter((item) => item.state === 'blocked' || item.state === 'awaiting_decision' || computed(item, byId).unmetDependencies.length);
      if (view === 'pending-decisions') selected = selected.filter((item) => item.kind === 'decision' && !terminal.has(item.state));
      if (view === 'search' && !args.query?.trim()) fail('query_required', 'search requires a keyword query.');
      if (args.query) selected = selected.filter((item) => json(item).toLocaleLowerCase().includes(args.query.toLocaleLowerCase()));
      selected.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      selected = selected.map((item) => compact(item, byId));
    }
    const offset = cursor?.offset ?? 0;
    const limit = args.limit ?? (view === 'brief' ? 10 : 25), page = selected.slice(offset, offset + limit);
    const next = offset + page.length < selected.length ? Buffer.from(json({ fingerprint, generation: version, offset: offset + page.length })).toString('base64url') : null;
    const counts = { active: items.filter((item) => !terminal.has(item.state)).length, completed: items.filter((item) => terminal.has(item.state)).length, ready: items.filter((item) => computed(item, byId).ready).length, pendingDecisions: items.filter((item) => item.kind === 'decision' && !terminal.has(item.state)).length };
    return { ...base, counts, total: selected.length, cursor: next, page: offset / limit + 1, ...payload(page, args, view === 'history' ? 'revisions' : 'items'), guidance: view === 'brief' ? 'Current work only; ready is calculated, not dispatched. Read get for complete evidence/refs or shortened fields; follow cursor for other active work. Explicit delivered ≠ accepted.' : undefined };
  } finally { if (db) { db.exec('ROLLBACK'); db.close(); } }
}
