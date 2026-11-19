import { readFileSync } from 'node:fs';
import { createProviderRegister } from '../../media-runtime/entry.mjs';
import { adapters, createAdapters } from './adapters.mjs';

const manifest = JSON.parse(readFileSync(new URL('../kimi.plugin.json', import.meta.url), 'utf8'));

export { adapters, createAdapters };
export const register = createProviderRegister(manifest, adapters);
