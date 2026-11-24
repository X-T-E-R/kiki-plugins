import { admitFile, IMPORT_SOURCE_EXTENSIONS, OfficeError, XLSX_EXTENSIONS } from './paths.mjs';
import { findBinary, runProcess } from './binary.mjs';
import { guardPackage, MAX_ARCHIVE_BYTES } from './package-guard.mjs';
import { renderPreview } from './preview.mjs';
import { publishSnapshotAtomic, snapshotFromFile } from './snapshot.mjs';

const MAX_RESULT = 65_536;
const MAX_ROWS = 500;
const DEFAULT_ROWS = 200;
const MAX_CELLS = 2000;
const DEFAULT_CELLS = 500;
const MAX_COMMANDS = 128;
const MAX_PROPS = 64;
const MAX_PROP_VALUE = 32_768;
const MAX_PROPS_TOTAL_BYTES = 256 * 1024;
const MAX_BATCH_INPUT_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const RUN_MAX_BYTES = 512 * 1024;

const HELP_FORMATS = new Set(['docx', 'xlsx', 'pptx']);
const HELP_VERBS = new Set(['add', 'set', 'get', 'query', 'remove']);
const BLOCKED_ELEMENT_TYPES = new Set(['ole', 'model3d']);
const FILE_LOADING_PROP_KEYS = new Set(['src', 'fallback', 'image', 'imagefill', 'background.image', 'fill.image', 'file', 'data']);
const INLINE_IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i;
const MUTATING_TOOLS = new Set(['office_set', 'office_add', 'office_remove', 'office_batch', 'office_import']);

function object(input, message = 'Expected an object of tool arguments.') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OfficeError('ARGUMENT_INVALID', message, 'Pass named parameters matching the tool schema.');
  }
  return input;
}

function assertAllowedKeys(obj, allowed, context) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new OfficeError('ARGUMENT_INVALID', `Unsupported field "${key}" in ${context}.`, 'Use only the declared schema fields.');
    }
  }
}

function text(value, field, max = 4096) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) {
    throw new OfficeError('ARGUMENT_INVALID', `Invalid ${field}.`, `Provide a nonempty ${field} of at most ${max} characters.`);
  }
  return value;
}

function nullableEmptyText(value, field, max = MAX_PROP_VALUE) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new OfficeError('ARGUMENT_INVALID', `Invalid ${field}.`, `Provide a string ${field} of at most ${max} characters.`);
  }
  return value;
}

function domPath(value, field, max = 512) {
  const s = text(value, field, max);
  if (!s.startsWith('/') || s.includes('\\') || s.includes('://') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) {
    throw new OfficeError('ARGUMENT_INVALID', `Invalid internal DOM path for ${field}: ${s}`, 'Use an internal document semantic path starting with "/" (for example "/body/p[1]", "/Sheet1", or "/slide[1]").');
  }
  return s;
}

function nonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new OfficeError('ARGUMENT_INVALID', `Invalid ${field}.`, `Provide a non-negative integer for ${field}.`);
  }
  return value;
}

function positiveInt(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new OfficeError('ARGUMENT_INVALID', `Invalid ${field}.`, `Provide an integer between 1 and ${max} for ${field}.`);
  }
  return value;
}

function guardPropValue(key, str, { elementType, targetPath } = {}) {
  const lowerKey = key.toLowerCase();
  const isPivot = elementType?.toLowerCase() === 'pivottable' || /pivottable/i.test(targetPath ?? '');
  const isAnimation = elementType?.toLowerCase() === 'animation' || /animation/i.test(targetPath ?? '');

  if (lowerKey === 'data') {
    throw new OfficeError(
      'ARGUMENT_INVALID',
      'Property "data" is blocked because OfficeCLI resolves it against the local filesystem before parsing inline text.',
      'Populate tables using rows/cols and tr[r] cell props (c1, c2, ...), or use office_import for local CSV/TSV files.',
    );
  }

  if (FILE_LOADING_PROP_KEYS.has(lowerKey)) {
    if (lowerKey === 'src' && isPivot && /^[A-Za-z0-9_'!$:\s-]+$/.test(str) && !str.includes('/') && !str.includes('\\')) {
      return;
    }
    if ((lowerKey === 'src' || lowerKey === 'image' || lowerKey === 'imagefill') && INLINE_IMAGE_DATA_URI.test(str)) {
      return;
    }
    throw new OfficeError(
      'ARGUMENT_INVALID',
      `Undeclared external file or URL input is not allowed in property "${key}".`,
      'Only inline data:image/* base64 URIs (or Sheet!A1:B2 ranges on pivottable src) are permitted without a separate host-admitted path.',
    );
  }

  if (lowerKey === 'path') {
    if (isAnimation && /^[a-zA-Z0-9_-]{1,32}$/.test(str)) return;
    throw new OfficeError(
      'ARGUMENT_INVALID',
      `Undeclared file path is not allowed in property "${key}".`,
      'Pass document or CSV paths only through declared tool path parameters.',
    );
  }

  if (lowerKey === 'poster') {
    if (str === 'true' || str === 'false') return;
    throw new OfficeError(
      'ARGUMENT_INVALID',
      'External thumbnail path is not allowed in property "poster".',
      'Only boolean values are permitted for diagram poster mode.',
    );
  }
}

export function normalizeProps(rawProps, context = {}) {
  const pairs = [];
  if (Array.isArray(rawProps)) {
    if (rawProps.length === 0 || rawProps.length > MAX_PROPS) {
      throw new OfficeError('ARGUMENT_INVALID', `Property count must be between 1 and ${MAX_PROPS}.`, 'Provide only the properties you need to change.');
    }
    for (const item of rawProps) {
      if (typeof item !== 'string') {
        throw new OfficeError('ARGUMENT_INVALID', 'Array props must contain "key=value" strings.', 'Use ["key=value", ...] or a flat primitive object.');
      }
      const eq = item.indexOf('=');
      if (eq <= 0) {
        throw new OfficeError('ARGUMENT_INVALID', `Malformed property string: "${item.slice(0, 64)}"`, 'Format each array property entry as "key=value".');
      }
      pairs.push([item.slice(0, eq), item.slice(eq + 1)]);
    }
  } else {
    const map = object(rawProps, 'Properties must be a flat object or ["key=value"] array.');
    const entries = Object.entries(map);
    if (entries.length === 0 || entries.length > MAX_PROPS) {
      throw new OfficeError('ARGUMENT_INVALID', `Property count must be between 1 and ${MAX_PROPS}.`, 'Provide only the properties you need to change.');
    }
    for (const [key, value] of entries) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new OfficeError('ARGUMENT_INVALID', `Non-finite numeric property: ${key}`, 'Use finite numeric values.');
        }
      } else if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new OfficeError('ARGUMENT_INVALID', `Invalid property value for "${key}".`, 'Use flat string, finite number, or boolean values; nested objects/arrays are not supported.');
      }
      pairs.push([key, String(value)]);
    }
  }

  const seenLower = new Set();
  const map = {};
  let totalBytes = 0;

  for (const [key, str] of pairs) {
    if (!/^[\w.-]{1,64}$/.test(key)) {
      throw new OfficeError('ARGUMENT_INVALID', `Invalid property key: ${key}`, 'Use valid OfficeCLI property names (letters, digits, underscore, dot, hyphen).');
    }
    const lowerKey = key.toLowerCase();
    if (seenLower.has(lowerKey)) {
      throw new OfficeError('ARGUMENT_INVALID', `Duplicate property key (case-insensitive): ${key}`, 'Specify each property key at most once.');
    }
    seenLower.add(lowerKey);
    if (str.includes('\0') || str.length > MAX_PROP_VALUE) {
      throw new OfficeError('ARGUMENT_INVALID', `Property "${key}" value exceeds ${MAX_PROP_VALUE} characters or contains NUL.`, 'Shorten the value or split content across paragraphs/cells.');
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(str, 'utf8');
    if (totalBytes > MAX_PROPS_TOTAL_BYTES) {
      throw new OfficeError('ARGUMENT_INVALID', `Total properties size exceeds ${MAX_PROPS_TOTAL_BYTES} bytes.`, 'Split large content across multiple commands.');
    }
    guardPropValue(key, str, context);
    map[key] = str;
  }

  return { map, pairs };
}

function propsToFlags(rawProps, context) {
  const { pairs } = normalizeProps(rawProps, context);
  return pairs.flatMap(([key, val]) => ['--prop', `${key}=${val}`]);
}

function validatePlacement(item, label) {
  const count = [item.before !== undefined, item.after !== undefined, item.index !== undefined].filter(Boolean).length;
  if (count > 1) {
    throw new OfficeError('ARGUMENT_INVALID', `${label} accepts at most one of before, after, or index.`, 'Choose one positioning parameter.');
  }
  if (item.before !== undefined) text(item.before, 'before', 512);
  if (item.after !== undefined) text(item.after, 'after', 512);
  if (item.index !== undefined) nonNegativeInt(item.index, 'index');
}

function sanitizeBatchCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) {
    throw new OfficeError('ARGUMENT_INVALID', `Batch must have 1–${MAX_COMMANDS} commands.`, 'Split the batch into atomic groups of at most 128 commands.');
  }
  const sanitized = [];
  for (let idx = 0; idx < commands.length; idx++) {
    const raw = object(commands[idx], `Batch item ${idx} must be an object.`);
    const verb = raw.command;
    if (typeof verb !== 'string') {
      throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} is missing a string "command".`, 'Use one of: add, set, remove, move, swap, get, query, validate.');
    }
    switch (verb) {
      case 'add': {
        assertAllowedKeys(raw, new Set(['command', 'parent', 'type', 'from', 'before', 'after', 'index', 'props']), `batch[${idx}] add`);
        const parent = text(raw.parent, 'parent', 512);
        const hasType = raw.type !== undefined;
        const hasFrom = raw.from !== undefined;
        if (!hasType && !hasFrom) {
          throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} add requires type or from.`, 'Pass an element type or internal DOM from path.');
        }
        if (hasType && hasFrom) {
          throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} add cannot combine both type and from.`, 'Pass either type (new element) or from (clone existing element).');
        }
        let type;
        if (hasType) {
          type = text(raw.type, 'type', 64);
          if (BLOCKED_ELEMENT_TYPES.has(type.toLowerCase())) {
            throw new OfficeError('ARGUMENT_INVALID', `Element type "${type}" is not permitted.`, 'Use standard OOXML document elements.');
          }
        }
        const from = hasFrom ? domPath(raw.from, 'from', 512) : undefined;
        validatePlacement(raw, `batch[${idx}] add`);
        const out = { command: 'add', parent };
        if (type !== undefined) out.type = type;
        if (from !== undefined) out.from = from;
        if (raw.before !== undefined) out.before = raw.before;
        if (raw.after !== undefined) out.after = raw.after;
        if (raw.index !== undefined) out.index = raw.index;
        if (raw.props !== undefined) out.props = normalizeProps(raw.props, { elementType: type, targetPath: parent }).map;
        sanitized.push(out);
        break;
      }
      case 'set': {
        assertAllowedKeys(raw, new Set(['command', 'path', 'props', 'find', 'replace']), `batch[${idx}] set`);
        const targetPath = text(raw.path, 'path', 512);
        const hasFind = raw.find !== undefined;
        const hasReplace = raw.replace !== undefined;
        if (hasFind !== hasReplace) {
          throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} set requires both find and replace together.`, 'Supply both find and replace strings.');
        }
        const merged = raw.props !== undefined ? { ...normalizeProps(raw.props, { targetPath }).map } : {};
        if (hasFind) {
          const findVal = text(raw.find, 'find', MAX_PROP_VALUE);
          const replaceVal = nullableEmptyText(raw.replace, 'replace', MAX_PROP_VALUE);
          const lowerKeys = new Set(Object.keys(merged).map((k) => k.toLowerCase()));
          if (lowerKeys.has('find') || lowerKeys.has('replace')) {
            throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} set specifies find/replace both as siblings and inside props.`, 'Pass find and replace in only one place.');
          }
          merged.find = findVal;
          merged.replace = replaceVal;
          normalizeProps(merged, { targetPath });
        }
        if (Object.keys(merged).length === 0) {
          throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} set requires props or find+replace.`, 'Supply properties or find/replace strings.');
        }
        sanitized.push({ command: 'set', path: targetPath, props: merged });
        break;
      }
      case 'remove': {
        assertAllowedKeys(raw, new Set(['command', 'path']), `batch[${idx}] remove`);
        sanitized.push({ command: 'remove', path: text(raw.path, 'path', 512) });
        break;
      }
      case 'move': {
        assertAllowedKeys(raw, new Set(['command', 'path', 'to', 'before', 'after', 'index', 'props']), `batch[${idx}] move`);
        const targetPath = text(raw.path, 'path', 512);
        if (raw.to === undefined && raw.before === undefined && raw.after === undefined && raw.index === undefined) {
          throw new OfficeError('ARGUMENT_INVALID', `Batch item ${idx} move requires to, before, after, or index.`, 'Specify a destination parent or sibling position.');
        }
        validatePlacement(raw, `batch[${idx}] move`);
        const out = { command: 'move', path: targetPath };
        if (raw.to !== undefined) out.to = text(raw.to, 'to', 512);
        if (raw.before !== undefined) out.before = raw.before;
        if (raw.after !== undefined) out.after = raw.after;
        if (raw.index !== undefined) out.index = raw.index;
        if (raw.props !== undefined) out.props = normalizeProps(raw.props, { targetPath }).map;
        sanitized.push(out);
        break;
      }
      case 'swap': {
        assertAllowedKeys(raw, new Set(['command', 'path', 'path2']), `batch[${idx}] swap`);
        sanitized.push({
          command: 'swap',
          path: text(raw.path, 'path', 512),
          path2: text(raw.path2, 'path2', 512),
        });
        break;
      }
      case 'get': {
        assertAllowedKeys(raw, new Set(['command', 'path', 'depth']), `batch[${idx}] get`);
        const out = { command: 'get', path: text(raw.path, 'path', 512) };
        if (raw.depth !== undefined) {
          const d = nonNegativeInt(raw.depth, 'depth');
          if (d > 3) throw new OfficeError('ARGUMENT_INVALID', 'Batch get depth cannot exceed 3.', 'Use depth between 0 and 3.');
          out.depth = d;
        }
        sanitized.push(out);
        break;
      }
      case 'query': {
        assertAllowedKeys(raw, new Set(['command', 'selector', 'compact', 'fields']), `batch[${idx}] query`);
        const out = { command: 'query', selector: text(raw.selector, 'selector', 512) };
        if (raw.compact !== undefined) {
          if (typeof raw.compact !== 'boolean') throw new OfficeError('ARGUMENT_INVALID', 'Batch query compact must be a boolean.', 'Pass true or false for compact.');
          out.compact = raw.compact;
        }
        if (raw.fields !== undefined) {
          if (out.compact !== true) throw new OfficeError('ARGUMENT_INVALID', 'Batch query fields requires compact=true.', 'Set compact: true when specifying fields.');
          const f = text(raw.fields, 'fields', 256);
          if (!/^[\w.,-]+$/.test(f)) throw new OfficeError('ARGUMENT_INVALID', `Invalid fields list: ${f}`, 'Pass comma-separated field keys like "x,y,width".');
          out.fields = f;
        }
        sanitized.push(out);
        break;
      }
      case 'validate': {
        assertAllowedKeys(raw, new Set(['command']), `batch[${idx}] validate`);
        sanitized.push({ command: 'validate' });
        break;
      }
      default:
        throw new OfficeError(
          'ARGUMENT_INVALID',
          `Batch item ${idx} uses unsupported command "${verb}".`,
          'Use only: add, set, remove, move, swap, get, query, or validate.',
        );
    }
  }
  const input = JSON.stringify(sanitized);
  if (Buffer.byteLength(input, 'utf8') > MAX_BATCH_INPUT_BYTES) {
    throw new OfficeError('ARGUMENT_INVALID', 'Serialized batch payload exceeds 1 MiB.', 'Split large text payloads across smaller batches.');
  }
  return input;
}

function windowOutput(output, rows = DEFAULT_ROWS, cells = DEFAULT_CELLS) {
  const lines = output.split(/\r?\n/);
  const rowLimit = Math.min(MAX_ROWS, rows);
  const cellLimit = Math.min(MAX_CELLS, cells);
  let used = 0;
  const selected = [];
  for (const line of lines) {
    const found = line.match(/(?:^|\t)[A-Z]{1,3}\d+=/g)?.length ?? 0;
    if (selected.length >= rowLimit || used + found > cellLimit) break;
    used += found;
    selected.push(line);
  }
  let body = selected.join('\n');
  const limited = selected.length < lines.length || Buffer.byteLength(body) > MAX_RESULT;
  if (Buffer.byteLength(body) > MAX_RESULT) body = Buffer.from(body).subarray(0, MAX_RESULT).toString('utf8');
  return `${body}${limited ? '\n> Truncated: output window reached; narrow the range, cols, selector, or row/cell limits.' : ''}`;
}

function windowStructuredExcelView(parsed, maxRows = DEFAULT_ROWS, maxCells = DEFAULT_CELLS) {
  if (!parsed?.data || !Array.isArray(parsed.data.sheets)) return parsed;
  const rowLimit = Math.min(MAX_ROWS, maxRows);
  const cellLimit = Math.min(MAX_CELLS, maxCells);
  let usedRows = 0;
  let usedCells = 0;
  let truncated = Boolean(parsed.data.truncated);
  const sheets = [];

  for (const sheet of parsed.data.sheets) {
    const rawRows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const keptRows = [];
    let sheetTruncated = Boolean(sheet.truncated);
    for (const row of rawRows) {
      if (usedRows >= rowLimit || usedCells >= cellLimit) {
        sheetTruncated = true;
        truncated = true;
        break;
      }
      const cells = row?.cells && typeof row.cells === 'object' ? row.cells : {};
      const entries = Object.entries(cells);
      const remaining = cellLimit - usedCells;
      if (entries.length <= remaining) {
        keptRows.push(row);
        usedRows += 1;
        usedCells += entries.length;
      } else {
        keptRows.push({ ...row, cells: Object.fromEntries(entries.slice(0, remaining)), truncated: true });
        usedRows += 1;
        usedCells += remaining;
        sheetTruncated = true;
        truncated = true;
        break;
      }
    }
    if (typeof sheet.totalRows === 'number' && keptRows.length < sheet.totalRows) {
      sheetTruncated = true;
      truncated = true;
    }
    sheets.push({ ...sheet, rows: keptRows, ...(sheetTruncated ? { truncated: true } : {}) });
  }

  return {
    ...parsed,
    data: {
      ...parsed.data,
      sheets,
      returnedRows: usedRows,
      returnedCells: usedCells,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

function boundText(textOut, note) {
  if (Buffer.byteLength(textOut, 'utf8') <= MAX_RESULT) return textOut;
  const sliced = Buffer.from(textOut, 'utf8').subarray(0, MAX_RESULT - 160).toString('utf8');
  return `${sliced}\n> Truncated: ${note}`;
}

function boundMutationReceipt(result, defaultMessage) {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_RESULT) return serialized;

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const base = {
    success: true,
    truncated: true,
    ...(result.data?.summary ? { summary: result.data.summary } : {}),
    message: defaultMessage,
  };
  if (warnings.length === 0) {
    const out = JSON.stringify(base);
    return Buffer.byteLength(out, 'utf8') <= MAX_RESULT
      ? out
      : JSON.stringify({ success: true, truncated: true, message: defaultMessage });
  }
  const kept = [];
  for (const w of warnings) {
    const candidate = JSON.stringify({
      ...base,
      warnings: [...kept, w],
      omittedWarnings: warnings.length - (kept.length + 1),
    });
    if (Buffer.byteLength(candidate, 'utf8') > MAX_RESULT) break;
    kept.push(w);
  }
  const finalObj = {
    ...base,
    ...(kept.length > 0 ? { warnings: kept } : {}),
    omittedWarnings: warnings.length - kept.length,
  };
  const finalJson = JSON.stringify(finalObj);
  if (Buffer.byteLength(finalJson, 'utf8') <= MAX_RESULT) return finalJson;
  return JSON.stringify({ success: true, truncated: true, omittedWarnings: warnings.length, message: defaultMessage });
}

function boundArrayEnvelope(payload, arrayKey) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_RESULT) return serialized;
  const items = payload[arrayKey];
  if (!Array.isArray(items)) return null;
  const kept = [];
  for (const item of items) {
    const candidate = JSON.stringify({ ...payload, [arrayKey]: [...kept, item], truncated: true, shown: kept.length + 1, total: items.length });
    if (Buffer.byteLength(candidate, 'utf8') > MAX_RESULT) break;
    kept.push(item);
  }
  return JSON.stringify({ ...payload, [arrayKey]: kept, truncated: true, shown: kept.length, total: items.length });
}

function isRolledBack(result) {
  return Boolean(result?.data?.atomicRolledBack || result?.data?.summary?.atomicRolledBack);
}

function parseResult(stdout) {
  try { return JSON.parse(stdout); } catch { return stdout; }
}

function errorResult(error) {
  return {
    success: false,
    error: {
      code: error.code ?? 'ENGINE_ERROR',
      message: error.message ?? String(error),
      suggestion: error.suggestion ?? 'Check the OfficeCLI command, path and document, then retry.',
    },
  };
}

export function createOfficeCore({ locateBinary = findBinary, invoke = runProcess, scope }) {
  async function run(name, raw, context = {}) {
    let targetSnap;
    let sourceSnap;
    try {
      const args = object(raw);

      // Fileless schema lookup: no file admission or workspace required.
      if (name === 'office_help') {
        assertAllowedKeys(args, new Set(['format', 'verb', 'element']), 'office_help');
        if (!HELP_FORMATS.has(args.format)) {
          throw new OfficeError('ARGUMENT_INVALID', `Unsupported help format: ${args.format}`, 'Use docx, xlsx, or pptx.');
        }
        if (args.verb !== undefined && !HELP_VERBS.has(args.verb)) {
          throw new OfficeError('ARGUMENT_INVALID', `Unsupported help verb: ${args.verb}`, 'Use add, set, get, query, or remove.');
        }
        let element;
        if (args.element !== undefined) {
          element = text(args.element, 'element', 40);
          if (!/^[a-z0-9-]+$/.test(element)) {
            throw new OfficeError('ARGUMENT_INVALID', `Invalid help element token: ${element}`, 'Use lowercase element tokens like paragraph, table-cell, equation, chart, or slide.');
          }
        }
        const binary = await locateBinary({ binaryPath: scope?.binaryPath, signal: context.signal });
        const cli = ['help', args.format, ...(args.verb ? [args.verb] : []), ...(element ? [element] : []), '--json'];
        const { code, stdout, stderr } = await invoke(binary, cli, { signal: context.signal, maxBytes: RUN_MAX_BYTES });
        const parsed = parseResult(stdout);
        if (code !== 0 || (parsed && typeof parsed === 'object' && (parsed.success === false || parsed.error))) {
          const detail = typeof parsed === 'object' && parsed !== null ? parsed.error : undefined;
          throw new OfficeError(detail?.code ?? 'ENGINE_ERROR', detail?.message ?? detail?.error ?? (stderr || stdout || `OfficeCLI help exited with code ${code}`), 'Run office_help with only format to list valid element names.');
        }
        if (parsed && typeof parsed === 'object') {
          return { success: true, data: boundText(JSON.stringify(parsed), 'schema output exceeded 64 KiB; specify a verb to filter properties.') };
        }
        return { success: true, data: boundText(stdout, 'help output exceeded 64 KiB; specify a verb or element.') };
      }

      // Two-path CSV/TSV import into an existing .xlsx workbook (snapshot-bound target + source).
      if (name === 'office_import') {
        assertAllowedKeys(args, new Set(['file', 'sheet', 'source', 'header', 'startCell', 'delimiter', 'decimal']), 'office_import');
        const file = await admitFile(args.file, 'open', scope, { extensions: XLSX_EXTENSIONS, label: 'Target workbook' });
        const source = await admitFile(args.source, 'open', scope, { extensions: IMPORT_SOURCE_EXTENSIONS, maxBytes: MAX_IMPORT_BYTES, label: 'Import source' });
        const sheet = domPath(args.sheet, 'sheet', 256);
        if (args.header !== undefined && typeof args.header !== 'boolean') {
          throw new OfficeError('ARGUMENT_INVALID', 'header must be a boolean.', 'Pass true or false for header.');
        }
        let startCell;
        if (args.startCell !== undefined) {
          startCell = text(args.startCell, 'startCell', 16);
          if (!/^[A-Za-z]{1,3}\d{1,7}$/.test(startCell)) {
            throw new OfficeError('ARGUMENT_INVALID', `Invalid startCell: ${startCell}`, 'Use an A1-style cell reference such as "A1" or "B3".');
          }
        }
        let delimiter;
        if (args.delimiter !== undefined) {
          delimiter = text(args.delimiter, 'delimiter', 4);
          if (delimiter !== '\\t' && delimiter !== 'tab' && (delimiter.length !== 1 || /["'\r\n]/.test(delimiter))) {
            throw new OfficeError('ARGUMENT_INVALID', `Invalid delimiter: ${delimiter}`, 'Use a single non-quote character (e.g. ";", "|") or "\\t".');
          }
        }
        if (args.decimal !== undefined && args.decimal !== '.' && args.decimal !== ',') {
          throw new OfficeError('ARGUMENT_INVALID', `Invalid decimal mark: ${args.decimal}`, 'Use "." or ",".');
        }

        targetSnap = await snapshotFromFile(file, { maxBytes: MAX_ARCHIVE_BYTES, label: 'Target workbook' });
        sourceSnap = await snapshotFromFile(source, { maxBytes: MAX_IMPORT_BYTES, label: 'Import source' });
        await guardPackage(targetSnap.path);
        const binary = await locateBinary({ binaryPath: scope?.binaryPath, signal: context.signal });
        const cli = [
          'import', targetSnap.path, sheet, sourceSnap.path,
          ...(args.header ? ['--header'] : []),
          ...(startCell ? ['--start-cell', startCell] : []),
          ...(delimiter ? ['--delimiter', delimiter] : []),
          ...(args.decimal ? ['--decimal', args.decimal] : []),
          '--json',
        ];
        const { code, stdout, stderr } = await invoke(binary, cli, { signal: context.signal, maxBytes: RUN_MAX_BYTES });
        const result = parseResult(stdout);
        const isParsedObj = result !== null && typeof result === 'object';
        const envelopeOk = isParsedObj && result.success === true && !result.error && !isRolledBack(result);
        const okExit = code === 0 ? !(isParsedObj && (result.success === false || result.error || isRolledBack(result))) : (code === 2 && envelopeOk);
        if (!okExit) {
          const detail = isParsedObj ? result.error : undefined;
          throw new OfficeError(detail?.code ?? 'ENGINE_ERROR', detail?.message ?? detail?.error ?? (stderr || stdout || `OfficeCLI import exited with code ${code}`), 'Verify the target sheet exists (use office_view outline) and the CSV/TSV syntax is valid.');
        }
        await publishSnapshotAtomic(targetSnap.path, file, targetSnap.sha256);
        return {
          success: true,
          data: isParsedObj
            ? boundMutationReceipt(result, 'Import committed to disk; full receipt exceeded 64 KiB.')
            : boundText(stdout, 'import output exceeded 64 KiB.'),
        };
      }

      const file = await admitFile(args.file, name === 'office_create' ? 'create' : 'open', scope);

      // Snapshot existing Office packages so OfficeCLI consumes the EXACT bytes guardPackage verified.
      let execFile = file;
      if (name !== 'office_create') {
        targetSnap = await snapshotFromFile(file, { maxBytes: MAX_ARCHIVE_BYTES, label: 'Document' });
        await guardPackage(targetSnap.path);
        execFile = targetSnap.path;
      }

      const binary = await locateBinary({ binaryPath: scope?.binaryPath, signal: context.signal });

      if (name === 'office_preview') {
        if (args.mode !== undefined) {
          throw new OfficeError('ARGUMENT_INVALID', 'Preview mode is not a tool parameter.', 'Use office_preview for PNG or outline; HTML is reserved for the panel.');
        }
        assertAllowedKeys(args, new Set(['file', 'page', 'pages', 'grid', 'range', 'render']), 'office_preview');
        const rendered = await renderPreview(binary, execFile, {
          page: args.page,
          pages: args.pages,
          grid: args.grid,
          range: args.range,
          render: args.render,
          signal: context.signal,
          imageIn: context.imageIn,
          invoke,
        });
        return { success: true, data: rendered };
      }

      if (name === 'office_validate') {
        assertAllowedKeys(args, new Set(['file']), 'office_validate');
        const { code, stdout, stderr } = await invoke(binary, ['validate', execFile, '--json'], { signal: context.signal, maxBytes: RUN_MAX_BYTES });
        const parsed = parseResult(stdout);
        if (parsed && typeof parsed === 'object' && parsed.data && Array.isArray(parsed.data.errors)) {
          const valid = code === 0 && parsed.success === true && parsed.data.count === 0;
          const payload = {
            valid,
            count: parsed.data.count ?? parsed.data.errors.length,
            errors: parsed.data.errors,
            ...(Array.isArray(parsed.warnings) && parsed.warnings.length > 0 ? { warnings: parsed.warnings } : {}),
          };
          const bounded = boundArrayEnvelope(payload, 'errors');
          return { success: true, data: bounded ?? boundText(JSON.stringify(payload), 'validation output exceeded 64 KiB.') };
        }
        const detail = typeof parsed === 'object' && parsed !== null ? parsed.error : undefined;
        throw new OfficeError(detail?.code ?? 'ENGINE_ERROR', detail?.message ?? detail?.error ?? (stderr || stdout || `OfficeCLI validate exited with code ${code}`), 'Verify the document is a valid OOXML file.');
      }

      let cli;
      let input;
      let isTextResponse = false;
      let isJsonView = false;

      switch (name) {
        case 'office_create':
          assertAllowedKeys(args, new Set(['file']), 'office_create');
          cli = ['create', execFile, '--json'];
          break;
        case 'office_get': {
          assertAllowedKeys(args, new Set(['file', 'path', 'depth']), 'office_get');
          const depth = args.depth === undefined ? 1 : nonNegativeInt(args.depth, 'depth');
          if (depth > 3) throw new OfficeError('ARGUMENT_INVALID', 'Depth cannot exceed 3.', 'Use depth between 0 and 3.');
          cli = ['get', execFile, text(args.path, 'path', 512), '--depth', String(depth), '--json'];
          break;
        }
        case 'office_query': {
          assertAllowedKeys(args, new Set(['file', 'selector', 'find', 'compact', 'fields']), 'office_query');
          const selector = text(args.selector, 'selector', 512);
          if (args.compact !== undefined && typeof args.compact !== 'boolean') {
            throw new OfficeError('ARGUMENT_INVALID', 'compact must be a boolean.', 'Pass true or false for compact.');
          }
          if (args.fields !== undefined && args.compact !== true) {
            throw new OfficeError('ARGUMENT_INVALID', 'fields requires compact=true.', 'Set compact: true when requesting extra compact fields.');
          }
          cli = ['query', execFile, selector];
          if (args.find !== undefined) cli.push('--find', text(args.find, 'find', 4096));
          if (args.compact === true) {
            isTextResponse = true;
            cli.push('--compact');
            if (args.fields !== undefined) {
              const fields = text(args.fields, 'fields', 256);
              if (!/^[\w.,-]+$/.test(fields)) throw new OfficeError('ARGUMENT_INVALID', `Invalid fields list: ${fields}`, 'Pass comma-separated field keys like "x,y,width".');
              cli.push('--fields', fields);
            }
          } else {
            cli.push('--json');
          }
          break;
        }
        case 'office_set': {
          assertAllowedKeys(args, new Set(['file', 'path', 'props', 'find', 'replace']), 'office_set');
          const targetPath = text(args.path, 'path', 512);
          const hasFind = args.find !== undefined;
          const hasReplace = args.replace !== undefined;
          if (hasFind !== hasReplace) {
            throw new OfficeError('ARGUMENT_INVALID', 'Set requires both find and replace together.', 'Supply both find and replace, or pass props.');
          }
          if (!hasReplace && args.props === undefined) {
            throw new OfficeError('ARGUMENT_INVALID', 'Set needs replace or props.', 'Supply replacement text or properties.');
          }
          cli = ['set', execFile, targetPath];
          if (hasFind) {
            cli.push('--find', text(args.find, 'find', MAX_PROP_VALUE));
            cli.push('--replace', nullableEmptyText(args.replace, 'replace', MAX_PROP_VALUE));
          }
          if (args.props !== undefined) cli.push(...propsToFlags(args.props, { targetPath }));
          cli.push('--json');
          break;
        }
        case 'office_add': {
          assertAllowedKeys(args, new Set(['file', 'parent', 'type', 'from', 'before', 'after', 'index', 'props']), 'office_add');
          const parent = text(args.parent, 'parent', 512);
          const hasType = args.type !== undefined;
          const hasFrom = args.from !== undefined;
          if (!hasType && !hasFrom) {
            throw new OfficeError('ARGUMENT_INVALID', 'Add requires type or from.', 'Provide an element type or an internal DOM from path.');
          }
          if (hasType && hasFrom) {
            throw new OfficeError('ARGUMENT_INVALID', 'Add cannot combine both type and from.', 'Pass either type (new element) or from (clone existing element).');
          }
          let type;
          if (hasType) {
            type = text(args.type, 'type', 64);
            if (BLOCKED_ELEMENT_TYPES.has(type.toLowerCase())) {
              throw new OfficeError('ARGUMENT_INVALID', `Element type "${type}" is not permitted.`, 'Use standard OOXML document elements.');
            }
          }
          const from = hasFrom ? domPath(args.from, 'from', 512) : undefined;
          validatePlacement(args, 'office_add');
          cli = ['add', execFile, parent];
          if (type !== undefined) cli.push('--type', type);
          if (from !== undefined) cli.push('--from', from);
          if (args.before !== undefined) cli.push('--before', args.before);
          if (args.after !== undefined) cli.push('--after', args.after);
          if (args.index !== undefined) cli.push('--index', String(args.index));
          if (args.props !== undefined) cli.push(...propsToFlags(args.props, { elementType: type, targetPath: parent }));
          cli.push('--json');
          break;
        }
        case 'office_remove':
          assertAllowedKeys(args, new Set(['file', 'path']), 'office_remove');
          cli = ['remove', execFile, text(args.path, 'path', 512), '--json'];
          break;
        case 'office_view': {
          assertAllowedKeys(args, new Set(['file', 'mode', 'range', 'cols', 'start', 'end', 'maxSheetRows', 'maxCells', 'issueType', 'json']), 'office_view');
          const mode = args.mode ?? 'text';
          if (!['text', 'annotated', 'outline', 'stats', 'issues'].includes(mode)) {
            throw new OfficeError('ARGUMENT_INVALID', 'Unsupported view mode.', 'Use text, annotated, outline, stats or issues.');
          }
          if (args.json !== undefined && typeof args.json !== 'boolean') {
            throw new OfficeError('ARGUMENT_INVALID', 'json must be a boolean.', 'Pass true or false for json.');
          }
          if (args.issueType !== undefined && mode !== 'issues') {
            throw new OfficeError('ARGUMENT_INVALID', 'issueType is only supported when mode="issues".', 'Set mode to "issues" to filter by issueType.');
          }
          const rows = args.maxSheetRows === undefined ? DEFAULT_ROWS : positiveInt(args.maxSheetRows, 'maxSheetRows', MAX_ROWS);
          if (args.maxCells !== undefined) positiveInt(args.maxCells, 'maxCells', MAX_CELLS);
          isJsonView = args.json === true || (args.json !== false && (mode === 'issues' || mode === 'stats'));
          isTextResponse = !isJsonView;
          cli = ['view', execFile, mode];
          if (mode !== 'stats') cli.push('--max-lines', String(rows));
          if (args.range !== undefined) cli.push('--range', text(args.range, 'range', 512));
          if (args.cols !== undefined) {
            const cols = text(args.cols, 'cols', 256);
            if (!/^[A-Za-z]{1,3}(?:,[A-Za-z]{1,3}){0,63}$/.test(cols)) {
              throw new OfficeError('ARGUMENT_INVALID', `Invalid cols filter: ${cols}`, 'Use comma-separated Excel column letters like "A,B,C".');
            }
            cli.push('--cols', cols);
          }
          if (args.start !== undefined) cli.push('--start', String(positiveInt(args.start, 'start')));
          if (args.end !== undefined) cli.push('--end', String(positiveInt(args.end, 'end')));
          if (args.issueType !== undefined) {
            const it = text(args.issueType, 'issueType', 64);
            if (!/^[a-zA-Z_]{1,64}$/.test(it)) throw new OfficeError('ARGUMENT_INVALID', `Invalid issueType: ${it}`, 'Use a valid issue bucket or subtype name.');
            cli.push('--type', it);
          }
          if (isJsonView) cli.push('--json');
          break;
        }
        case 'office_batch': {
          assertAllowedKeys(args, new Set(['file', 'commands']), 'office_batch');
          input = sanitizeBatchCommands(args.commands);
          cli = ['batch', execFile, '--json'];
          break;
        }
        default:
          throw new OfficeError('ARGUMENT_INVALID', `Unknown tool: ${name}`, 'Use a declared Office tool.');
      }

      const { code, stdout, stderr } = await invoke(binary, cli, { input, signal: context.signal, maxBytes: RUN_MAX_BYTES });
      const result = isTextResponse ? stdout : parseResult(stdout);
      const isParsedObject = !isTextResponse && result !== null && typeof result === 'object';
      const envelopeOk = isParsedObject && result.success === true && !result.error && !isRolledBack(result);
      const okExit = code === 0
        ? !(isParsedObject && (result.success === false || result.error || isRolledBack(result)))
        : (code === 2 && envelopeOk);

      if (!okExit) {
        const detail = isParsedObject ? result.error : undefined;
        throw new OfficeError(
          detail?.code ?? 'ENGINE_ERROR',
          detail?.message ?? detail?.error ?? (stderr || stdout || `OfficeCLI exited with code ${code}`),
          'Inspect the path and element schema with office_get, office_query, or office_help, then retry.',
        );
      }

      // Atomically publish mutated snapshot back to destination (rejecting concurrent external modification).
      if (MUTATING_TOOLS.has(name) && targetSnap) {
        await publishSnapshotAtomic(targetSnap.path, file, targetSnap.sha256);
      }

      if (isJsonView && isParsedObject) {
        let shaped = result;
        if (shaped.data && Array.isArray(shaped.data.sheets)) {
          shaped = windowStructuredExcelView(shaped, args.maxSheetRows ?? DEFAULT_ROWS, args.maxCells ?? DEFAULT_CELLS);
        }
        if (shaped.data && Array.isArray(shaped.data.issues)) {
          const boundedIssues = boundArrayEnvelope({ ...shaped.data }, 'issues');
          if (boundedIssues) {
            return { success: true, data: JSON.stringify({ ...shaped, data: JSON.parse(boundedIssues) }) };
          }
        }
        const serialized = JSON.stringify(shaped);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT) {
          throw new OfficeError('RESULT_TOO_LARGE', 'Structured view result exceeds 64 KiB.', 'Narrow range, cols, maxSheetRows, maxCells, or issueType.');
        }
        return { success: true, data: serialized };
      }

      if (!isTextResponse && isParsedObject) {
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT) {
          if (MUTATING_TOOLS.has(name)) {
            return { success: true, data: boundMutationReceipt(result, 'Mutation committed to disk; full receipt exceeded 64 KiB.') };
          }
          throw new OfficeError('RESULT_TOO_LARGE', 'Structured result exceeds 64 KiB.', 'Narrow the selector, lower depth, or use compact mode on office_query.');
        }
        return { success: true, data: serialized };
      }

      if (name === 'office_query') {
        return { success: true, data: boundText(stdout, 'compact query exceeded 64 KiB; narrow the selector or add --find.') };
      }

      return { success: true, data: windowOutput(stdout, args.maxSheetRows ?? DEFAULT_ROWS, args.maxCells ?? DEFAULT_CELLS) };
    } catch (error) {
      return errorResult(error);
    } finally {
      await targetSnap?.cleanup().catch(() => undefined);
      await sourceSnap?.cleanup().catch(() => undefined);
    }
  }
  return { run };
}
