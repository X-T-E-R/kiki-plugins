import { definition } from './lib/definitions.mjs';
import { search } from './lib/search.mjs';

export function register(api) {
  api.registerTool(definition, search);
}
