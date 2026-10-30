import { definition } from './lib/definitions.mjs';
import { search } from './lib/search.mjs';

export function register(api) {
  api.registerTool(definition, search);
}

// Keep the query/drain owner alive beyond the ordinary 90-second tool-host idle timeout.
export function activate() {}
