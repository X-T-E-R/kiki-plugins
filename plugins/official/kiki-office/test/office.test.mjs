import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { createOfficeCore } from '../lib/office.mjs';
import { OFFICECLI_VERSION, CHECKSUMS_SHA256, findBinary, parseChecksum, platformAsset, installPinnedBinary, runProcess } from '../lib/binary.mjs';
import { guardPackage } from '../lib/package-guard.mjs';
import { definitions } from '../lib/definitions.mjs';

const root = path.dirname(import.meta.dirname);
let directory;
let binary;
let core;

before(async () => {
  directory = await mkdtemp(path.join(root, '.tmp-office-'));
  binary = process.env.OFFICECLI_TEST_BINARY;
  core = createOfficeCore({ scope: { workspaceRoot: directory, binaryPath: binary } });
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const run = (name, args, context) => core.run(name, args, context);
const yes = async (name, args, context) => {
  const result = await run(name, args, context);
  assert.equal(result.success, true, JSON.stringify(result.error));
  return result.data;
};
const no = async (name, args, code, context) => {
  const result = await run(name, args, context);
  assert.equal(result.success, false, `Expected ${code}; got ${JSON.stringify(result)}`);
  assert.equal(result.error.code, code, `Expected ${code}; got ${JSON.stringify(result.error)}`);
  assert.ok(result.error.suggestion);
};

async function buildZipBuffer(entries, { compress = true } = {}) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    zip.addBuffer(buf, name, { compress });
  }
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return done;
}

async function readZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const map = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(map));
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) { zip.close(); return reject(err2); }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => { map.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

async function attachEmbeddedChartWorkbook(archivePath, { chartXmlPath, chartRelsPath, embedPath, embedRelTarget }) {
  const entries = await readZipEntries(await readFile(archivePath));
  const embeddedWorkbook = await buildZipBuffer(makeMinimalXlsxEntries({
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>Cat</t></is></c><c r="B1" t="inlineStr"><is><t>YS</t></is></c></row>
  <row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2"><v>10</v></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>B</t></is></c><c r="B3"><v>20</v></c></row>
</sheetData></worksheet>`,
  }));
  // Inject <c:numRef>/<c:strRef> + <c:externalData r:id="rId1"/> into the generated chart part
  let chartXml = entries.get(chartXmlPath).toString('utf8');
  chartXml = chartXml
    .replace(/<c:strLit>[\s\S]*?<\/c:strLit>/, `<c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef>`)
    .replace(/<c:numLit>[\s\S]*?<\/c:numLit>/, `<c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef>`)
    .replace('</c:chartSpace>', '<c:externalData r:id="rId1"/></c:chartSpace>');
  if (!chartXml.includes('xmlns:r=')) {
    chartXml = chartXml.replace('<c:chartSpace ', '<c:chartSpace xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  }
  entries.set(chartXmlPath, Buffer.from(chartXml, 'utf8'));
  entries.set(chartRelsPath, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="${embedRelTarget}"/>
</Relationships>`, 'utf8'));
  entries.set(embedPath, embeddedWorkbook);
  let ct = entries.get('[Content_Types].xml').toString('utf8');
  if (!ct.includes('Extension="xlsx"')) {
    ct = ct.replace('</Types>', '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Types>');
    entries.set('[Content_Types].xml', Buffer.from(ct, 'utf8'));
  }
  const obj = Object.fromEntries(entries.entries());
  await writeFile(archivePath, await buildZipBuffer(obj));
}

function makeMinimalXlsxEntries(extra = {}) {
  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>`,
    ...extra,
  };
}

async function makeMinimalDocxBuffer(extra = {}, { contentTypesExtra = '', docRelsExtra = '' } = {}) {
  return buildZipBuffer({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${contentTypesExtra}
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRelsExtra}</Relationships>`,
    ...extra,
  });
}

async function makeMinimalPptxBuffer(extra = {}, { contentTypesExtra = '', slideRelsExtra = '' } = {}) {
  return buildZipBuffer({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  ${contentTypesExtra}
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRelsExtra}</Relationships>`,
    ...extra,
  });
}

void test('manifest and SDK 12-tool contract stay synchronized with exact accesses and closed batch schema', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest['x-kiki'].prerequisites.items[0].version, '1.0.163');
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  assert.equal(definitions.length, 12);

  const byName = new Map(definitions.map((d) => [d.name, d]));
  assert.deepEqual(
    [...byName.keys()],
    [
      'office_create', 'office_get', 'office_query', 'office_set', 'office_add', 'office_remove',
      'office_view', 'office_batch', 'office_preview', 'office_validate', 'office_help', 'office_import',
    ],
  );

  for (const definition of definitions) {
    assert.ok(definition.description.length < 600, `${definition.name} description too long`);
    assert.equal(definition.disclosure, 'deferred');
    assert.ok(definition.accesses.some((access) => access.kind === 'all'));
    assert.equal(definition.parameters.additionalProperties, false);
  }

  // Exact special access contracts
  const help = byName.get('office_help');
  assert.deepEqual(help.accesses, [{ kind: 'all' }]);
  assert.equal(help.parameters.properties.file, undefined);

  const validate = byName.get('office_validate');
  assert.deepEqual(validate.accesses, [{ kind: 'file', operation: 'read', path: '$.file' }, { kind: 'all' }]);

  const imp = byName.get('office_import');
  assert.deepEqual(imp.accesses, [
    { kind: 'file', operation: 'readwrite', path: '$.file' },
    { kind: 'file', operation: 'read', path: '$.source' },
    { kind: 'all' },
  ]);

  // Closed batch schema with 8 verbs and disjoint props anyOf
  const batch = byName.get('office_batch');
  assert.equal(batch.parameters.properties.commands.maxItems, 128);
  const branches = batch.parameters.properties.commands.items.anyOf;
  assert.equal(branches.length, 8);
  assert.deepEqual(
    branches.map((b) => b.properties.command.enum[0]),
    ['add', 'set', 'remove', 'move', 'swap', 'get', 'query', 'validate'],
  );
  for (const branch of branches) {
    assert.equal(branch.additionalProperties, false);
  }
  const setProps = branches.find((b) => b.properties.command.enum[0] === 'set').properties.props;
  assert.equal(Array.isArray(setProps.anyOf), true);
  assert.deepEqual(setProps.anyOf.map((s) => s.type), ['object', 'array']);
});

void test('the actual plugin host runner registers all 12 tools but rejects file calls without workspace context', { skip: !process.env.KIKI_HOST_RUNNER }, async () => {
  const runner = path.resolve(process.env.KIKI_HOST_RUNNER);
  const child = spawn(process.execPath, [runner, path.join(root, 'entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const incoming = createInterface({ input: child.stdout });
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Plugin host response timed out')), 10_000);
    incoming.on('line', (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.method === 'ready') send(1, 'execute', { name: 'office_create', args: { file: 'report.docx' } });
      if (message.id === 1) { clearTimeout(timeout); resolve(message); }
    });
    child.once('error', reject);
  });
  try {
    send(0, 'handshake', { version: 1 });
    const executed = await received;
    assert.equal(messages.filter((message) => message.method === 'register').length, definitions.length);
    assert.equal(JSON.parse(executed.result.output).code, 'WORKSPACE_UNAVAILABLE');
  } finally {
    child.kill();
    incoming.close();
  }
});

void test('pinned release checksums, 6-platform assets, and explicit consent', async () => {
  assert.equal(OFFICECLI_VERSION, '1.0.163');
  assert.equal(CHECKSUMS_SHA256, '6c3fa68aba6f0fccfee8cc0be1053040132f2b45b3d107e17b7d9761fa6d50f5');
  assert.equal(platformAsset('win32', 'x64'), 'officecli-win-x64.exe');
  assert.equal(platformAsset('win32', 'arm64'), 'officecli-win-arm64.exe');
  assert.equal(platformAsset('darwin', 'arm64'), 'officecli-mac-arm64');
  assert.equal(platformAsset('darwin', 'x64'), 'officecli-mac-x64');
  assert.equal(platformAsset('linux', 'x64'), 'officecli-linux-x64');
  assert.equal(platformAsset('linux', 'arm64'), 'officecli-linux-arm64');
  assert.throws(() => platformAsset('freebsd', 'x64'), { code: 'PLATFORM_UNSUPPORTED' });
  assert.equal(parseChecksum(`${'a'.repeat(64)}  officecli-win-x64.exe`, 'officecli-win-x64.exe'), 'a'.repeat(64));
  await assert.rejects(installPinnedBinary({ consent: false, destination: path.join(directory, 'no.exe') }), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(installPinnedBinary({ consent: true, destination: path.join(directory, 'no.exe'), fetchRelease: async () => Buffer.from('tampered') }), { code: 'CHECKSUM_INVALID' });
  await assert.rejects(findBinary({ binaryPath: process.execPath }), { code: 'VERSION_MISMATCH' });
});

void test('package-guard admits genuine chart workbooks, customXml, printerSettings, fonts and inert web hyperlinks', async () => {
  const embeddedXlsx = await buildZipBuffer(makeMinimalXlsxEntries());
  const validDocx = await makeMinimalDocxBuffer(
    {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`,
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/>
</Relationships>`,
      'word/embeddings/Microsoft_Excel_Worksheet1.xlsx': embeddedXlsx,
      'customXml/item1.xml': `<?xml version="1.0" encoding="UTF-8"?><b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"><b:Source><b:URL>https://doi.org/10.1000/test</b:URL></b:Source></b:Sources>`,
      'customXml/itemProps1.xml': `<?xml version="1.0" encoding="UTF-8"?><ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"/>`,
      'customXml/_rels/item1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/>
</Relationships>`,
      'word/printerSettings/printerSettings1.bin': Buffer.alloc(512, 0x20),
      'word/fonts/font1.odttf': Buffer.alloc(128, 0x41),
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
  <Override PartName="/word/printerSettings/printerSettings1.bin" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.printerSettings"/>`,
      docRelsExtra: `
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://doi.org/10.1000/xyz" TargetMode="External"/>`,
    },
  );
  const docxPath = path.join(directory, 'valid-sci.docx');
  await writeFile(docxPath, validDocx);
  await guardPackage(docxPath);

  const validPptx = await makeMinimalPptxBuffer(
    {
      'ppt/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`,
      'ppt/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/>
</Relationships>`,
      'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx': embeddedXlsx,
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
      slideRelsExtra: `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>`,
    },
  );
  const pptxPath = path.join(directory, 'valid-sci.pptx');
  await writeFile(pptxPath, validPptx);
  await guardPackage(pptxPath);
});

void test('package-guard rejects nested depth>1, macros, ActiveX, OLE, external rels, DTD/XXE, over-budget, and bad CRC before engine invocation', async () => {
  const badPath = path.join(directory, 'guard-neg.docx');
  const writeAndReject = async (buf, expectedCode, target = badPath) => {
    await writeFile(target, buf);
    await assert.rejects(guardPackage(target), { code: expectedCode });
  };

  // 1. Non-ZIP
  await writeAndReject(Buffer.from('not a zip'), 'PACKAGE_INVALID');

  // 2. Depth 2 nested embedding inside embedded chart workbook
  const depth2Child = await buildZipBuffer(makeMinimalXlsxEntries({
    'xl/embeddings/inner.xlsx': Buffer.from('nested'),
  }));
  const depth2Docx = await makeMinimalDocxBuffer(
    {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`,
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/chart.xlsx"/>
</Relationships>`,
      'word/embeddings/chart.xlsx': depth2Child,
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    },
  );
  await writeAndReject(depth2Docx, 'UNKNOWN_BINARY_PART');

  // 3. Invalid child workbook (not an XLSX)
  const fakeChildDocx = await makeMinimalDocxBuffer(
    {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`,
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/fake.xlsx"/>
</Relationships>`,
      'word/embeddings/fake.xlsx': Buffer.from('not a zip workbook'),
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    },
  );
  await writeAndReject(fakeChildDocx, 'PACKAGE_INVALID');

  // 4. Orphan unreferenced embedding
  const orphanDocx = await makeMinimalDocxBuffer(
    { 'word/embeddings/orphan.xlsx': await buildZipBuffer(makeMinimalXlsxEntries()) },
    { contentTypesExtra: `<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>` },
  );
  await writeAndReject(orphanDocx, 'UNKNOWN_BINARY_PART');

  // 5. External relationship inside child workbook
  const extChild = await buildZipBuffer(makeMinimalXlsxEntries({
    'xl/worksheets/_rels/sheet1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`,
  }));
  const extChildDocx = await makeMinimalDocxBuffer(
    {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`,
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/ext.xlsx"/>
</Relationships>`,
      'word/embeddings/ext.xlsx': extChild,
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    },
  );
  await writeAndReject(extChildDocx, 'PACKAGE_UNSAFE');

  // 6. External relationship inside customXml
  const extCustomXmlDocx = await makeMinimalDocxBuffer({
    'customXml/item1.xml': `<?xml version="1.0" encoding="UTF-8"?><root/>`,
    'customXml/_rels/item1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.example/leak" TargetMode="External"/>
</Relationships>`,
  });
  await writeAndReject(extCustomXmlDocx, 'PACKAGE_UNSAFE');

  // 7. External attachedTemplate and file:// hyperlink at depth 0
  const extTemplateDocx = await makeMinimalDocxBuffer({}, {
    docRelsExtra: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/tpl.dotm" TargetMode="External"/>`,
  });
  await writeAndReject(extTemplateDocx, 'PACKAGE_UNSAFE');

  const fileLinkDocx = await makeMinimalDocxBuffer({}, {
    docRelsExtra: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file://attacker/share/pwn" TargetMode="External"/>`,
  });
  await writeAndReject(fileLinkDocx, 'PACKAGE_UNSAFE');

  // 8. VBA macro, ActiveX, OLE, and macroEnabled content type
  const vbaDocx = await makeMinimalDocxBuffer({ 'word/vbaProject.bin': Buffer.from('macro') });
  await writeAndReject(vbaDocx, 'UNKNOWN_BINARY_PART');

  const activeXDocx = await makeMinimalDocxBuffer({ 'word/activeX/activeX1.xml': `<ocx/>` });
  await writeAndReject(activeXDocx, 'UNKNOWN_BINARY_PART');

  const oleDocx = await makeMinimalDocxBuffer(
    { 'word/embeddings/oleObject1.bin': Buffer.from('ole') },
    { contentTypesExtra: `<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>` },
  );
  await writeAndReject(oleDocx, 'PACKAGE_UNSAFE');

  const macroContentTypeDocx = await buildZipBuffer({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
  });
  await writeAndReject(macroContentTypeDocx, 'PACKAGE_UNSAFE');

  // 9. DTD / XXE in customXml
  const xxeDocx = await makeMinimalDocxBuffer({
    'customXml/item1.xml': `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>`,
  });
  await writeAndReject(xxeDocx, 'PACKAGE_UNSAFE');

  // 10. Printer settings > 1 MiB
  const bigPrinterDocx = await makeMinimalDocxBuffer(
    { 'word/printerSettings/printerSettings1.bin': Buffer.alloc(1024 * 1024 + 64, 0x11) },
    { contentTypesExtra: `<Override PartName="/word/printerSettings/printerSettings1.bin" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.printerSettings"/>` },
  );
  await writeAndReject(bigPrinterDocx, 'PACKAGE_LIMIT');

  // 11. Compression ratio bomb (>200:1)
  const bombDocx = await makeMinimalDocxBuffer({
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'A'.repeat(2_000_000)}</w:t></w:r></w:p></w:body></w:document>`,
  });
  await writeAndReject(bombDocx, 'PACKAGE_LIMIT');

  // 12. ZIP structural attacks: corrupted CRC-32, encrypted flag, case-insensitive duplicate, LFH/CD mismatch, traversal & missing rels
  const cleanStored = await buildZipBuffer({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
  }, { compress: false });

  // Corrupted CRC-32 (flip one byte in stored payload)
  const badCrc = Buffer.from(cleanStored);
  const payloadIdx = badCrc.indexOf('<w:document');
  badCrc[payloadIdx + 2] ^= 0x01;
  await writeAndReject(badCrc, 'PACKAGE_INVALID');

  // Encrypted entry flag (set general purpose bit 0 in first LFH and first CD header of a compressed archive)
  const encryptedZip = Buffer.from(await makeMinimalDocxBuffer());
  encryptedZip.writeUInt16LE(encryptedZip.readUInt16LE(6) | 0x0001, 6);
  const firstCd = encryptedZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encryptedZip.writeUInt16LE(encryptedZip.readUInt16LE(firstCd + 8) | 0x0001, firstCd + 8);
  await writeAndReject(encryptedZip, 'PACKAGE_UNSAFE');

  // LFH vs CD filename mismatch (mutate byte at offset 30, which is the first LFH filename '[Content_Types].xml')
  const lfhMismatch = Buffer.from(cleanStored);
  lfhMismatch[31] = 'c'.charCodeAt(0);
  await writeAndReject(lfhMismatch, 'PACKAGE_UNSAFE');

  // Case-insensitive duplicate part name
  const dupCaseDocx = await makeMinimalDocxBuffer({
    'Word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
  });
  await writeAndReject(dupCaseDocx, 'PACKAGE_UNSAFE');

  // Internal OPC target escaping package root
  const escapeRelDocx = await makeMinimalDocxBuffer({}, {
    docRelsExtra: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../etc/passwd"/>`,
  });
  await writeAndReject(escapeRelDocx, 'PACKAGE_UNSAFE');

  // Missing internal OPC target
  const missingRelDocx = await makeMinimalDocxBuffer({}, {
    docRelsExtra: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/missing.png"/>`,
  });
  await writeAndReject(missingRelDocx, 'PACKAGE_INVALID');

  // LFH vs CD generalPurposeBitFlag mismatch (flip UTF-8 flag 0x0800 only in LFH)
  const flagMismatch = Buffer.from(cleanStored);
  flagMismatch.writeUInt16LE(flagMismatch.readUInt16LE(6) ^ 0x0800, 6);
  await writeAndReject(flagMismatch, 'PACKAGE_UNSAFE');

  // Overlapping local ZIP records (point second CD entry's local header offset to offset 0)
  const overlapZip = Buffer.from(cleanStored);
  const cd1 = overlapZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const cd2 = overlapZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cd1 + 4);
  overlapZip.writeUInt32LE(0, cd2 + 42);
  await writeAndReject(overlapZip, 'PACKAGE_UNSAFE');

  // Phantom chart .rels without an existing owning chart part
  const phantomChartRels = await makeMinimalDocxBuffer(
    {
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/chart.xlsx"/>
</Relationships>`,
      'word/embeddings/chart.xlsx': await buildZipBuffer(makeMinimalXlsxEntries()),
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    },
  );
  await writeAndReject(phantomChartRels, 'PACKAGE_INVALID');

  // Depth-1 workbook with wrong XML root element
  const fakeRootChild = await buildZipBuffer(makeMinimalXlsxEntries({
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><notWorkbook xmlns="http://example.invalid"/>`,
  }));
  const fakeRootDocx = await makeMinimalDocxBuffer(
    {
      'word/charts/chart1.xml': `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`,
      'word/charts/_rels/chart1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/badroot.xlsx"/>
</Relationships>`,
      'word/embeddings/badroot.xlsx': fakeRootChild,
    },
    {
      contentTypesExtra: `
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    },
  );
  await writeAndReject(fakeRootDocx, 'PACKAGE_INVALID');

  // 13. Guard covers ALL existing-package paths (reads, validate, preview, import destination, edits) BEFORE invoke
  let invoked = false;
  const guardedCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => { invoked = true; return 'officecli-test'; },
    invoke: async () => { invoked = true; return { code: 0, stdout: '{}', stderr: '' }; },
  });
  await writeFile(badPath, vbaDocx);
  const bytesBefore = await readFile(badPath);
  for (const [toolName, args] of [
    ['office_get', { file: 'guard-neg.docx', path: '/' }],
    ['office_query', { file: 'guard-neg.docx', selector: 'paragraph' }],
    ['office_view', { file: 'guard-neg.docx', mode: 'text' }],
    ['office_validate', { file: 'guard-neg.docx' }],
    ['office_preview', { file: 'guard-neg.docx' }],
    ['office_set', { file: 'guard-neg.docx', path: '/', props: { author: 'x' } }],
    ['office_add', { file: 'guard-neg.docx', parent: '/body', type: 'paragraph' }],
    ['office_remove', { file: 'guard-neg.docx', path: '/body/p[1]' }],
    ['office_batch', { file: 'guard-neg.docx', commands: [{ command: 'validate' }] }],
  ]) {
    const res = await guardedCore.run(toolName, args);
    assert.equal(res.success, false, `${toolName} must reject poisoned docx`);
    assert.equal(invoked, false, `${toolName} must not invoke engine on poisoned docx`);
  }
  assert.deepEqual(await readFile(badPath), bytesBefore, 'Guarded failure must leave bytes untouched');

  // Poisoned import destination .xlsx
  const badXlsxPath = path.join(directory, 'guard-neg.xlsx');
  const csvPath = path.join(directory, 'sample.csv');
  await writeFile(badXlsxPath, await buildZipBuffer(makeMinimalXlsxEntries({ 'xl/vbaProject.bin': Buffer.from('vba') })));
  await writeFile(csvPath, 'A,B\n1,2\n');
  const impRes = await guardedCore.run('office_import', { file: 'guard-neg.xlsx', sheet: '/Sheet1', source: 'sample.csv' });
  assert.equal(impRes.success, false);
  assert.equal(invoked, false);
});

void test('office_help works without workspaceRoot; office_validate returns invalid findings; exit code 2 preserves warnings', async () => {
  // Fileless office_help without workspaceRoot
  const helpCalls = [];
  const helpCore = createOfficeCore({
    scope: {},
    locateBinary: async () => 'officecli-test',
    invoke: async (_bin, args) => {
      helpCalls.push(args);
      return { code: 0, stdout: JSON.stringify({ element: 'equation', properties: { formula: { type: 'string' } } }), stderr: '' };
    },
  });
  const helpRes = await helpCore.run('office_help', { format: 'docx', verb: 'add', element: 'equation' });
  assert.equal(helpRes.success, true, JSON.stringify(helpRes.error));
  assert.deepEqual(helpCalls[0], ['help', 'docx', 'add', 'equation', '--json']);
  assert.equal((await helpCore.run('office_help', { format: 'pdf' })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await helpCore.run('office_help', { format: 'docx', element: '../bad' })).error.code, 'ARGUMENT_INVALID');

  // Valid archive fixture for mocked engine tests
  const goodDocxPath = path.join(directory, 'mock-good.docx');
  await writeFile(goodDocxPath, await makeMinimalDocxBuffer());

  // office_validate returns structured invalid-document findings on exit 1
  const valCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async () => ({
      code: 1,
      stdout: JSON.stringify({ success: false, data: { count: 1, errors: [{ type: 'Schema', description: 'Invalid child' }] } }),
      stderr: '',
    }),
  });
  const valRes = await valCore.run('office_validate', { file: 'mock-good.docx' });
  assert.equal(valRes.success, true);
  const valBody = JSON.parse(valRes.data);
  assert.equal(valBody.valid, false);
  assert.equal(valBody.count, 1);
  assert.equal(valBody.errors.length, 1);

  // Exit code 2: accepted ONLY when parsed JSON has success: true & no error/rollback
  const warnCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async (_bin, args) => {
      if (args[0] === 'add') {
        return { code: 2, stdout: JSON.stringify({ success: true, data: 'Added', warnings: [{ code: 'unsupported_property', message: 'Ignored foo' }] }), stderr: '' };
      }
      return { code: 2, stdout: JSON.stringify({ success: false, warnings: [{ code: 'all_refused', message: 'All refused' }] }), stderr: '' };
    },
  });
  const warnOk = await warnCore.run('office_add', { file: 'mock-good.docx', parent: '/body', type: 'paragraph', props: { text: 'Hi' } });
  assert.equal(warnOk.success, true);
  assert.equal(JSON.parse(warnOk.data).warnings[0].code, 'unsupported_property');

  const warnFail = await warnCore.run('office_set', { file: 'mock-good.docx', path: '/body/p[1]', props: { foo: 'bar' } });
  assert.equal(warnFail.success, false);
  assert.equal(warnFail.error.code, 'ENGINE_ERROR');
});

void test('office_batch validates disjoint props, case-insensitive duplicates, find/replace translation, and blocks undeclared file reads', async () => {
  const goodDocxPath = path.join(directory, 'batch-unit.docx');
  await writeFile(goodDocxPath, await makeMinimalDocxBuffer());
  const receivedInputs = [];
  const batchCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async (_bin, _args, opts) => {
      receivedInputs.push(JSON.parse(opts.input));
      return { code: 0, stdout: JSON.stringify({ success: true, data: { results: [] } }), stderr: '' };
    },
  });

  // Both map and ["k=v"] props + legacy find/replace translation
  const ok = await batchCore.run('office_batch', {
    file: 'batch-unit.docx',
    commands: [
      { command: 'add', parent: '/body', type: 'paragraph', props: ['text=Eq: a=b', 'bold=true'] },
      { command: 'set', path: '/body/p[1]', find: 'a=b', replace: 'c=d', props: { italic: true } },
      { command: 'move', path: '/body/p[1]', index: 0 },
      { command: 'swap', path: '/body/p[1]', path2: '/body/p[2]' },
      { command: 'query', selector: '*', compact: true, fields: 'style' },
      { command: 'validate' },
    ],
  });
  assert.equal(ok.success, true, JSON.stringify(ok.error));
  assert.deepEqual(receivedInputs[0][0].props, { text: 'Eq: a=b', bold: 'true' });
  assert.deepEqual(receivedInputs[0][1], { command: 'set', path: '/body/p[1]', props: { italic: 'true', find: 'a=b', replace: 'c=d' } });

  // Rejections
  for (const commands of [
    [{ command: 'set', path: '/body/p[1]', props: { Bold: true, bold: false } }], // case-insensitive dup
    [{ command: 'set', path: '/body/p[1]', props: ['Bold=true', 'bold=false'] }], // array dup
    [{ command: 'set', path: '/body/p[1]', props: ['noequals'] }], // malformed k=v
    [{ command: 'set', path: '/body/p[1]', props: { nested: { a: 1 } } }], // nested object
    [{ command: 'set', path: '/body/p[1]', find: 'only-find' }], // missing replace
    [{ command: 'set', path: '/body/p[1]', find: 'a', replace: 'b', props: { FIND: 'x' } }], // collision
    [{ command: 'raw-set', part: 'word/document.xml' }], // disallowed raw verb
    [{ command: 'add', parent: '/body', type: 'ole', props: { src: 'x' } }], // blocked ole
    [{ command: 'add', parent: '/body', type: 'picture', props: { src: '/etc/passwd' } }], // undeclared fs read
    [{ command: 'add', parent: '/body', type: 'picture', props: { src: 'https://evil.test/x.png' } }], // undeclared url
    [{ command: 'add', parent: '/body', from: '../other.docx#/body/p[1]' }], // non-internal from
    [{ command: 'add', parent: '/body', type: 'table', props: { data: '/etc/passwd' } }], // file path in data
    [{ command: 'add', parent: '/body', type: 'table', props: { data: 'Method,Score;Ours,98.4' } }], // data blocked completely (FileSource.Exists)
  ]) {
    const res = await batchCore.run('office_batch', { file: 'batch-unit.docx', commands });
    assert.equal(res.success, false, `Expected batch rejection for ${JSON.stringify(commands)}`);
    assert.equal(res.error.code, 'ARGUMENT_INVALID');
  }

  // Inline image data-URI is permitted
  const inlineOk = await batchCore.run('office_batch', {
    file: 'batch-unit.docx',
    commands: [
      { command: 'add', parent: '/body/p[1]', type: 'picture', props: { src: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  });
  assert.equal(inlineOk.success, true, JSON.stringify(inlineOk.error));

  // Verify summary.atomicRolledBack is treated as failure, oversized mutation receipt returns bounded success, and concurrent edit rejects commit
  const rollbackCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async () => ({ code: 0, stdout: JSON.stringify({ success: true, data: { summary: { atomicRolledBack: true } } }), stderr: '' }),
  });
  assert.equal((await rollbackCore.run('office_batch', { file: 'batch-unit.docx', commands: [{ command: 'validate' }] })).success, false);

  const bigReceiptCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async () => ({
      code: 2,
      stdout: JSON.stringify({
        success: true,
        data: { summary: { total: 100, succeeded: 100 } },
        warnings: Array.from({ length: 400 }, (_, i) => ({ code: 'warn', message: `Warning #${i}: ${'w'.repeat(200)}` })),
      }),
      stderr: '',
    }),
  });
  const bigRes = await bigReceiptCore.run('office_batch', { file: 'batch-unit.docx', commands: [{ command: 'validate' }] });
  assert.equal(bigRes.success, true, JSON.stringify(bigRes.error));
  assert.ok(Buffer.byteLength(bigRes.data, 'utf8') <= 65_536);
  const bigParsed = JSON.parse(bigRes.data);
  assert.equal(bigParsed.truncated, true);
  assert.equal(bigParsed.summary.succeeded, 100);
  assert.ok(bigParsed.omittedWarnings > 0);
  assert.ok(Array.isArray(bigParsed.warnings) && bigParsed.warnings.length > 0);

  // Snapshot isolation & concurrent external modification detection
  let seenExecPath;
  const concurrentCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async (_bin, args) => {
      seenExecPath = args[1];
      await writeFile(goodDocxPath, await makeMinimalDocxBuffer({ 'word/comments.xml': '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' }));
      return { code: 0, stdout: JSON.stringify({ success: true, data: 'ok' }), stderr: '' };
    },
  });
  const concRes = await concurrentCore.run('office_set', { file: 'batch-unit.docx', path: '/body/p[1]', props: { bold: true } });
  assert.notEqual(seenExecPath, goodDocxPath, 'Engine must run against private snapshot, not live workspace path');
  assert.equal(concRes.success, false);
  assert.equal(concRes.error.code, 'CONCURRENT_MODIFICATION');
});

void test('office_import enforces dual-path admission, role-specific extensions, and source cap before spawn', async () => {
  const xlsxPath = path.join(directory, 'imp-target.xlsx');
  const csvPath = path.join(directory, 'imp-data.csv');
  await writeFile(xlsxPath, await buildZipBuffer(makeMinimalXlsxEntries()));
  await writeFile(csvPath, 'Sample,Val\nA,1\n');
  let invoked = false;
  const impCore = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async () => { invoked = true; return { code: 0, stdout: JSON.stringify({ success: true }), stderr: '' }; },
  });

  // Never allow CSV as Office destination
  assert.equal((await impCore.run('office_import', { file: 'imp-data.csv', sheet: '/Sheet1', source: 'imp-data.csv' })).error.code, 'FORMAT_UNSUPPORTED');
  // Reject non-CSV/TSV source
  assert.equal((await impCore.run('office_import', { file: 'imp-target.xlsx', sheet: '/Sheet1', source: 'imp-target.xlsx' })).error.code, 'FORMAT_UNSUPPORTED');
  // Reject outside-workspace source (both non-existent and existing outside file)
  assert.equal((await impCore.run('office_import', { file: 'imp-target.xlsx', sheet: '/Sheet1', source: '../outside.csv' })).error.code, 'PATH_OUTSIDE_WORKSPACE');
  const outsideDir = await mkdtemp(path.join(root, '.tmp-outside-'));
  try {
    const outsideCsv = path.join(outsideDir, 'secret.csv');
    await writeFile(outsideCsv, 'A,B\n1,2\n');
    assert.equal((await impCore.run('office_import', { file: 'imp-target.xlsx', sheet: '/Sheet1', source: outsideCsv })).error.code, 'PATH_OUTSIDE_WORKSPACE');
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
  // Reject oversized source (> 16 MiB)
  const bigCsv = path.join(directory, 'too-big.csv');
  await writeFile(bigCsv, Buffer.alloc(16 * 1024 * 1024 + 64, 0x41));
  assert.equal((await impCore.run('office_import', { file: 'imp-target.xlsx', sheet: '/Sheet1', source: 'too-big.csv' })).error.code, 'PACKAGE_LIMIT');
  assert.equal(invoked, false, 'Denied path must prevent invocation');
});

void test('office_preview supports single page, 1-12 page contact sheets, format-specific pages, xlsx range rules, and validates before outline fallback', async () => {
  const docxPath = path.join(directory, 'many-pages.docx');
  const pptxPath = path.join(directory, 'many-slides.pptx');
  const xlsxPath = path.join(directory, 'sheet-prev.xlsx');
  await writeFile(docxPath, await makeMinimalDocxBuffer());
  await writeFile(pptxPath, await makeMinimalPptxBuffer());
  await writeFile(xlsxPath, await buildZipBuffer(makeMinimalXlsxEntries()));
  const calls = [];
  const preview = createOfficeCore({
    scope: { workspaceRoot: directory },
    locateBinary: async () => 'officecli-test',
    invoke: async (_binary, args) => {
      calls.push(args);
      const output = args[args.indexOf('--out') + 1];
      if (output) await writeFile(output, Buffer.from('89504e470d0a1a0a', 'hex'));
      return { code: 0, stdout: 'outline', stderr: '' };
    },
  });

  // Single page > old cap; always uses CSP-sandboxed --render html
  const single = await preview.run('office_preview', { file: 'many-pages.docx', page: 101 }, { imageIn: true });
  assert.equal(single.success, true, JSON.stringify(single.error));
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--page'), calls[0].indexOf('--page') + 2), ['--page', '101']);
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--render'), calls[0].indexOf('--render') + 2), ['--render', 'html']);

  // Contact sheet 1-12 defaults grid=auto; docx accepts comma list 1,3
  const sheet = await preview.run('office_preview', { file: 'many-pages.docx', pages: '1-12' }, { imageIn: true });
  assert.equal(sheet.success, true, JSON.stringify(sheet.error));
  assert.equal(sheet.data.grid, 'auto');
  assert.ok(calls[1].includes('--grid'));
  assert.equal(calls[1][calls[1].indexOf('--grid') + 1], 'auto');
  assert.equal((await preview.run('office_preview', { file: 'many-pages.docx', pages: '1,3' }, { imageIn: true })).success, true);

  // Excel range-only preview (no --page/--grid/--render)
  const xl = await preview.run('office_preview', { file: 'sheet-prev.xlsx', range: 'Sheet1!A1:D10' }, { imageIn: true });
  assert.equal(xl.success, true, JSON.stringify(xl.error));
  assert.ok(!calls[3].includes('--page') && !calls[3].includes('--grid') && !calls[3].includes('--render'));

  // Rejections (including PPTX comma list, native render mode, and invalid pages even when imageIn=false)
  assert.equal((await preview.run('office_preview', { file: 'many-pages.docx', page: 0 }, { imageIn: true })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await preview.run('office_preview', { file: 'many-pages.docx', pages: '1-13' }, { imageIn: true })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await preview.run('office_preview', { file: 'many-pages.docx', pages: '1-13' }, { imageIn: false })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await preview.run('office_preview', { file: 'many-slides.pptx', pages: '1,3' }, { imageIn: true })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await preview.run('office_preview', { file: 'many-pages.docx', render: 'native' }, { imageIn: true })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await preview.run('office_preview', { file: 'many-pages.docx', page: 1, pages: '1-3' }, { imageIn: true })).error.code, 'ARGUMENT_INVALID');
  assert.equal((await preview.run('office_preview', { file: 'sheet-prev.xlsx', grid: 'auto' }, { imageIn: true })).error.code, 'ARGUMENT_INVALID');
});

void test('rejects missing engine, incompatible engine and path escapes', async () => {
  const missing = createOfficeCore({ scope: { workspaceRoot: directory }, locateBinary: async () => { throw Object.assign(new Error('Missing'), { code: 'ENGINE_MISSING', suggestion: 'Install pinned binary.' }); } });
  assert.equal((await missing.run('office_create', { file: 'missing.docx' })).error.code, 'ENGINE_MISSING');
  const mismatch = createOfficeCore({ scope: { workspaceRoot: directory }, locateBinary: async () => { throw Object.assign(new Error('Mismatch'), { code: 'VERSION_MISMATCH', suggestion: 'Install pinned binary.' }); } });
  assert.equal((await mismatch.run('office_create', { file: 'mismatch.docx' })).error.code, 'VERSION_MISMATCH');
  assert.equal((await createOfficeCore({ scope: {} }).run('office_create', { file: 'report.docx' })).error.code, 'WORKSPACE_UNAVAILABLE');
  await no('office_create', { file: '../escape.docx' }, 'PATH_OUTSIDE_WORKSPACE');
  await no('office_get', { file: 'absent.docx', path: '/' }, 'FILE_MISSING');
  await no('office_query', { file: 'absent.docx', selector: 'paragraph' }, 'FILE_MISSING');
  await no('office_view', { file: 'absent.docx' }, 'FILE_MISSING');
  await no('office_create', { file: path.join(directory, 'unknown.csv') }, 'FORMAT_UNSUPPORTED');
});

void test('Word scientific chain: three-line table, OMML equation, SEQ caption, positioning, exit-2 warnings, validate and compact query', { skip: !process.env.OFFICECLI_TEST_BINARY }, async () => {
  binary = await findBinary({ binaryPath: binary });
  assert.equal((await runProcess(binary, ['--version'])).stdout.trim(), OFFICECLI_VERSION);
  const file = 'sci-paper.docx';
  await yes('office_create', { file });
  await no('office_create', { file }, 'FILE_EXISTS');

  // Build scientific content atomically via office_batch (three-line table, CJK-Latin font, OMML equation, SEQ caption)
  await yes('office_batch', {
    file,
    commands: [
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: 'Hall-Petch Mechanical Analysis', style: 'Heading1', 'font.ascii': 'Times New Roman', 'font.ea': 'SimHei' } },
      { command: 'add', parent: '/body', type: 'equation', props: { mode: 'display', formula: '\\\\sigma_y = \\\\sigma_0 + k_y d^{-1/2}' } },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: 'Table ', keepNext: true } },
      { command: 'add', parent: '/body/p[2]', type: 'field', props: { fieldType: 'seq', identifier: 'Table' } },
      { command: 'add', parent: '/body/p[2]', type: 'run', props: { text: '. Alloy Tensile Properties (n = 3)' } },
      {
        command: 'add',
        parent: '/body',
        type: 'table',
        props: {
          rows: 2,
          cols: 3,
          width: '100%',
          align: 'center',
          'border.all': 'none',
          'border.top': 'single;12;000000',
          'border.bottom': 'single;12;000000',
        },
      },
      { command: 'set', path: '/body/tbl[1]/tr[1]', props: { header: true, cantSplit: true, c1: 'Alloy', c2: 'YS (MPa)', c3: 'EL (%)' } },
      { command: 'set', path: '/body/tbl[1]/tr[1]/tc[1]', props: { 'border.bottom': 'single;6;000000', bold: true, align: 'center' } },
      { command: 'set', path: '/body/tbl[1]/tr[1]/tc[2]', props: { 'border.bottom': 'single;6;000000', bold: true, align: 'center' } },
      { command: 'set', path: '/body/tbl[1]/tr[1]/tc[3]', props: { 'border.bottom': 'single;6;000000', bold: true, align: 'center' } },
      { command: 'set', path: '/body/tbl[1]/tr[2]', props: { cantSplit: true, c1: 'Ti-6Al-4V', c2: '912.1 ± 6.8', c3: '14.2 ± 0.4' } },
      { command: 'set', path: '/', props: { recalcFields: 'seq' } },
    ],
  });

  // Insert paragraph using positioning (after /body/p[1])
  await yes('office_add', { file, parent: '/body', type: 'paragraph', after: '/body/p[1]', props: { text: 'Abstract: Grain refinement follows Hall-Petch scaling.' } });

  // Verify Unicode Greek sigma & recalculated SEQ "Table 1" in text view
  const viewText = await yes('office_view', { file, mode: 'text' });
  assert.match(viewText, /σ/);
  assert.match(viewText, /Table 1\. Alloy Tensile Properties/);
  assert.match(viewText, /Abstract: Grain refinement/);

  // Compact query (plain-text format without --json)
  const compact = await yes('office_query', { file, selector: '*', compact: true });
  assert.match(compact, /total:/);

  // Exit-code-2 caveat preservation on real 1.0.163 binary
  const warnResult = JSON.parse(await yes('office_add', { file, parent: '/body', type: 'paragraph', props: { text: 'Caveat test', nonExistentOptionalProp: '1' } }));
  assert.equal(warnResult.success, true);
  assert.ok(Array.isArray(warnResult.warnings) && warnResult.warnings.length > 0);

  // OpenXML schema validation must pass with 0 errors
  const val = JSON.parse(await yes('office_validate', { file }));
  assert.equal(val.valid, true);
  assert.equal(val.count, 0);

  // Batch legacy find/replace translation
  await yes('office_batch', { file, commands: [{ command: 'set', path: '/body/p[2]', find: 'scaling', replace: 'behavior' }] });
  assert.match(await yes('office_view', { file, mode: 'text' }), /Hall-Petch behavior/);

  // Real DOCX chart-data edit round-trip: edit chart series and assert embedded .xlsx workbook cells updated
  const chartDocxName = 'chart-embedded-roundtrip.docx';
  const chartDocxAbs = path.join(directory, chartDocxName);
  await yes('office_create', { file: chartDocxName });
  await yes('office_add', { file: chartDocxName, parent: '/body', type: 'chart', props: { chartType: 'column', title: 'Alloy', categories: 'A,B', series1: 'YS:10,20' } });
  await attachEmbeddedChartWorkbook(chartDocxAbs, {
    chartXmlPath: 'word/charts/chart1.xml',
    chartRelsPath: 'word/charts/_rels/chart1.xml.rels',
    embedPath: 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx',
    embedRelTarget: '../embeddings/Microsoft_Excel_Worksheet1.xlsx',
  });
  await guardPackage(chartDocxAbs);
  await yes('office_set', { file: chartDocxName, path: '/chart[1]', props: { series1: 'YS:915,942' } });
  await guardPackage(chartDocxAbs);
  const docxAfterEntries = await readZipEntries(await readFile(chartDocxAbs));
  const docxEmbedEntries = await readZipEntries(docxAfterEntries.get('word/embeddings/Microsoft_Excel_Worksheet1.xlsx'));
  const docxSheetXml = docxEmbedEntries.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(docxSheetXml, /915/);
  assert.match(docxSheetXml, /942/);
  const chartDocxVal = JSON.parse(await yes('office_validate', { file: chartDocxName }));
  assert.equal(chartDocxVal.valid, true, JSON.stringify(chartDocxVal));

  // Live no-fetch proof for top-level web citation hyperlinks rendered via sandboxed --render html
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(403);
    res.end('Unexpected request');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const citeFile = 'citation-nofetch.docx';
    await yes('office_create', { file: citeFile });
    await yes('office_add', { file: citeFile, parent: '/body', type: 'paragraph', props: { text: 'Citation: ' } });
    await yes('office_add', { file: citeFile, parent: '/body/p[1]', type: 'hyperlink', props: { text: 'DOI 10.1000/test', url: `http://127.0.0.1:${port}/doi/10.1000/test` } });
    await guardPackage(path.join(directory, citeFile));
    const citePng = await run('office_preview', { file: citeFile, page: 1, render: 'html' }, { imageIn: true });
    assert.equal(citePng.success, true, JSON.stringify(citePng.error));
    assert.match(citePng.data.image, /^data:image\/png;base64,/);
    assert.deepEqual(requests, [], 'HTML preview render must not fetch external web citation hyperlinks');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

void test('Excel scientific chain: CSV/TSV import, live statistical formulas, issues audit, and atomic rollback', { skip: !process.env.OFFICECLI_TEST_BINARY }, async () => {
  const file = 'sci-exp.xlsx';
  const csv = 'raw_replicates.csv';
  const tsv = 'raw_elongation.tsv';
  const csvContent = 'Sample,R1,R2,R3\nTi64,905.2,912.1,918.9\nAl7075,501.4,508.0,510.6\n';
  const tsvContent = 'Sample\tEL1\tEL2\nTi64\t14.1\t14.5\n';
  await writeFile(path.join(directory, csv), csvContent);
  await writeFile(path.join(directory, tsv), tsvContent);

  await yes('office_create', { file });
  await yes('office_import', { file, sheet: '/Sheet1', source: csv, header: true });
  await yes('office_add', { file, parent: '/', type: 'sheet', props: { name: 'Elongation' } });
  await yes('office_import', { file, sheet: '/Elongation', source: tsv, header: true });

  // Source CSV/TSV files must remain untouched
  assert.equal(await readFile(path.join(directory, csv), 'utf8'), csvContent);
  assert.equal(await readFile(path.join(directory, tsv), 'utf8'), tsvContent);

  // Live statistical formulas including T.INV.2T 95% CI (replacing unevaluated CONFIDENCE.T)
  await yes('office_batch', {
    file,
    commands: [
      { command: 'set', path: '/Sheet1/E1', props: { value: 'Mean', bold: true } },
      { command: 'set', path: '/Sheet1/F1', props: { value: 'SD', bold: true } },
      { command: 'set', path: '/Sheet1/G1', props: { value: 'CI95', bold: true } },
      { command: 'set', path: '/Sheet1/E2', props: { formula: '=AVERAGE(B2:D2)', numFmt: '0.00' } },
      { command: 'set', path: '/Sheet1/F2', props: { formula: '=STDEV.S(B2:D2)', numFmt: '0.00' } },
      { command: 'set', path: '/Sheet1/G2', props: { formula: '=T.INV.2T(0.05,COUNT(B2:D2)-1)*F2/SQRT(COUNT(B2:D2))', numFmt: '0.00' } },
      { command: 'set', path: '/Sheet1/col[E]', props: { width: 14 } },
      { command: 'set', path: '/Sheet1/col[F]', props: { width: 14 } },
      { command: 'set', path: '/Sheet1/col[G]', props: { width: 14 } },
    ],
  });

  // Verify live computed values and 0 formula issues
  const ciCell = JSON.parse(await yes('office_get', { file, path: '/Sheet1/G2' }));
  assert.ok(JSON.stringify(ciCell).includes('17.0'));
  const issues = JSON.parse(await yes('office_view', { file, mode: 'issues' }));
  assert.equal(issues.data.count, 0, JSON.stringify(issues));

  // Windowed cols + range read, text truncation marker, AND structured JSON maxCells enforcement
  const colRead = await yes('office_view', { file, mode: 'text', range: 'Sheet1!A1:G3', cols: 'A,E,F,G' });
  assert.match(colRead, /Ti64/);
  const truncated = await yes('office_view', { file, maxSheetRows: 1, maxCells: 1 });
  assert.match(truncated, /> Truncated:/);
  const jsonCapped = JSON.parse(await yes('office_view', { file, mode: 'text', range: 'Sheet1!A1:G3', json: true, maxCells: 2 }));
  assert.equal(jsonCapped.data.truncated, true);
  assert.equal(jsonCapped.data.returnedCells, 2);
  assert.equal(jsonCapped.data.sheets[0].totalRows, 3);

  // Atomic rollback preserves exact bytes
  const beforeRollback = await readFile(path.join(directory, file));
  const rollback = await run('office_batch', {
    file,
    commands: [
      { command: 'set', path: '/Sheet1/H2', props: { value: 'Should roll back' } },
      { command: 'remove', path: '/Sheet1/Z999' },
    ],
  });
  assert.equal(rollback.success, false);
  assert.deepEqual(await readFile(path.join(directory, file)), beforeRollback);

  const val = JSON.parse(await yes('office_validate', { file }));
  assert.equal(val.valid, true);
  assert.equal(val.count, 0);
});

void test('PowerPoint scientific chain: multi-slide contact sheet (--grid), single-slide zoom, swap, and live office_help', { skip: !process.env.OFFICECLI_TEST_BINARY }, async () => {
  const file = 'research-deck.pptx';
  await yes('office_create', { file });
  await yes('office_batch', {
    file,
    commands: [
      { command: 'add', parent: '/', type: 'slide', props: { title: 'Slide 1: Hypothesis' } },
      { command: 'add', parent: '/slide[1]', type: 'shape', props: { name: 'Claim1', text: 'Grain refinement increases YS by 18%', x: '2cm', y: '5cm', width: '24cm', height: '3cm', size: '24pt' } },
      { command: 'add', parent: '/', type: 'slide', props: { title: 'Slide 2: Ablation Table' } },
      { command: 'add', parent: '/slide[2]', type: 'table', props: { rows: 2, cols: 3, x: '2cm', y: '4.5cm', width: '28cm', height: '6cm' } },
      { command: 'add', parent: '/', type: 'slide', props: { title: 'Slide 3: Limitations' } },
      { command: 'add', parent: '/', from: '/slide[3]' },
      { command: 'swap', path: '/slide[3]', path2: '/slide[4]' },
    ],
  });

  // Validate 0 OpenXML errors
  const val = JSON.parse(await yes('office_validate', { file }));
  assert.equal(val.valid, true);
  assert.equal(val.count, 0);

  // Outline fallback when imageIn=false
  const outlineFallback = await run('office_preview', { file }, { imageIn: false });
  assert.equal(outlineFallback.success, true);
  assert.match(outlineFallback.data.text, /outline/i);

  // Multi-slide contact sheet (1-4, grid=2, render=html)
  const contact = await run('office_preview', { file, pages: '1-4', grid: '2', render: 'html' }, { imageIn: true });
  assert.equal(contact.success, true, JSON.stringify(contact.error));
  assert.match(contact.data.image, /^data:image\/png;base64,/);
  assert.equal(contact.data.pages, '1-4');
  assert.equal(contact.data.grid, '2');

  // Single-slide zoom
  const zoom = await run('office_preview', { file, page: 2, render: 'html' }, { imageIn: true });
  assert.equal(zoom.success, true, JSON.stringify(zoom.error));
  assert.match(zoom.data.image, /^data:image\/png;base64,/);

  // Live fileless office_help on pinned 1.0.163 binary
  const helpJson = JSON.parse(await yes('office_help', { format: 'xlsx', verb: 'set', element: 'chart-series' }));
  assert.ok(helpJson.properties.errBars, 'Live office_help must report errBars on xlsx chart-series');

  // Real PPTX chart-data edit round-trip: edit chart series and assert embedded .xlsx workbook cells updated
  const chartPptxName = 'chart-embedded-roundtrip.pptx';
  const chartPptxAbs = path.join(directory, chartPptxName);
  await yes('office_create', { file: chartPptxName });
  await yes('office_add', { file: chartPptxName, parent: '/', type: 'slide', props: { title: 'Chart Data' } });
  await yes('office_add', { file: chartPptxName, parent: '/slide[1]', type: 'chart', props: { chartType: 'column', title: 'Alloy', categories: 'A,B', series1: 'YS:10,20', x: '2cm', y: '4cm', width: '20cm', height: '10cm' } });
  const pptxPreEntries = await readZipEntries(await readFile(chartPptxAbs));
  const pptxChartXmlPath = [...pptxPreEntries.keys()].find((k) => /charts\/chart1\.xml$/i.test(k));
  assert.ok(pptxChartXmlPath, 'PPTX must contain generated chart1.xml');
  const pptxChartDir = path.posix.dirname(pptxChartXmlPath);
  const pptxChartRelsPath = `${pptxChartDir}/_rels/chart1.xml.rels`;
  const relDepth = pptxChartDir.split('/').length - 1;
  const pptxEmbedRelTarget = `${'../'.repeat(relDepth)}embeddings/Microsoft_Excel_Worksheet1.xlsx`;
  await attachEmbeddedChartWorkbook(chartPptxAbs, {
    chartXmlPath: pptxChartXmlPath,
    chartRelsPath: pptxChartRelsPath,
    embedPath: 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx',
    embedRelTarget: pptxEmbedRelTarget,
  });
  await guardPackage(chartPptxAbs);
  await yes('office_set', { file: chartPptxName, path: '/slide[1]/chart[1]', props: { series1: 'YS:811,877' } });
  await guardPackage(chartPptxAbs);
  const pptxAfterEntries = await readZipEntries(await readFile(chartPptxAbs));
  const pptxEmbedEntries = await readZipEntries(pptxAfterEntries.get('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'));
  const pptxSheetXml = pptxEmbedEntries.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(pptxSheetXml, /811/);
  assert.match(pptxSheetXml, /877/);
  const chartPptxVal = JSON.parse(await yes('office_validate', { file: chartPptxName }));
  assert.equal(chartPptxVal.valid, true, JSON.stringify(chartPptxVal));

  await no('office_preview', { file, mode: 'raw' }, 'ARGUMENT_INVALID');
});

void test('runProcess rejects immediately on pre-aborted signal without spawning', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => runProcess('nonexistent-binary-should-not-spawn', ['--version'], { signal: ac.signal }),
    { code: 'CANCELLED' },
  );
});
