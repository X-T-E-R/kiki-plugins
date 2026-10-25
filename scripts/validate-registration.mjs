import assert from 'node:assert/strict';
import { validRange } from 'semver';
import { sessionSourceDefinitionSchema } from '@kiki/plugin-sdk/session-import';
import { mediaProviderDefinitionSchema } from '@kiki/plugin-sdk/media';
import { pluginImAdapterDefinitionSchema } from '@kiki/plugin-sdk/im';

const contributions = [
  { field: 'tools', method: 'registerTool', key: 'name' },
  { field: 'sessionSources', method: 'registerSessionSource', key: 'id', schema: sessionSourceDefinitionSchema },
  { field: 'mediaProviders', method: 'registerMediaProvider', key: 'id', schema: mediaProviderDefinitionSchema },
  { field: 'imAdapters', method: 'registerImAdapter', key: 'id', schema: pluginImAdapterDefinitionSchema },
];

function checkAdapter(field, definition, adapter) {
  if (field === 'tools') {
    assert.equal(typeof adapter, 'function', `Tool ${definition.name} needs an execute function`);
    return;
  }
  const methods = field === 'sessionSources' ? ['discover', 'probe', 'parse']
    : field === 'mediaProviders' ? ['describe', 'submit'] : ['start', 'stop'];
  if (field === 'imAdapters') {
    if (definition.outbound) methods.push('sendText');
    if (definition.supportsEdit) methods.push('editText');
    if (definition.mediaCapabilities.length) methods.push('sendMedia');
  }
  for (const method of methods) {
    assert.equal(typeof adapter?.[method], 'function', `${field} ${definition.id} needs ${method}()`);
  }
}

export async function validateRegistration(manifest, register) {
  const extension = manifest['x-kiki'] ?? {};
  if (extension.dependencies !== undefined) {
    assert.ok(extension.dependencies && typeof extension.dependencies === 'object' && !Array.isArray(extension.dependencies), 'x-kiki.dependencies must map plugin ids to semver ranges');
    for (const [id, range] of Object.entries(extension.dependencies)) {
      assert.match(id, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid dependency plugin id');
      assert.ok(typeof range === 'string' && validRange(range) !== null, `Invalid dependency range for ${id}`);
    }
  }
  const states = contributions.map(spec => {
    const declared = extension[spec.field] === undefined ? [] : extension[spec.field];
    assert.ok(Array.isArray(declared), `x-kiki.${spec.field} must be an array`);
    if (extension[spec.field] !== undefined) assert.ok(extension.entry, `${spec.field} requires x-kiki.entry`);
    const definitions = new Map();
    for (const definition of declared) {
      spec.schema?.parse(definition);
      const id = definition[spec.key];
      assert.equal(typeof id, 'string', `${spec.field} needs ${spec.key}`);
      assert.ok(!definitions.has(id), `Duplicate declared ${spec.field}: ${id}`);
      definitions.set(id, definition);
    }
    return { ...spec, definitions, registered: new Set() };
  });
  if (extension.entry === undefined) return;
  assert.equal(typeof register, 'function', `${manifest.name} entry needs register()`);
  const api = Object.fromEntries(states.map(state => [state.method, (definition, adapter) => {
    state.schema?.parse(definition);
    const id = definition[state.key];
    assert.ok(state.definitions.has(id), `Undeclared ${state.field}: ${id}`);
    assert.ok(!state.registered.has(id), `Duplicate registered ${state.field}: ${id}`);
    assert.deepEqual(definition, state.definitions.get(id), `Registered ${state.field} changed: ${id}`);
    checkAdapter(state.field, definition, adapter);
    state.registered.add(id);
  }]));
  await register(api);
  for (const state of states) {
    for (const id of state.definitions.keys()) {
      assert.ok(state.registered.has(id), `Missing registered ${state.field}: ${id}`);
    }
  }
}
