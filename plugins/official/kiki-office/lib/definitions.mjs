const string = { type: 'string' };
const boolean = { type: 'boolean' };
const nonNegativeInt = { type: 'integer', minimum: 0 };
const positiveInt = { type: 'integer', minimum: 1 };

const propsMap = {
  type: 'object',
  minProperties: 1,
  maxProperties: 64,
  additionalProperties: { type: ['string', 'number', 'boolean'] },
};

const propsList = {
  type: 'array',
  minItems: 1,
  maxItems: 64,
  items: { type: 'string' },
};

const props = {
  anyOf: [propsMap, propsList],
};

const fileField = {
  type: 'string',
  description: 'Workspace-relative path or explicitly approved absolute path (.docx/.xlsx/.pptx).',
};

const fileSchema = (properties, required = []) => ({
  type: 'object',
  properties: { file: fileField, ...properties },
  required: ['file', ...required],
  additionalProperties: false,
});

const rawSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const fileAccess = (operation) => [{ kind: 'file', operation, path: '$.file' }, { kind: 'all' }];

const tool = (name, description, parameters, accesses) => ({
  schemaVersion: 1,
  name,
  description,
  parameters,
  accesses,
  disclosure: 'deferred',
});

const batchCommandItems = {
  anyOf: [
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['add'] },
        parent: string,
        type: string,
        from: string,
        before: string,
        after: string,
        index: nonNegativeInt,
        props,
      },
      required: ['command', 'parent'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['set'] },
        path: string,
        props,
        find: string,
        replace: string,
      },
      required: ['command', 'path'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['remove'] },
        path: string,
      },
      required: ['command', 'path'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['move'] },
        path: string,
        to: string,
        before: string,
        after: string,
        index: nonNegativeInt,
        props,
      },
      required: ['command', 'path'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['swap'] },
        path: string,
        path2: string,
      },
      required: ['command', 'path', 'path2'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['get'] },
        path: string,
        depth: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['command', 'path'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['query'] },
        selector: string,
        compact: boolean,
        fields: string,
      },
      required: ['command', 'selector'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['validate'] },
      },
      required: ['command'],
      additionalProperties: false,
    },
  ],
};

export const definitions = [
  tool(
    'office_create',
    'Create a new blank docx, xlsx or pptx. Use before adding content; never overwrites an existing file. The pinned OfficeCLI binary must already be installed.',
    fileSchema({}, []),
    fileAccess('write'),
  ),
  tool(
    'office_get',
    'Read a node at an exact semantic path as bounded structured JSON. Use after a text overview to locate paragraphs, cells or shapes; depth is capped at 3.',
    fileSchema({ path: string, depth: { type: 'integer', minimum: 0, maximum: 3 } }, ['path']),
    fileAccess('read'),
  ),
  tool(
    'office_query',
    'Find nodes matching an OfficeCLI selector. Returns bounded JSON by default, or compact one-line listings when compact=true (with optional fields for docx/pptx).',
    fileSchema({ selector: string, find: string, compact: boolean, fields: string }, ['selector']),
    fileAccess('read'),
  ),
  tool(
    'office_set',
    'Modify properties or replace matched text at a semantic path. Use on an existing document; specify props (flat map or ["key=value"] list) or find and replace.',
    fileSchema({ path: string, props, find: string, replace: string }, ['path']),
    fileAccess('readwrite'),
  ),
  tool(
    'office_add',
    'Add or clone an element under a parent semantic path in an existing document. Supply type or internal DOM from path, optional before/after/index placement, and props.',
    fileSchema({ parent: string, type: string, from: string, before: string, after: string, index: nonNegativeInt, props }, ['parent']),
    fileAccess('readwrite'),
  ),
  tool(
    'office_remove',
    'Remove an element at an exact semantic path. Destructive document edit: inspect with office_get before calling.',
    fileSchema({ path: string }, ['path']),
    fileAccess('readwrite'),
  ),
  tool(
    'office_view',
    'Get a bounded text, annotated, outline, stats or issues overview. Supports range, cols (xlsx), issueType filter and structured JSON output up to 500 rows/2000 cells.',
    fileSchema({
      mode: { type: 'string', enum: ['text', 'annotated', 'outline', 'stats', 'issues'] },
      range: string,
      cols: string,
      start: positiveInt,
      end: positiveInt,
      maxSheetRows: { type: 'integer', minimum: 1, maximum: 500 },
      maxCells: { type: 'integer', minimum: 1, maximum: 2000 },
      issueType: string,
      json: boolean,
    }),
    fileAccess('read'),
  ),
  tool(
    'office_batch',
    'Apply 1–128 add, set, remove, move, swap, get, query or validate commands atomically to an existing document. Any failed item rolls back the batch.',
    fileSchema({
      commands: {
        type: 'array',
        minItems: 1,
        maxItems: 128,
        items: batchCommandItems,
      },
    }, ['commands']),
    fileAccess('readwrite'),
  ),
  tool(
    'office_preview',
    'Render a single page or a 1–12 page thumbnail contact sheet (--grid) via sandboxed HTML rendering as PNG when image input is supported; otherwise return an outline.',
    fileSchema({
      page: positiveInt,
      pages: { type: 'string', description: 'Contiguous range "1-12" (.docx/.pptx) or comma list "1,3,5" (.docx only); max 12 pages.' },
      grid: { type: 'string', description: 'Contact-sheet columns for .docx/.pptx: "auto" or "1"-"6". Defaults to "auto" when pages selects multiple pages.' },
      range: { type: 'string', description: 'Excel cell range ("Sheet1!A1:H20") or PPTX/DOCX element path ("/slide[2]/table[1]") crop.' },
      render: { type: 'string', enum: ['html'] },
    }),
    fileAccess('read'),
  ),
  tool(
    'office_validate',
    'Validate an existing .docx, .xlsx or .pptx against the OpenXML schema and return bounded structured findings, including invalid-document errors.',
    fileSchema({}, []),
    fileAccess('read'),
  ),
  tool(
    'office_help',
    'Query pinned OfficeCLI schema reference for docx, xlsx or pptx elements and property names without opening a document file.',
    rawSchema({
      format: { type: 'string', enum: ['docx', 'xlsx', 'pptx'] },
      verb: { type: 'string', enum: ['add', 'set', 'get', 'query', 'remove'] },
      element: { type: 'string', description: 'Optional element token (e.g. paragraph, table-cell, equation, chart, chart-series, slide, shape).' },
    }, ['format']),
    [{ kind: 'all' }],
  ),
  tool(
    'office_import',
    'Import an existing local .csv or .tsv data file into a sheet of an existing .xlsx workbook without modifying the source file.',
    rawSchema({
      file: { type: 'string', description: 'Target existing .xlsx workbook path (workspace-relative or approved absolute).' },
      sheet: { type: 'string', description: 'Target sheet DOM path (e.g. "/Sheet1" or "/Raw_Data").' },
      source: { type: 'string', description: 'Source existing .csv or .tsv file path (workspace-relative or approved absolute).' },
      header: { type: 'boolean', description: 'Treat first row as header (adds AutoFilter and freeze pane).' },
      startCell: { type: 'string', description: 'Top-left target cell (default "A1").' },
      delimiter: { type: 'string', description: 'Optional single-character delimiter override (e.g. ";", "|", "\\t").' },
      decimal: { type: 'string', enum: ['.', ','], description: 'Decimal mark used in the source file.' },
    }, ['file', 'sheet', 'source']),
    [
      { kind: 'file', operation: 'readwrite', path: '$.file' },
      { kind: 'file', operation: 'read', path: '$.source' },
      { kind: 'all' },
    ],
  ),
];
