import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { mediaOutcomeSchema } from '@kiki/plugin-sdk/media';
import { register } from '../plugins/official/kiki-media/dist/index.mjs';

async function loadPlugin() {
  const tools = new Map();
  const providers = new Map();
  await register({
    registerMediaProvider(definition, adapter) {
      providers.set(definition.id, { definition, adapter });
    },
    registerTool(definition, execute) {
      tools.set(definition.name, { definition, execute });
    },
  });
  return { tools, providers };
}

test('routes kind 3d generate requests through default3dProvider and respects explicit overrides', async () => {
  const { tools } = await loadPlugin();
  const generate = tools.get('generate');
  const media = tools.get('media');
  assert.ok(generate && media);

  const calls = [];
  const fakeContext = (settings = {}) => ({
    settings,
    media: {
      async generate(input) {
        calls.push(input);
        return {
          schemaVersion: 1,
          job_id: 'job-3d-1',
          request_id: input.request_id ?? 'req-3d-1',
          provider: input.provider ?? 'kiki-media/script-tripo',
          state: 'succeeded',
          phase: 'download',
          can_resume: false,
          artifacts: [],
          effective: { kind: '3d' },
        };
      },
      async media(input) {
        return { action: input.action, kind: input.kind, providers: [] };
      },
    },
  });

  // Uses default3dProvider when input.provider is omitted
  const defaultRes = await generate.execute(
    { request: { kind: '3d', prompt: 'ceramic teapot', format: 'glb' } },
    fakeContext({
      defaultImageProvider: 'openai-image',
      default3dProvider: 'kiki-media/script-tripo',
    }),
  );
  assert.equal(defaultRes.isError, false);
  assert.equal(calls.at(-1).provider, 'kiki-media/script-tripo');
  assert.equal(calls.at(-1).request.kind, '3d');

  // Explicit provider overrides default3dProvider (including image-to-3d without prompt)
  const overrideRes = await generate.execute(
    { provider: 'tripo-plugin/tripo-3d', request: { kind: '3d', images: [{ path: '/tmp/ref.png' }] } },
    fakeContext({ default3dProvider: 'kiki-media/script-tripo' }),
  );
  assert.equal(overrideRes.isError, false);
  assert.equal(calls.at(-1).provider, 'tripo-plugin/tripo-3d');

  // Empty/unset default3dProvider passes provider: undefined (never falls back to image/video/tts defaults)
  await generate.execute(
    { request: { kind: '3d', prompt: 'low-poly lantern' } },
    fakeContext({
      defaultImageProvider: 'openai-image',
      defaultVideoProvider: 'google-video',
      defaultTtsProvider: 'minimax-speech',
      default3dProvider: '',
    }),
  );
  assert.equal(calls.at(-1).provider, undefined);

  // media capabilities query passes kind: '3d' cleanly
  const capRes = await media.execute({ action: 'capabilities', kind: '3d' }, fakeContext());
  assert.deepEqual(JSON.parse(capRes.output), { action: 'capabilities', kind: '3d', providers: [] });
});

test('custom-script adapter advertises and executes kind 3d for file-output and json-bridge protocols', async () => {
  const { providers } = await loadPlugin();
  const customScript = providers.get('custom-script');
  assert.ok(customScript);
  assert.ok(customScript.definition.kinds.includes('3d'));

  const described = await customScript.adapter.describe({}, {
    settings: { scriptSource: { id: 'tripo-local', kinds: ['3d'] } },
    signal: new AbortController().signal,
  });
  assert.deepEqual(described.models, [{ id: 'tripo-local', kind: '3d' }]);

  await mkdir('.tmp', { recursive: true });
  const workDir = await mkdtemp(path.resolve('.tmp/media-3d-script-'));
  try {
    const fileScript = path.join(workDir, 'emit-3d-file.mjs');
    await writeFile(
      fileScript,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], Buffer.from('glTF-payload:' + process.argv[3]));\n`,
    );

    const jsonScript = path.join(workDir, 'emit-3d-json.mjs');
    await writeFile(
      jsonScript,
      `import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const req = JSON.parse(readFileSync(process.env.KIKI_MEDIA_INPUT, 'utf8'));
const glbPath = path.join(path.dirname(req.output), 'asset.glb');
const previewPath = path.join(path.dirname(req.output), 'asset.preview.png');
writeFileSync(glbPath, Buffer.from('glTF-json-bridge'));
writeFileSync(previewPath, Buffer.from('png-preview'));
writeFileSync(req.resultFile, JSON.stringify({
  state: 'complete',
  artifacts: [
    { path: glbPath, name: 'asset.glb', mime: 'model/gltf-binary', kind: 'file', role: 'original', complete: true },
    { path: previewPath, name: 'asset.preview.png', mime: 'image/png', kind: 'image', role: 'preview', complete: true },
  ],
}));
`,
    );

    // 1. File-output default GLB (artifact kind must be 'file' and mime 'model/gltf-binary')
    const stagingDefault = path.join(workDir, 'stage-default');
    await mkdir(stagingDefault, { recursive: true });
    const defaultOut = mediaOutcomeSchema.parse(await customScript.adapter.submit(
      { request: { kind: '3d', prompt: 'brass compass' } },
      {
        jobId: 'job-default-glb',
        stagingDir: stagingDefault,
        signal: new AbortController().signal,
        progress() {},
        settings: {
          scriptSource: {
            id: 'tripo-local',
            kinds: ['3d'],
            protocol: 'file',
            command: process.execPath,
            args: [fileScript, '{output}', '{prompt}'],
          },
        },
      },
    ));
    assert.equal(defaultOut.state, 'complete');
    assert.equal(defaultOut.artifacts.length, 1);
    assert.equal(defaultOut.artifacts[0].name, 'output.glb');
    assert.equal(defaultOut.artifacts[0].mime, 'model/gltf-binary');
    assert.equal(defaultOut.artifacts[0].kind, 'file');
    assert.equal(await readFile(defaultOut.artifacts[0].path, 'utf8'), 'glTF-payload:brass compass');

    // 2. File-output honors safe request.format ('obj') and rejects unsafe traversal format
    const stagingObj = path.join(workDir, 'stage-obj');
    await mkdir(stagingObj, { recursive: true });
    const objOut = mediaOutcomeSchema.parse(await customScript.adapter.submit(
      { request: { kind: '3d', prompt: 'stone arch', format: 'obj' } },
      {
        jobId: 'job-obj',
        stagingDir: stagingObj,
        signal: new AbortController().signal,
        progress() {},
        settings: {
          scriptSource: {
            id: 'tripo-local',
            kinds: ['3d'],
            protocol: 'file',
            command: process.execPath,
            args: [fileScript, '{output}', '{prompt}'],
          },
        },
      },
    ));
    assert.equal(objOut.artifacts[0].name, 'output.obj');
    assert.equal(objOut.artifacts[0].mime, 'model/obj');
    assert.equal(objOut.artifacts[0].kind, 'file');

    const stagingTraversal = path.join(workDir, 'stage-traversal');
    await mkdir(stagingTraversal, { recursive: true });
    const safeOut = mediaOutcomeSchema.parse(await customScript.adapter.submit(
      { request: { kind: '3d', prompt: 'safe fallback', format: '../escape' } },
      {
        jobId: 'job-safe',
        stagingDir: stagingTraversal,
        signal: new AbortController().signal,
        progress() {},
        settings: {
          scriptSource: {
            id: 'tripo-local',
            kinds: ['3d'],
            protocol: 'file',
            command: process.execPath,
            args: [fileScript, '{output}', '{prompt}'],
          },
        },
      },
    ));
    assert.equal(safeOut.artifacts[0].name, 'output.glb');
    assert.equal(path.dirname(safeOut.artifacts[0].path), stagingTraversal);

    // 3. JSON-bridge returning GLB original + PNG preview
    const stagingJson = path.join(workDir, 'stage-json');
    await mkdir(stagingJson, { recursive: true });
    const jsonOut = mediaOutcomeSchema.parse(await customScript.adapter.submit(
      { request: { kind: '3d', images: [{ path: path.join(workDir, 'ref.png') }] } },
      {
        jobId: 'job-json',
        stagingDir: stagingJson,
        signal: new AbortController().signal,
        progress() {},
        settings: {
          scriptSource: {
            id: 'tripo-json',
            kinds: ['3d'],
            protocol: 'json',
            command: process.execPath,
            args: [jsonScript],
          },
        },
      },
    ));
    assert.equal(jsonOut.state, 'complete');
    assert.equal(jsonOut.artifacts.length, 2);
    assert.equal(jsonOut.artifacts[0].kind, 'file');
    assert.equal(jsonOut.artifacts[0].mime, 'model/gltf-binary');
    assert.equal(jsonOut.artifacts[1].role, 'preview');
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
