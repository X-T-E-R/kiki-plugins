import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { mediaGenerateInputSchema, mediaActionSchema } from '@kiki/plugin-sdk/media';

const normalize = (text) => text.replaceAll('\r\n', '\n');

function with3dGenerateSchema(schema) {
  const variants = schema.properties?.request?.oneOf;
  if (!Array.isArray(variants)) return schema;
  const imageVariant = variants.find((item) => item?.properties?.kind?.const === 'image');
  const variant3d = {
    type: 'object',
    properties: {
      kind: { type: 'string', const: '3d' },
      prompt: { type: 'string', minLength: 1 },
      images: {
        type: 'array',
        items: structuredClone(imageVariant.properties.images.items),
        minItems: 1,
      },
      format: { type: 'string', minLength: 1 },
      options: structuredClone(imageVariant.properties.options),
    },
    required: ['kind'],
    anyOf: [{ required: ['prompt'] }, { required: ['images'] }],
    additionalProperties: false,
  };
  const existingIndex = variants.findIndex((item) => item?.properties?.kind?.const === '3d');
  if (existingIndex >= 0) variants[existingIndex] = variant3d;
  else variants.push(variant3d);
  return schema;
}

function with3dActionSchema(schema) {
  const capabilities = schema.oneOf?.find((item) => item?.properties?.action?.const === 'capabilities');
  const kindEnum = capabilities?.properties?.kind?.enum;
  if (Array.isArray(kindEnum) && !kindEnum.includes('3d')) kindEnum.push('3d');
  return schema;
}

const file = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
manifest['x-kiki'].tools = [
  { schemaVersion: 1, name: 'generate', description: 'Generate an image/edit, video, speech, or 3D model file through one installed provider. Return original file_id artifacts, or a background Task that notifies on completion. Reuse request_id for the same request; unknown submission must not be automatically resubmitted. Discover models/voices with media rather than guessing. Resume only polls/downloads, never buys a new generation.', parameters: with3dGenerateSchema(z.toJSONSchema(mediaGenerateInputSchema, { io: 'input' })), accesses: [{ kind: 'all' }], concurrencySafe: true, display: { type: 'media_generation' }, disclosure: 'inline', mediaInputs: true },
  { schemaVersion: 1, name: 'media', description: 'Discover installed media provider capabilities/models or voices on demand; inspect, stop or resume one media job. Cancel reports local reception separately from confirmed remote cancellation and does not promise a refund. Resume never submits a new generation.', parameters: with3dActionSchema(z.toJSONSchema(mediaActionSchema)), accesses: [{ kind: 'all' }], concurrencySafe: true, display: { type: 'media_generation' }, disclosure: 'deferred' },
];
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (normalize(await readFile(file, 'utf8')) !== expected) throw new Error('Media tool manifest is stale; run sync-manifest.mjs');
} else await writeFile(file, expected);
