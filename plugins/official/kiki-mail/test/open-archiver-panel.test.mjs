import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { mailServiceForTests } from '../entry.mjs';
import { FIXTURE_API_KEY, guardedLoopbackFetch, startOpenArchiverFixture } from './open-archiver-fixture.mjs';

function createDomHarness() {
  const elements = new Map();
  const makeNode = (tag = 'div', id = '') => {
    const attrs = new Map();
    const styleProps = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      id,
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      open: false,
      readOnly: false,
      className: '',
      textContent: '',
      lang: 'en',
      dataset: {},
      children: [],
      parentElement: undefined,
      style: {
        setProperty(key, value) { styleProps.set(key, value); },
        getPropertyValue(key) { return styleProps.get(key) || ''; },
      },
      setAttribute(key, value) { attrs.set(key, String(value)); },
      getAttribute(key) { return attrs.get(key) ?? null; },
      removeAttribute(key) { attrs.delete(key); },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
      append(...nodes) {
        for (const child of nodes) {
          if (child && typeof child === 'object') child.parentElement = this;
          this.children.push(child);
        }
      },
      remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      },
      closest() { return null; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
    };
    return node;
  };
  const documentElement = makeNode('html', 'root');
  const get = (id) => {
    if (!elements.has(id)) {
      const node = makeNode('div', id);
      if (id === 'mailbox') node.value = 'INBOX';
      if (id === 'limit') node.value = '20';
      if (id === 'preset') node.value = 'custom';
      if (id === 'auth') node.value = 'password';
      if (id === 'unseen') node.parentElement = makeNode('div', 'unseenGroup');
      if (id === 'accountSelect') node.parentElement = makeNode('div', 'accountSelectGroup');
      elements.set(id, node);
    }
    return elements.get(id);
  };
  return {
    elements,
    get,
    document: {
      documentElement,
      activeElement: null,
      getElementById: get,
      createElement: (tag) => makeNode(tag),
      querySelectorAll: () => [],
    },
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function scriptFrom(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  return script;
}

function makeContext(dataDir, settings) {
  return {
    settings,
    dataDir,
    userHome: dataDir,
    kikiHome: dataDir,
    workspaceRoot: dataDir,
    approvedPaths: [],
    async updateSettings(patch) { Object.assign(settings, patch); },
    onActivity() {},
    focusSession() {},
  };
}

function mountPanel(script, service, context, dom, requests) {
  let receive;
  const parent = {
    postMessage(request, targetOrigin) {
      assert.equal(targetOrigin, 'https://kiki.example.test');
      assert.equal(request.channel, 'kiki.panel.v1');
      assert.equal(request.method, 'plugin.call');
      requests.push(request);
      queueMicrotask(async () => {
        const result = await service.panel(request.action, request.args, context);
        receive({ source: parent, origin: 'https://kiki.example.test', data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok: true, result } });
      });
    },
  };
  runInNewContext(script, {
    document: dom.document,
    navigator: { language: 'en-US' },
    window: { addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; } },
    parent,
    URL,
    crypto: { randomUUID: () => 'open-archiver-panel-request' },
  });
  return {
    init(presentation) {
      receive({ source: parent, origin: 'https://kiki.example.test', data: { channel: 'kiki.panel.v1', kind: 'init', presentation } });
    },
  };
}

function archiveCalls(requests, action) {
  return requests.filter((request) => request.action === action);
}

test('Open Archiver panel wizard, saved default reader boot, pagination, read and attachments stay archive-only', { timeout: 30_000 }, async () => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  const script = scriptFrom(html);
  const fixture = await startOpenArchiverFixture();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kiki-mail-open-archiver-panel-'));
  const settings = { accounts: '[]', credentials: '{}', watchEnabled: false };
  const context = makeContext(dataDir, settings);
  const service = mailServiceForTests({ archiveFetch: guardedLoopbackFetch(fixture) });
  await service.activate(context);
  const setupDom = createDomHarness();
  const setupRequests = [];
  const setupPanel = mountPanel(script, service, context, setupDom, setupRequests);
  const get = setupDom.get;
  let bootService;
  try {
    setupPanel.init();
    await flush();

    get('newAccount').onclick();
    get('preset').value = 'open-archiver';
    get('preset').onchange();
    assert.equal(get('userField').hidden, true, 'Open Archiver does not ask for a mailbox user');
    assert.equal(get('fromField').hidden, true);
    assert.equal(get('serverDetails').hidden, true, 'Open Archiver does not ask for IMAP/SMTP settings');
    assert.equal(get('customDetails').hidden, true);
    assert.equal(get('sendOnlyGroup').hidden, true);
    assert.equal(get('watchDetails').hidden, true);
    assert.equal(get('archiveGroup').hidden, true, 'the URL and key appear only in the credential step');
    assert.equal(get('authStep').hidden, true);

    get('id').value = 'archive';
    get('label').value = 'Fixture Archive';
    get('wizardNext').onclick();
    get('wizardNext').onclick();
    assert.equal(get('testDraft').hidden, false);
    assert.equal(get('save').hidden, true);
    assert.equal(get('archiveGroup').hidden, false);

    get('testDraft').onclick();
    await flush();
    assert.equal(get('fieldIssue').hidden, false, 'the service URL is required');
    assert.equal(archiveCalls(setupRequests, 'testDraft').length, 0);

    get('baseUrl').value = fixture.baseUrl;
    get('baseUrl').oninput();
    get('testDraft').onclick();
    await flush();
    assert.equal(get('fieldIssue').hidden, false, 'the API key is required');
    assert.equal(archiveCalls(setupRequests, 'testDraft').length, 0);

    get('archiveKey').value = FIXTURE_API_KEY;
    get('archiveKey').oninput();
    await get('testDraft').onclick();
    await flush();
    const draftCall = archiveCalls(setupRequests, 'testDraft').at(-1);
    assert.ok(draftCall);
    assert.deepEqual(JSON.parse(JSON.stringify(draftCall.args.account)), {
      id: 'archive', label: 'Fixture Archive', note: '', preset: 'open-archiver', baseUrl: fixture.baseUrl,
    });
    for (const forbidden of ['user', 'from', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'uid', 'uidValidity']) assert.equal(forbidden in draftCall.args.account, false, forbidden);
    assert.deepEqual(JSON.parse(JSON.stringify(draftCall.args.credential)), { apiKey: FIXTURE_API_KEY });
    assert.equal(get('archiveKey').value, '', 'API key is cleared after the connection test');
    assert.equal(get('password').value, '');
    assert.equal(get('save').hidden, false);

    await get('save').onclick();
    await flush();
    assert.equal(JSON.parse(settings.accounts).length, 1);
    assert.equal(JSON.parse(settings.accounts)[0].preset, 'open-archiver');
    assert.deepEqual(JSON.parse(settings.credentials), { archive: { apiKey: FIXTURE_API_KEY } });
    const savedState = await service.panel('state', {}, context);
    assert.equal(savedState.defaultReadAccountId, 'archive', 'the saved Open Archiver account is the default reader even without a direct mailbox');
    assert.equal(get('archiveKey').value, '', 'API key remains cleared after save');
    assert.equal(get('user').value, '');
    assert.equal(get('imapHost').value, '');
    assert.equal(get('smtpHost').value, '');

    bootService = mailServiceForTests({ archiveFetch: guardedLoopbackFetch(fixture) });
    await bootService.activate(context);
    const bootDom = createDomHarness();
    const bootRequests = [];
    const bootPanel = mountPanel(script, bootService, context, bootDom, bootRequests);
    bootPanel.init();
    await flush();
    const bootSearch = archiveCalls(bootRequests, 'search').find((request) => request.args.accountId === 'archive');
    assert.ok(bootSearch, 'a saved Open Archiver default reader searches during panel boot');
    assert.equal('uid' in bootSearch.args, false);
    assert.equal('uidValidity' in bootSearch.args, false);
    assert.equal('partId' in bootSearch.args, false);
    assert.equal(bootDom.get('sendSection').hidden, true);
    assert.equal(bootDom.get('replyFromRead').hidden, true);
    assert.equal(bootDom.get('unseen').parentElement.hidden, true);
    assert.equal(bootDom.get('mailboxField').hidden, true);
    assert.equal(bootDom.get('archiveFilters').hidden, false);

    const bootGet = bootDom.get;
    bootGet('limit').value = '1';
    await bootGet('search').onclick();
    await flush();
    assert.equal(bootGet('messageList').children.length, 1);
    assert.equal(bootGet('messageList').children[0].children[1].children.length, 1, 'archive rows only expose Read, not Reply');
    const firstMessage = bootGet('messageList').children[0];
    await firstMessage.onclick();
    await flush();
    const readCall = archiveCalls(bootRequests, 'read').at(-1);
    assert.ok(readCall);
    assert.deepEqual(JSON.parse(JSON.stringify(readCall.args)), { accountId: 'archive', query: '', from: '', since: '', limit: 1, cursor: '', sourceIds: [], mailboxes: [], archiveId: 'archive-001', attachmentId: '' });
    assert.equal('uid' in readCall.args, false);
    assert.equal(bootGet('messageView').hidden, false);
    assert.equal(bootGet('attachmentList').children.length, 2);

    const emlButton = bootGet('attachmentList').children[0].children[1];
    await emlButton.onclick();
    await flush();
    const emlCall = archiveCalls(bootRequests, 'attachment').at(-1);
    assert.ok(emlCall.args.attachmentId.startsWith('eml:'));
    assert.equal(emlCall.args.archiveId, 'archive-001');
    assert.equal('uid' in emlCall.args, false);
    assert.equal('uidValidity' in emlCall.args, false);
    assert.equal('partId' in emlCall.args, false);

    const storedButton = bootGet('attachmentList').children[1].children[1];
    await storedButton.onclick();
    await flush();
    const storedCall = archiveCalls(bootRequests, 'attachment').at(-1);
    assert.equal(storedCall.args.attachmentId, 'stored:stored-part-001');
    assert.equal(storedCall.args.archiveId, 'archive-001');
    assert.equal('uid' in storedCall.args, false);
    assert.equal('uidValidity' in storedCall.args, false);
    assert.equal('partId' in storedCall.args, false);

    await bootGet('nextPage').onclick();
    await flush();
    const pageTwoSearch = archiveCalls(bootRequests, 'search').at(-1);
    assert.ok(pageTwoSearch.args.cursor);
    assert.equal(pageTwoSearch.args.accountId, 'archive');
    assert.equal('uid' in pageTwoSearch.args, false);
    assert.equal('uidValidity' in pageTwoSearch.args, false);
    assert.equal(bootGet('messageList').children.length, 1);
    const pageTwoRow = bootGet('messageList').children[0];
    assert.equal(pageTwoRow.children[0].children[0].textContent, 'Stored original message');
    assert.match(pageTwoRow.children[0].children[1].textContent, /Fixture archive beta · owner-beta@example\.test/);
    assert.doesNotMatch(pageTwoRow.children[0].children[1].textContent, /source-beta/);

    fixture.assertClean();
  } finally {
    await service.deactivate();
    if (typeof bootService !== 'undefined') await bootService.deactivate();
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
