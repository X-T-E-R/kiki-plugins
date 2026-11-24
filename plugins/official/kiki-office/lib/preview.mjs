import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeError } from './paths.mjs';
import { runProcess } from './binary.mjs';

const MAX_CONTACT_PAGES = 12;

export function parsePagesSpec(raw, { isPptx = false } = {}) {
  const spec = typeof raw === 'string' ? raw.trim() : '';
  if (isPptx) {
    if (!/^\d+(?:-\d+)?$/.test(spec)) {
      throw new OfficeError(
        'ARGUMENT_INVALID',
        `Invalid PPTX pages specification: ${raw}`,
        'For .pptx, use a single slide ("2") or a contiguous range ("1-12"), not a comma-separated list.',
      );
    }
  } else if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(spec)) {
    throw new OfficeError(
      'ARGUMENT_INVALID',
      `Invalid pages specification: ${raw}`,
      'Use a page number, contiguous range ("1-12"), or comma-separated list for .docx ("1,3,5"), up to 12 pages.',
    );
  }

  let count = 0;
  for (const part of spec.split(',')) {
    const dash = part.indexOf('-');
    if (dash < 0) {
      const p = Number(part);
      if (!Number.isSafeInteger(p) || p < 1) {
        throw new OfficeError('ARGUMENT_INVALID', `Invalid page number in "${spec}".`, 'Use positive 1-based page numbers.');
      }
      count += 1;
    } else {
      const start = Number(part.slice(0, dash));
      const end = Number(part.slice(dash + 1));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new OfficeError('ARGUMENT_INVALID', `Invalid page range "${part}".`, 'Use ascending positive ranges like "1-12".');
      }
      count += (end - start + 1);
    }
    if (count > MAX_CONTACT_PAGES) {
      throw new OfficeError(
        'ARGUMENT_INVALID',
        `Preview pages "${spec}" selects more than ${MAX_CONTACT_PAGES} pages.`,
        'Split into chunks of at most 12 pages (e.g. "1-12", then "13-24").',
      );
    }
  }
  return { spec, count };
}

export async function renderPreview(
  binary,
  file,
  { mode = 'screenshot', page, pages, grid, range, render, signal, imageIn = false, invoke = runProcess } = {},
) {
  if (!['screenshot', 'html', 'outline'].includes(mode)) {
    throw new OfficeError('ARGUMENT_INVALID', 'Unsupported preview mode.', 'Choose screenshot or html.');
  }

  const ext = path.extname(file).toLowerCase();
  const isXlsx = ext === '.xlsx';
  const isPptx = ext === '.pptx';

  // Validate all arguments unconditionally BEFORE any outline fallback.
  if (page !== undefined && pages !== undefined) {
    throw new OfficeError('ARGUMENT_INVALID', 'Specify either page or pages, not both.', 'Use page for one page or pages for a 1–12 page contact sheet.');
  }
  if (range !== undefined && (typeof range !== 'string' || !range.trim() || range.length > 512 || range.includes('\0'))) {
    throw new OfficeError('ARGUMENT_INVALID', 'Invalid preview range.', 'Provide a valid sheet cell range (e.g. "Sheet1!A1:H20") or element path.');
  }

  let effectivePage;
  let effectivePages;
  let effectiveGrid;
  let pageCount = 1;

  if (isXlsx) {
    if (page !== undefined || pages !== undefined || grid !== undefined || render !== undefined) {
      throw new OfficeError('ARGUMENT_INVALID', 'Excel screenshot preview does not accept page, pages, grid, or render options.', 'Use range (e.g. "Sheet1!A1:Z50") for Excel previews.');
    }
  } else {
    if (render !== undefined && render !== 'html') {
      throw new OfficeError('ARGUMENT_INVALID', `Unsupported preview render mode: ${render}`, 'Only CSP-sandboxed "html" rendering is supported.');
    }
    if (grid !== undefined && (typeof grid !== 'string' || !/^(?:auto|[1-6])$/.test(grid.trim()))) {
      throw new OfficeError('ARGUMENT_INVALID', `Invalid grid setting: ${grid}`, 'Use "auto" or an integer column count from "1" to "6".');
    }
    if (pages !== undefined) {
      const parsed = parsePagesSpec(pages, { isPptx });
      effectivePages = parsed.spec;
      pageCount = parsed.count;
      effectiveGrid = grid !== undefined ? grid.trim() : (pageCount > 1 ? 'auto' : undefined);
    } else {
      effectivePage = page ?? 1;
      if (!Number.isInteger(effectivePage) || effectivePage < 1) {
        throw new OfficeError('ARGUMENT_INVALID', 'Page must be a positive integer.', 'Choose a valid 1-based page number.');
      }
      effectiveGrid = grid !== undefined ? grid.trim() : undefined;
    }
  }

  if (mode === 'screenshot' && !imageIn) mode = 'outline';
  if (mode === 'outline') {
    const result = await invoke(binary, ['view', file, 'outline', '--max-lines', '200'], { signal });
    if (result.code !== 0) throw new OfficeError('RENDER_FAILED', result.stderr || 'Outline rendering failed.', 'Try office_view text or check the document.');
    return { text: `Image input is unavailable for this model; document outline:\n${result.stdout.slice(0, 16_384)}` };
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'kiki-office-preview-'));
  try {
    const output = path.join(directory, mode === 'html' ? 'preview.html' : 'preview.png');
    const cli = ['view', file, mode];
    if (isXlsx) {
      cli.push('--range', range ?? 'A1:Z50');
    } else {
      cli.push('--page', effectivePages ?? String(effectivePage));
      if (effectiveGrid !== undefined) cli.push('--grid', effectiveGrid);
      if (range !== undefined) cli.push('--range', range);
      if (mode === 'screenshot') cli.push('--render', 'html');
    }
    cli.push('--out', output);

    const timeoutMs = effectiveGrid !== undefined || pageCount > 1 ? 90_000 : 60_000;
    const result = await invoke(binary, cli, { signal, timeoutMs });
    if (result.code !== 0) {
      throw new OfficeError(
        'RENDER_FAILED',
        result.stderr || result.stdout || `Preview rendering failed with exit code ${result.code}.`,
        'Ensure a headless Chromium/Edge/Firefox browser is available for HTML screenshot rendering, or fall back to office_view outline.',
      );
    }
    const bytes = await readFile(output);
    if (mode === 'html') return { html: bytes.toString('utf8').slice(0, 256 * 1024) };
    if (bytes.byteLength > 5 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new OfficeError('RENDER_FAILED', 'Preview is not a PNG within 5 MiB.', 'Try fewer pages or a narrower range, or use office_view outline.');
    }
    return {
      image: `data:image/png;base64,${bytes.toString('base64')}`,
      ...(effectivePage !== undefined ? { page: effectivePage } : {}),
      ...(effectivePages !== undefined ? { pages: effectivePages } : {}),
      ...(effectiveGrid !== undefined ? { grid: effectiveGrid } : {}),
      ...(range !== undefined ? { range } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
