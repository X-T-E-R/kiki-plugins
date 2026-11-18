import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));

test('manifest ships manuscript panel at 0.1.2 with zero UI emojis and exact paper-and-ink tokens', () => {
  assert.equal(manifest.version, '0.1.2');
  assert.equal(manifest['x-kiki'].permissions.uiPanel, true);
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), false);
  assert.match(html, /--bg:\s*#f6f4ef/i);
  assert.match(html, /--bg:\s*#141413/i);
  assert.match(html, /--accent:\s*#2c5e4f/i);
  assert.match(html, /--accent:\s*#58a88f/i);
  assert.match(html, /font-synthesis:\s*none/);
  assert.match(html, /execCommand\('copy'\)/);
});

test('writing desk survives sandbox SecurityError and handles outline jump, serif/sans toggle, diff view, copy fallback, and session.sendMessage', async () => {
  const elements = new Map();
  class Node {
    constructor(tag = 'div') {
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
      this.style = {};
      this.value = '';
      this.placeholder = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.scrollHeight = 400;
      this.scrollTop = 0;
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(name, val) { this.attributes[name] = String(val); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    focus() {}
    select() {}
    remove() {}
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  }

  for (const id of [
    'heading', 'outline-toggle', 'outline-btn-text', 'mode-write', 'mode-diff',
    'font-serif', 'font-sans', 'copy-btn', 'copy-text', 'lang-btn',
    'outline-pane', 'outline-title', 'outline-list', 'draft',
    'diff-pane', 'diff-caption', 'diff-delta', 'pin-baseline', 'diff-body',
    'stats', 'status', 'intent', 'send', 'send-text',
  ]) {
    const el = new Node(id === 'draft' ? 'textarea' : id === 'intent' ? 'select' : 'div');
    elements.set(id, el);
  }

  let execCopied = false;
  const posted = [];
  const winListeners = {};
  const win = {
    addEventListener(type, fn) { (winListeners[type] ??= []).push(fn); },
    parent: { postMessage(msg) { posted.push(msg); } },
  };
  Object.defineProperty(win, 'localStorage', {
    get() { throw new Error('SecurityError: sandboxed iframe'); },
  });

  const docRoot = { lang: 'zh-CN', dataset: {}, style: { setProperty() {} } };
  const doc = {
    documentElement: docRoot,
    body: new Node('body'),
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new Node(tag),
    execCommand: (cmd) => { if (cmd === 'copy') { execCopied = true; return true; } return false; },
  };

  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { search: '?theme=dark' },
    URLSearchParams,
    navigator: { language: 'zh-CN' },
    Map, Set, Promise, Error, Object, Array, String, Number, Boolean, Math, Uint16Array,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(script, ctx, { filename: 'panel.html' });

  assert.equal(docRoot.dataset.theme, 'dark');
  assert.equal(docRoot.dataset.typeface, 'serif');

  // Switch typeface to sans
  elements.get('font-sans').listeners.click[0]();
  assert.equal(docRoot.dataset.typeface, 'sans');

  // Init session + theme presentation
  for (const fn of winListeners.message) {
    fn({ source: win.parent, data: { channel: 'kiki.panel.v1', kind: 'init', sessionId: 'sess-99', presentation: { theme: 'light', locale: 'zh-CN' } } });
  }
  assert.equal(docRoot.dataset.theme, 'light');

  // Input manuscript with headings -> outline auto-appears + stats update
  const draft = elements.get('draft');
  draft.value = '# 第一章 雾起\n\n江面微凉，船灯未熄。\n\n## 第二节 渡口\n\n远处传来橹声。';
  draft.listeners.input[0]();
  assert.equal(elements.get('outline-pane').hidden, false);
  assert.equal(elements.get('outline-list').children.length, 2);
  assert.match(elements.get('stats').textContent, /字 · 4 段 · 约 1 分钟/);

  // Click second outline item -> jumps caret to "## 第二节 渡口"
  const secondItem = elements.get('outline-list').children[1];
  secondItem.listeners.click[0]();
  assert.ok(draft.selectionStart > 0);
  assert.equal(draft.value.slice(draft.selectionStart).startsWith('## 第二节 渡口'), true);

  // Pin baseline, edit revision, switch to Diff
  elements.get('pin-baseline').listeners.click[0]();
  draft.value = '# 第一章 雾起\n\n江面微凉，渔火未熄。\n\n## 第二节 渡口\n\n远处传来急促的橹声。';
  draft.listeners.input[0]();
  elements.get('mode-diff').listeners.click[0]();
  assert.equal(elements.get('diff-pane').hidden, false);
  assert.equal(draft.hidden, true);
  assert.ok(elements.get('diff-body').children.some((n) => n.tag === 'del' && n.textContent.includes('船灯')));
  assert.ok(elements.get('diff-body').children.some((n) => n.tag === 'ins' && n.textContent.includes('渔火')));

  // Copy uses execCommand('copy') fallback when navigator.clipboard is unavailable
  await elements.get('copy-btn').listeners.click[0]();
  assert.equal(execCopied, true);
  assert.equal(elements.get('status').textContent, '已复制全文');

  // Send review command via session.sendMessage
  draft.selectionStart = 0;
  draft.selectionEnd = 0;
  elements.get('intent').value = 'polish';
  const sendTask = elements.get('send').listeners.click[0]();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].method, 'session.sendMessage');
  assert.equal(posted[0].sessionId, 'sess-99');
  assert.match(posted[0].text, /请按原稿语境精炼润色以下段落/);
  assert.match(posted[0].text, /渔火未熄/);
  for (const fn of winListeners.message) {
    fn({ source: win.parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: posted[0].id, ok: true } });
  }
  await sendTask;
  assert.equal(elements.get('status').textContent, '已发送至当前会话');
});
