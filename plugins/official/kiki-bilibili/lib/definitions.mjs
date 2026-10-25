const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const page = { type: 'integer', minimum: 1, default: 1 };
const tool = (name, description, properties, required = ['action']) => ({ schemaVersion: 1, name, description, parameters: object(properties, required), accesses: [{ kind: 'all' }], disclosure: 'deferred' });
export const definitions = [
  tool('bilibili_discover', 'Search Bilibili videos or users, inspect hot searches, get personalized recommendations or read a following timeline. timeline uses next_offset as cursor; up optionally selects one creator.', {
    action: { enum: ['search', 'users', 'hot', 'recommend', 'timeline'], type: 'string' }, keyword: string,
    order: { type: 'string', enum: ['default', 'views', 'new', 'danmaku', 'favorites', 'comments'] }, page,
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'recommend: at most 30; search/hot/timeline: at most 50.' }, cursor: string, up: string,
    kind: { type: 'string', enum: ['all', 'video', 'article', 'pgc'] },
  }),
  tool('bilibili_watch', 'Read metadata, timestamped subtitles or ASR, and real video frames. all reads subtitles (falls back to ASR when absent), then frames. visual=frames uses FFmpeg on the video stream; preview is only a seek-bar thumbnail. ASR defaults to local; cloud uses the explicitly configured profile service. Frame paths and requested/actual seconds remain in the result.', {
    action: { type: 'string', enum: ['metadata', 'subtitle', 'transcribe', 'visual', 'all'] }, video: string, page, language: string,
    visual: { type: 'string', enum: ['frames', 'preview'], default: 'frames' },
    timestamps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'number', minimum: 0 } },
    count: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
    engine: { type: 'string', enum: ['local', 'cloud', 'auto'], default: 'local' },
    maxMinutes: { type: 'number', exclusiveMinimum: 0, default: 60 },
    includeComments: { type: 'boolean', default: false },
  }, ['action', 'video']),
  tool('bilibili_interact', 'Read comments or replies, post with real @ mentions, like or favorite. check inspects the configured account’s recent comment lists (root: at most 3 pages; replies: 2); it cannot measure visibility to others. Use rootId for nested replies. resourceType defaults to video; other comment areas use numeric oid in video. Unknown writes are not repeated.', {
    action: { type: 'string', enum: ['comments', 'replies', 'check', 'comment', 'reply', 'mention', 'like', 'favorite'] }, video: string,
    resourceType: { type: 'string', enum: ['video', 'dynamic', 'draw', 'article'], default: 'video' },
    text: { type: 'string', minLength: 1, maxLength: 2000 }, commentId: { type: 'integer', minimum: 1 }, rootId: { type: 'integer', minimum: 1 },
    mentions: { type: 'array', maxItems: 3, items: string }, folder: string, undo: { type: 'boolean' }, page,
    sort: { type: 'string', enum: ['hot', 'time'] },
  }, ['action', 'video']),
  tool('bilibili_inbox', 'Read replies, @ mentions, likes, system notices and private messages. notifications reads unread counts only. inbox reads all new categories and marks notifications read (limit per category, max 20). Category reads can also acknowledge notifications. replies/mentions/likes accept next_cursor. DM list/read leave unread state unchanged; mark_read acknowledges the returned sequence. Unknown acknowledgements are not retried.', {
    action: { type: 'string', enum: ['notifications', 'inbox', 'replies', 'mentions', 'likes', 'system', 'list', 'read', 'mark_read'] }, threadId: string, cursor: string,
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'inbox: at most 20 per category; other actions: at most 50.' },
  }),
  tool('bilibili_publish', 'Submit one or multiple workspace-local videos with the mature bili-agent VideoUploader, or inspect a submitted archive. submit performs upload and publication in one call; defaults to the AI-content declaration. Unknown outcomes require platform inspection before another submit. Files and symlink targets must be inside the workspace.', {
    action: { type: 'string', enum: ['submit', 'status'] },
    files: { type: 'array', minItems: 1, maxItems: 20, items: string }, title: { type: 'string', minLength: 1, maxLength: 80 },
    tags: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 40 } },
    description: { type: 'string', maxLength: 2000 }, cover: { ...string, description: 'Optional workspace-local cover image; otherwise the CLI extracts one with FFmpeg.' }, bvid: string, tid: { type: 'integer', minimum: 1 }, zone: { type: 'integer', minimum: 1 },
    schedule: { ...string, description: 'ISO datetime; platform accepts 2 hours to 15 days ahead.' },
    private: { type: 'boolean', default: false }, aiDeclare: { type: 'boolean', default: true },
  }),
  tool('bilibili_account', 'Manage the explicitly configured bili-agent profile. login returns a QR image for the human; status polls that login or validates/refreshes its credentials. logout removes only that profile login. asr_status inspects ASR configuration. Does not import browser cookies or use an implicit user home.', {
    action: { type: 'string', enum: ['login', 'status', 'logout', 'asr_status'] },
  }),
  tool('bilibili_diagnose', 'Check the installed bili-agent version and ASR dependencies in the explicit profile. Requires bili-agent 1.0.0. No login or external write is started.', {} , []),
];
