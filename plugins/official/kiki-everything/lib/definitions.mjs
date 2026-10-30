import { sorts } from './search.mjs';

export const definition = {
  schemaVersion: 1,
  name: 'search',
  description: 'Search the local Windows Everything 1.5 index by file/directory name, path, extension, size or modification time. Pass root=C:/ (or another admitted drive/directory) for disk-wide search. Query terms are ANDed; quote phrases. Supports ext:pdf, size:>1gb and dm:today. Returns metadata only after Kiki path admission and sensitive/VCS filtering. Keep Glob for repository glob patterns and Grep for file contents. Index pages precede filtering; total is unknown. No HTTP or Python needed.',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory/drive root to search, workspace-relative or absolute. Kiki approves external paths. Search each drive separately (e.g. C:/, D:/).' },
      query: { type: 'string', maxLength: 4096, default: '', description: 'Everything indexed search syntax; spaces mean AND. Examples: report ext:pdf; "annual report"; size:>1gb; dm:today. No content/property-reading functions.' },
      type: { type: 'string', enum: ['both', 'file', 'directory'], default: 'both' },
      sort: { type: 'string', enum: sorts, default: 'date-modified-descending' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 2147480000, default: 0, description: 'Raw index offset BEFORE path/sensitive filtering. Continue with pagination.next_offset, even if a filtered page is empty.' },
      match_case: { type: 'boolean', default: false },
      match_path: { type: 'boolean', default: false },
      match_whole_word: { type: 'boolean', default: false },
    },
    required: ['root'], additionalProperties: false,
  },
  accesses: [{ kind: 'file', operation: 'search', path: '$.root', recursive: true }],
  disclosure: 'deferred',
};
