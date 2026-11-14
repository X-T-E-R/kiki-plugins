const text = { type: 'string', maxLength: 12000 };
const texts = { type: 'array', maxItems: 100, items: text };
const ref = { type: 'object', properties: { kind: { type: 'string', enum: ['task', 'agent', 'memory', 'history', 'document', 'url', 'other'] }, ref: text, label: text }, required: ['kind', 'ref'], additionalProperties: false };
const refs = { type: 'array', maxItems: 100, items: ref };
export const states = ['planned', 'active', 'blocked', 'awaiting_decision', 'delivered', 'accepted', 'cancelled', 'archived'];
export const fields = {
  title: { type: 'string', minLength: 1, maxLength: 500 },
  kind: { type: 'string', enum: ['task', 'decision'] },
  goal: text, success: texts, owner: text,
  state: { type: 'string', enum: states },
  dependsOn: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' } },
  nextAction: text, blocker: text, decision: text, options: texts, keyDecisions: texts,
  refs, evidence: refs,
};
export const recordSchema = { type: 'object', properties: fields, additionalProperties: false };
const id = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' };
const workspace = { type: 'string', minLength: 1, description: 'Use "." for context.workspaceRoot (normal default). Required by host file admission. Another workspace root must be explicitly admitted; never use the plugin directory.' };
const operation = { type: 'object', properties: {
  action: { type: 'string', enum: ['create', 'patch'] }, id,
  set: recordSchema,
  append: { type: 'object', properties: { evidence: refs, refs, keyDecisions: texts }, additionalProperties: false },
  baseRevision: { type: 'integer', minimum: 1, description: 'Optional revision from a prior read: merge disjoint fields; return precise conflicts for concurrently changed touched fields.' },
}, required: ['action', 'id', 'set'], additionalProperties: false };
export const definitions = [
  {
    schemaVersion: 1, name: 'ledger_read', disclosure: 'inline',
    description: 'Read the workspace controller ledger, not native Task/Memory. Start/resume with brief. overview/ready/next/blocked/pending-decisions are compact computed views; completed/history stay out unless requested. Search by query, get full item, history revisions, export JSON/Markdown. Every page/shortened field has an explicit continuation; use get for evidence. No execution, notification or acceptance is inferred.',
    parameters: { type: 'object', properties: {
      workspace,
      view: { type: 'string', enum: ['brief', 'overview', 'ready', 'next', 'blocked', 'pending-decisions', 'search', 'get', 'history', 'export'], default: 'overview' },
      id, query: { type: 'string', maxLength: 500 }, includeCompleted: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 4000 },
      format: { type: 'string', enum: ['json', 'markdown'] },
      textOffset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1000, maximum: 24000 },
      atGeneration: { type: 'integer', minimum: 0, description: 'Use generation from the first response to continue its stable revision-watermark snapshot; unrelated updates do not invalidate continuation.' },
    }, required: ['workspace'], additionalProperties: false },
    accesses: [{ kind: 'file', operation: 'read', path: '$.workspace', recursive: true }],
  },
  {
    schemaVersion: 1, name: 'ledger_write', disclosure: 'inline',
    description: 'Incrementally capture/patch controller work or decisions: create needs only id/title and stable requestKey; fill goal, success, owner, nextAction, references and factual basis as known. Omitted fields stay unchanged. set replaces named fields; append safely adds evidence/refs/keyDecisions. Optional baseRevision catches same-field stale conflicts; disjoint changes merge. Batch is atomic (up to 50). Explicit states record the controller’s judgment, not product acceptance or task execution. Missing/cyclic dependencies remain visible blockers; no automatic dispatch/messages.',
    parameters: { type: 'object', properties: {
      workspace, requestKey: { type: 'string', minLength: 1, maxLength: 200 }, actor: { type: 'string', maxLength: 200 }, basis: { type: 'string', maxLength: 4000 },
      operations: { type: 'array', minItems: 1, maxItems: 50, items: operation },
    }, required: ['workspace', 'requestKey', 'operations'], additionalProperties: false },
    accesses: [{ kind: 'file', operation: 'readwrite', path: '$.workspace', recursive: true }],
  },
];
