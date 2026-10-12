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
});
