import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

function harness(script) {
  const nodes = new Map();
  const node = () => ({ value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {}, children: [], setAttribute() {}, append(...xs) { this.children.push(...xs); }, replaceChildren(...xs) { this.children = xs; }, focus() {} });
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let receive;
  let uuid = 0;
  const requests = [];
  const parent = { postMessage(request) { requests.push(request); } };
  runInNewContext(script, { document: { getElementById: get, createElement: node, querySelectorAll: () => [] }, window: { addEventListener(_, fn) { receive = fn; } }, parent, crypto: { randomUUID: () => `request-${++uuid}` } });
  const reply = (request, result, ok = true) => receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'response', id: request.id, ok, result, error: ok ? undefined : result } });
  const last = () => requests.at(-1);
  const switchTo = (id) => { get('accountSelect').value = id; get('accountSelect').onchange(); };
  const read = (uid) => { get('uid').value = uid; get('uidValidity').value = '7'; return get('read').onclick(); };
  const message = (accountId, uid, subject = uid) => ({ ok: true, identity: { accountId, mailbox: 'INBOX', uidValidity: '7', uid }, subject, text: subject, attachments: [{ partId: '2', filename: 'note.txt' }] });
  const present = (locale) => receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'presentation', presentation: { locale } } });
  return { get, requests, reply, last, switchTo, read, message, present, init: async (routeView = { supported: false }) => {
    receive({ source: parent, data: { channel: 'kiki.panel.v1', kind: 'init' } });
    for (const req of requests.slice()) reply(req, req.action === 'state' ? { accounts: ['a', 'b'].map((id) => ({ id, label: id, user: `${id}@example.test`, credentialStored: true, hasPassword: true })) } : req.action === 'routes' ? routeView : { presets: [] });
    await new Promise(setImmediate);
    get('mailbox').value = 'INBOX';
  } };
}

const script = (await readFile(new URL('../panel.html', import.meta.url), 'utf8')).match(/<script>([\s\S]*?)<\/script>/)[1];

test('deferred reads stay with their account and newest message; stale attachment closures cannot execute', async () => {
  const h = harness(script); await h.init();
  const old = h.read('10'); const oldReq = h.last();
  h.switchTo('b');
  h.reply(oldReq, h.message('a', '10', 'A private')); await old;
  assert.equal(h.get('messageView').hidden, true);
  assert.equal(h.get('uid').value, '');
  h.switchTo('a');
  const first = h.read('10'); const firstReq = h.last();
  const second = h.read('11'); const secondReq = h.last();
  h.reply(secondReq, h.message('a', '11', 'Latest')); await second;
  const oldButton = h.get('attachmentList').children[0].children[1];
  h.reply(firstReq, h.message('a', '10', 'Older')); await first;
  assert.equal(h.get('readSubject').textContent, 'Latest');
  assert.equal(h.get('uid').value, '11');
  const attachment = oldButton.onclick(); const attReq = h.last();
  const reload = h.read('11'); h.reply(h.last(), h.message('a', '11', 'Reloaded')); await reload;
  const status = h.get('status').textContent;
  h.reply(attReq, 'Old attachment error', false); await attachment;
  assert.equal(h.get('status').textContent, status);
  assert.equal(h.get('attachmentStatus').hidden, true);
  h.switchTo('b'); const count = h.requests.length;
  await oldButton.onclick();
  assert.equal(h.requests.length, count);
  assert.equal(h.get('uid').value, '');
});

test('late list, folder, attachment and send results cannot change a new account or draft', async () => {
  const h = harness(script); await h.init();
  const folders = h.get('folders').onclick(); const foldersReq = h.last();
  const search = h.get('search').onclick(); const searchReq = h.last();
  const reading = h.read('10'); h.reply(h.last(), h.message('a', '10')); await reading;
  const attachment = h.get('attachmentList').children[0].children[1].onclick(); const attReq = h.last();
  h.get('to').value = 'receiver@example.test'; h.get('text').value = 'Old draft';
  const send = h.get('send').onclick(); const sendReq = h.last();
  h.switchTo('b'); h.get('text').value = 'New draft';
  h.reply(foldersReq, { ok: true, mailboxes: [{ path: 'A private' }] });
  h.reply(searchReq, { ok: true, messages: [{ uid: '10', subject: 'A private' }], nextCursor: 'old-page' });
  h.reply(attReq, { ok: true, path: 'old-file', filename: 'note.txt' });
  h.reply(sendReq, { ok: false, outcome: 'rejected', message: 'Old send failed' });
  await Promise.all([folders, search, attachment, send]);
  assert.equal(h.get('folderList').children.length, 0);
  assert.equal(h.get('nextPage').disabled, true);
  assert.equal(h.get('attachmentStatus').hidden, true);
  assert.equal(h.get('sendNote').textContent, '');
  assert.equal(h.get('sendAgain').hidden, true);
  assert.equal(h.get('text').value, 'New draft');
  assert.equal(h.requests.filter((r) => r.action === 'send').length, 1);
  const fresh = h.get('send').onclick(); const freshReq = h.last();
  assert.equal(freshReq.args.accountId, 'b');
  assert.notEqual(freshReq.args.requestId, sendReq.args.requestId);
  h.get('text').value = 'Edited during send';
  h.reply(freshReq, { ok: true, outcome: 'accepted', message: 'Old draft accepted' }); await fresh;
  assert.equal(h.get('sendNote').textContent, '');
});

test('newest search wins, mailbox changes reject stale errors, and unsaved id edits do not change execution account', async () => {
  const h = harness(script); await h.init();
  h.get('id').value = 'unsaved';
  const first = h.get('search').onclick(); const firstReq = h.last();
  assert.equal(firstReq.args.accountId, 'a');
  const second = h.get('search').onclick(); const secondReq = h.last();
  h.reply(secondReq, { ok: true, uidValidity: '7', messages: [{ uid: '11', subject: 'New' }] }); await second;
  h.reply(firstReq, { ok: true, uidValidity: '7', messages: [{ uid: '10', subject: 'Old' }], nextCursor: 'old' }); await first;
  assert.equal(h.get('messageList').children[0].children[0].children[0].textContent, 'New');
  const reading = h.read('11'); const req = h.last();
  h.get('mailbox').value = 'Archive'; h.get('mailbox').onchange();
  const status = h.get('status').textContent;
  h.reply(req, 'Old mailbox error', false); await reading;
  assert.equal(h.get('status').textContent, status);
  assert.equal(h.get('messageView').hidden, true);
});

test('presentation updates localize dynamic states without exposing protocol ids or translating server errors', async () => {
  const views = [
    [null, 'Notification channels load', '正在加载通知渠道'],
    [{ supported: false }, 'unsupported', '未启用 IM 桥接'],
    [{ supported: true, outbound: false }, 'not available', '暂不可用'],
    [{ supported: true, outbound: true }, 'is available', '已就绪'],
    [{ supported: true, outbound: true, routes: [] }, 'No notification channel', '暂无可用'],
    [{ supported: true, outbound: true, routes: [{ channelId: 'desk', label: 'Desk' }] }, 'Choose a notification channel', '请选择通知渠道'],
  ];
  for (const [view, en, zh] of views) {
    const h = harness(script); await h.init(view);
    assert.ok(h.get('im').textContent.includes(en));
    h.present('zh-CN');
    assert.ok(h.get('im').textContent.includes(zh));
    assert.equal(h.get('status').textContent, '未测试');
    assert.ok(h.get('secretStatus').textContent.includes('已保存密码'));
    assert.equal(h.get('imChannel').children[0].textContent, '无');
    h.present('en-US');
    assert.ok(h.get('im').textContent.includes(en));
  }
  const h = harness(script); await h.init();
  const search = h.get('search').onclick();
  h.reply(h.last(), { ok: true, uidValidity: '7', messages: [{ uid: '10', uidValidity: '7', subject: 'Hello', flags: [] }], nextCursor: 'next' }); await search;
  const reading = h.read('10');
  h.reply(h.last(), { ...h.message('a', '10', 'Hello'), from: 'sender@example.test', to: 'a@example.test', date: '2026-10-19' }); await reading;
  h.present('zh-CN');
  assert.ok(h.get('pageStatus').textContent.includes('封邮件'));
  assert.ok(h.get('pageStatus').textContent.includes('还有更多'));
  assert.ok(h.get('messageList').children[0].children[0].children[0].textContent.includes('[未读]'));
  assert.ok(h.get('readFrom').textContent.startsWith('发件人'));
  for (const id of ['mailboxSummary', 'readMeta', 'replyTargetText']) assert.equal(/UID/.test(h.get(id).textContent), false);
  h.get('replyFromRead').onclick();
  assert.equal(h.get('uid').value, '10');
  assert.equal(h.get('uidValidity').value, '7');
  const folders = h.get('folders').onclick(); h.reply(h.last(), { ok: true, mailboxes: [{ path: 'INBOX' }] }); await folders;
  assert.equal(h.get('mailboxSummary').textContent, '1 个文件夹');
  const save = h.get('save').onclick(); h.reply(h.last(), { ok: true, account: { id: 'a', label: 'a', user: 'a@example.test', hasPassword: true, credentialStored: true } });
  await new Promise(setImmediate);
  h.reply(h.last(), { accounts: [{ id: 'a', label: 'a', user: 'a@example.test', hasPassword: true, credentialStored: true }] }); await save;
  assert.equal(h.get('status').textContent, '已保存，尚未测试');
  assert.equal(h.get('accountFeedback').textContent, '账号已保存。');
  h.present('en-US');
  assert.equal(h.get('status').textContent, 'Saved. Not tested.');
  assert.equal(h.get('accountFeedback').textContent, 'Account saved.');
  const failed = h.get('search').onclick(); h.reply(h.last(), { ok: false, message: 'Original server error' }); await failed;
  h.present('zh-CN');
  assert.equal(h.get('status').textContent, 'Original server error');
});
