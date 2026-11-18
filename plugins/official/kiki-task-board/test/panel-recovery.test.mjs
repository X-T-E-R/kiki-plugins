import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*)<\/script>/)[1];

function boot() {
  const elements = new Map();
  class El {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.dataset = {};
      this.listeners = {};
      this.attributes = {};
      this.firstChild = { textContent: '' };
      this._value = '';
    }
    get options() { return this.children; }
    get value() {
      if (this.tag !== 'select') return this._value;
      if (this.children.some((option) => option.value === this._value)) return this._value;
      return this.children[0]?.value ?? '';
    }
    set value(next) { this._value = next; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
  }
  for (const id of ['title', 'workspace-label', 'workspace', 'title-label', 'priority-label', 'detail-label', 'save', 'lang', 'status', 'columns', 'card-title', 'detail', 'priority']) {
    const tag = id === 'workspace' || id === 'priority' ? 'select' : 'div';
    elements.set(id, new El(tag));
  }
  elements.get('priority')._value = 'P1';
  elements.get('priority').children = [{ value: 'P1' }];
  const timers = [];
  let clock = 0;
  const writes = [];
  const windowListeners = [];
  const window = {
    listeners: windowListeners,
    addEventListener(type, fn) { if (type === 'message') windowListeners.push(fn); },
    parent: { postMessage(message) { window.parentDeliver(message); } },
  };
  const document = {
    documentElement: { lang: 'en' },
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new El(tag),
  };
  const context = vm.createContext({
    window,
    document,
    navigator: { language: 'en-US' },
    Map,
    Promise,
    Error,
    Object,
    Date,
    setTimeout(fn, ms) {
      const entry = { fn, at: clock + ms, cancelled: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout(entry) { if (entry) entry.cancelled = true; },
  });
  context.window = window;
  context.window.parentDeliver = () => {};
  vm.runInContext(source, context, { filename: 'panel.html' });
  function emit(data) {
    for (const listener of windowListeners) listener({ source: window.parent, data });
  }
  function reply(id, fields) {
    emit({ channel: 'kiki.panel.v1', kind: 'response', id, ...fields });
  }
  window.parentDeliver = (message) => {
    if (message.method === 'plugin.call' && message.action === 'write' && message.args.action === 'create') {
      writes.push(message);
      return;
    }
    queueMicrotask(() => {
      if (message.action === 'workspaces') reply(message.id, { ok: true, result: { ok: true, value: { workspaces: [{ id: 'wd-1', name: 'Harbor' }, { id: 'wd-2', name: 'Other' }] } } });
      else if (message.action === 'read') reply(message.id, { ok: true, result: { ok: true, value: { cards: [] } } });
      else reply(message.id, { ok: true, result: { ok: true, value: {} } });
    });
  };
  async function drain() {
    for (let step = 0; step < 12; step += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  async function advance(ms) {
    clock += ms;
    const due = timers.filter((entry) => !entry.cancelled && entry.at <= clock);
    for (const entry of due) entry.cancelled = true;
    for (const entry of due) entry.fn();
    await drain();
  }
  return { elements, writes, emit, reply, drain, advance };
}

async function ready() {
  const page = boot();
  page.emit({ channel: 'kiki.panel.v1', kind: 'init' });
  await page.drain();
  page.elements.get('card-title').value = 'Harbor card';
  page.elements.get('detail').value = 'Keep this draft';
  return page;
}

test('a lost save restores the button and retries the same create', async () => {
  const page = await ready();
  const save = page.elements.get('save');
  const click = save.listeners.click[0];
  void click();
  await page.drain();
  assert.equal(page.writes.length, 1);
  const key = page.writes[0].args.requestKey;
  assert.equal(save.disabled, true);
  await page.advance(12000);
  assert.equal(save.disabled, false);
  assert.equal(page.writes.length, 1);
  assert.equal(page.elements.get('card-title').value, 'Harbor card');
  assert.equal(page.elements.get('detail').value, 'Keep this draft');
  assert.match(page.elements.get('status').textContent, /No save result came back/);

  void click();
  await page.drain();
  assert.equal(page.writes.length, 2);
  assert.equal(page.writes[1].args.requestKey, key);
  page.reply(page.writes[1].id, { ok: false, error: 'bridge down' });
  await page.drain();
  assert.equal(save.disabled, false);
  assert.equal(page.elements.get('card-title').value, 'Harbor card');
  assert.equal(page.elements.get('status').textContent, 'bridge down');

  void click();
  await page.drain();
  assert.equal(page.writes[2].args.requestKey, key);
  page.reply(page.writes[2].id, { ok: true, result: { ok: false, error: { message: 'disk full' } } });
  await page.drain();
  assert.equal(page.elements.get('card-title').value, 'Harbor card');
  assert.equal(page.elements.get('status').textContent, 'disk full');

  void click();
  await page.drain();
  assert.equal(page.writes[3].args.requestKey, key);
  page.reply(page.writes[3].id, { ok: true, result: { ok: true, value: { id: 'card-1' } } });
  await page.drain();
  assert.equal(page.elements.get('card-title').value, '');
  assert.equal(page.elements.get('detail').value, '');
  assert.equal(page.elements.get('status').textContent, 'Card saved.');
  assert.equal(page.writes.length, 4);
});

test('a late accept after an unknown save does not send another create', async () => {
  const page = await ready();
  const click = page.elements.get('save').listeners.click[0];
  void click();
  await page.drain();
  const sent = page.writes[0];
  await page.advance(12000);
  assert.equal(page.writes.length, 1);
  page.reply(sent.id, { ok: true, result: { ok: true, value: { id: 'card-1' } } });
  await page.drain();
  assert.equal(page.writes.length, 1);
  assert.equal(page.elements.get('card-title').value, '');
  assert.equal(page.elements.get('status').textContent, 'Card saved.');
});

test('an edited draft survives a timely accept', async () => {
  const page = await ready();
  const click = page.elements.get('save').listeners.click[0];
  void click();
  await page.drain();
  page.elements.get('card-title').value = 'Harbor card revised';
  page.elements.get('detail').value = 'New text';
  const priority = page.elements.get('priority');
  priority.children.push({ value: 'P2' });
  priority.value = 'P2';
  page.reply(page.writes[0].id, { ok: true, result: { ok: true, value: { id: 'card-1' } } });
  await page.drain();
  assert.equal(page.writes.length, 1);
  assert.equal(page.elements.get('card-title').value, 'Harbor card revised');
  assert.equal(page.elements.get('detail').value, 'New text');
  assert.equal(page.elements.get('priority').value, 'P2');
  assert.equal(page.elements.get('status').textContent, 'The earlier save was accepted. The text now in the form was left as it is.');
});

test('a workspace change survives a timely accept and a late accept', async () => {
  const timely = await ready();
  const timelyClick = timely.elements.get('save').listeners.click[0];
  void timelyClick();
  await timely.drain();
  timely.elements.get('workspace').value = 'wd-2';
  timely.reply(timely.writes[0].id, { ok: true, result: { ok: true, value: { id: 'card-1' } } });
  await timely.drain();
  assert.equal(timely.writes.length, 1);
  assert.equal(timely.elements.get('workspace').value, 'wd-2');
  assert.equal(timely.elements.get('card-title').value, 'Harbor card');
  assert.equal(timely.elements.get('detail').value, 'Keep this draft');
  assert.equal(timely.elements.get('status').textContent, 'The earlier save was accepted. The text now in the form was left as it is.');

  const late = await ready();
  const lateClick = late.elements.get('save').listeners.click[0];
  void lateClick();
  await late.drain();
  const sent = late.writes[0];
  await late.advance(12000);
  late.elements.get('workspace').value = 'wd-2';
  late.reply(sent.id, { ok: true, result: { ok: true, value: { id: 'card-1' } } });
  await late.drain();
  assert.equal(late.writes.length, 1);
  assert.equal(late.elements.get('workspace').value, 'wd-2');
  assert.equal(late.elements.get('card-title').value, 'Harbor card');
  assert.equal(late.elements.get('detail').value, 'Keep this draft');
  assert.equal(late.elements.get('status').textContent, 'The earlier save was accepted. The text now in the form was left as it is.');
});

test('the panel no longer prints the address sentence', () => {
  assert.equal(html.includes('id="lead"'), false);
  assert.equal(html.includes('Requirement cards stay at their original addresses.'), false);
  assert.equal(html.includes('需求卡片仍在原来的地址。'), false);
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), false);
  assert.match(html, /--bg:\s*#f6f4ef/i);
  assert.match(html, /--bg:\s*#141413/i);
  assert.match(html, /--accent:\s*#2c5e4f/i);
  assert.match(html, /--accent:\s*#58a88f/i);
});

test('survives opaque sandbox SecurityError on localStorage and supports Enter create, capsule flow, drag drop, inline edit, search, and theme sync', async () => {
  const elements = new Map();
  class RichEl {
    constructor(tag) {
      this.tag = tag;
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.hidden = false;
      this.dataset = {};
      this.listeners = {};
      this.attributes = {};
      this.firstChild = { textContent: '' };
      this.style = {};
      this._value = '';
    }
    get options() { return this.children; }
    get value() {
      if (this.tag !== 'select') return this._value;
      if (this.children.some((option) => option.value === this._value)) return this._value;
      return this.children[0]?.value ?? '';
    }
    set value(next) { this._value = next; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    focus() {}
    remove() {}
    querySelectorAll() { return []; }
  }
  for (const id of [
    'title', 'board-summary', 'search', 'clear-search', 'workspace-label', 'workspace',
    'mobile-mode', 'lang', 'title-label', 'priority-label', 'detail-label', 'toggle-detail',
    'detail-wrap', 'save', 'status', 'mobile-bar', 'columns', 'card-title', 'detail', 'priority',
  ]) {
    const tag = id === 'workspace' || id === 'priority' ? 'select' : 'div';
    elements.set(id, new RichEl(tag));
  }
  elements.get('priority')._value = 'P1';
  elements.get('priority').children = [{ value: 'P1' }, { value: 'P0' }, { value: 'P2' }, { value: 'P3' }];

  const patches = [];
  const creates = [];
  const cards = [
    {
      id: 'card-alpha',
      workspaceId: 'wd-1',
      storage: { root: '/tmp/store', storageId: 'st-1', kind: 'embedded' },
      title: 'Alpha draft',
      description: 'First card',
      priority: 'P1',
      status: 'active',
      revision: 3,
    },
  ];
  const windowListeners = [];
  const windowObj = {
    addEventListener(type, fn) { (windowListeners[type] ??= []).push(fn); },
    parent: { postMessage(msg) { deliver(msg); } },
  };
  Object.defineProperty(windowObj, 'localStorage', {
    get() { throw new Error('SecurityError: opaque origin'); },
  });
  const docRoot = { lang: 'en', dataset: {}, style: { setProperty() {} } };
  const doc = {
    documentElement: docRoot,
    body: new RichEl('body'),
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new RichEl(tag),
    createElementNS: (_ns, tag) => new RichEl(tag),
    execCommand: () => true,
    querySelectorAll: () => [],
  };
  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    location: { search: '?theme=dark' },
    URLSearchParams,
    navigator: { language: 'zh-CN' },
    Map, Set, Promise, Error, Object, Date, Array, String, Number, Boolean, JSON,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  function emit(data) {
    for (const fn of windowListeners.message ?? []) fn({ source: windowObj.parent, data });
  }
  function deliver(msg) {
    queueMicrotask(() => {
      if (msg.action === 'workspaces') {
        emit({ channel: 'kiki.panel.v1', kind: 'response', id: msg.id, ok: true, result: { ok: true, value: { workspaces: [{ id: 'wd-1', name: 'Studio' }] } } });
      } else if (msg.action === 'read') {
        emit({ channel: 'kiki.panel.v1', kind: 'response', id: msg.id, ok: true, result: { ok: true, value: { cards: cards.map((c) => ({ ...c })) } } });
      } else if (msg.action === 'write' && msg.args.action === 'create') {
        creates.push(msg.args);
        cards.push({
          id: 'card-beta',
          workspaceId: msg.args.workspaceId,
          storage: { root: '/tmp/store', storageId: 'st-1', kind: 'embedded' },
          title: msg.args.title,
          description: msg.args.description || '',
          priority: msg.args.priority || 'P1',
          status: 'active',
          revision: 1,
        });
        emit({ channel: 'kiki.panel.v1', kind: 'response', id: msg.id, ok: true, result: { ok: true, value: { id: 'card-beta' } } });
      } else if (msg.action === 'write' && msg.args.action === 'update') {
        patches.push(msg.args);
        const found = cards.find((c) => c.id === msg.args.id);
        if (found) {
          Object.assign(found, msg.args.patch);
          found.revision += 1;
        }
        emit({ channel: 'kiki.panel.v1', kind: 'response', id: msg.id, ok: true, result: { ok: true, value: found } });
      }
    });
  }
  async function flush() {
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  }

  vm.runInContext(source, ctx, { filename: 'panel.html' });
  assert.equal(docRoot.dataset.theme, 'dark');

  emit({ channel: 'kiki.panel.v1', kind: 'init', presentation: { theme: 'light', locale: 'en' } });
  await flush();
  assert.equal(docRoot.dataset.theme, 'light');

  // Enter-to-create in #card-title
  const titleInput = elements.get('card-title');
  titleInput.value = 'Quick keyboard task';
  titleInput.listeners.keydown[0]({ key: 'Enter', isComposing: false, preventDefault() {} });
  await flush();
  assert.equal(creates.length, 1);
  assert.equal(creates[0].title, 'Quick keyboard task');
  assert.equal(titleInput.value, '');

  // Find active lane and first card
  const findNodes = (root, pred, acc = []) => {
    if (pred(root)) acc.push(root);
    for (const ch of root.children || []) findNodes(ch, pred, acc);
    return acc;
  };
  const columns = elements.get('columns');
  const firstCard = findNodes(columns, (n) => n.dataset?.card === 'card-alpha')[0];
  assert.ok(firstCard);

  // One-click status capsule flow (active -> in_progress)
  const flowBtn = findNodes(firstCard, (n) => n.dataset?.action === 'flow')[0];
  assert.ok(flowBtn);
  flowBtn.listeners.click[0]();
  await flush();
  assert.deepEqual({ ...patches.at(-1).patch }, { status: 'in_progress' });

  // Drag-and-drop card-beta onto done lane
  const betaCard = findNodes(columns, (n) => n.dataset?.card === 'card-beta')[0];
  betaCard.listeners.dragstart[0]({ dataTransfer: { setData() {} } });
  const doneLane = findNodes(columns, (n) => n.dataset?.lane === 'done')[0];
  doneLane.listeners.drop[0]({ preventDefault() {}, dataTransfer: { getData: () => 'card-beta' } });
  await flush();
  assert.deepEqual({ ...patches.at(-1).patch }, { status: 'done' });

  // Double-click title -> inline edit title & priority -> Enter to save
  const refreshedAlpha = findNodes(columns, (n) => n.dataset?.card === 'card-alpha')[0];
  const heading = findNodes(refreshedAlpha, (n) => n.tag === 'h3')[0];
  heading.listeners.dblclick[0]();
  const editingCard = findNodes(columns, (n) => n.dataset?.card === 'card-alpha')[0];
  const editInput = findNodes(editingCard, (n) => n.tag === 'input')[0];
  const editSelect = findNodes(editingCard, (n) => n.tag === 'select')[0];
  editInput.value = 'Alpha refined';
  editSelect.value = 'P0';
  editInput.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.deepEqual({ ...patches.at(-1).patch }, { title: 'Alpha refined', priority: 'P0' });

  // Search filter narrows visible cards
  const search = elements.get('search');
  search.value = 'refined';
  search.listeners.input[0]();
  assert.equal(findNodes(columns, (n) => n.dataset?.card === 'card-alpha').length, 1);
  assert.equal(findNodes(columns, (n) => n.dataset?.card === 'card-beta').length, 0);
});
