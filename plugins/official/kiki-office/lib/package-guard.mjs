import { open } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OfficeError } from './paths.mjs';
import { attrValue, parseXmlStrict } from './xml-guard.mjs';

const require = createRequire(import.meta.url);
const yauzl = require('../vendor/yauzl/index.js');
const fdSlicer = require('../vendor/yauzl/fd-slicer.js');
const crc32 = require('../vendor/buffer-crc32/index.js');

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_DIRECTORY = 2 * 1024 * 1024;
const MAX_RATIO = 200;
const MAX_PRINTER_SETTINGS = 1024 * 1024;
const MAX_DEPTH = 1;

const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const KNOWN_MEDIA = /\.(?:png|jpe?g|gif|bmp|tiff?|svg|emf|wmf|webp|mp3|mp4|wav)$/i;
const TEXT_PART = /\.(?:xml|rels|vml|txt|json)$/i;

const FORMAT_SPEC = {
  docx: {
    rootDir: 'word',
    mainTypes: new Set([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
    ]),
    mainRootLocal: 'document',
    mainRootNs: new Set([
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'http://purl.oclc.org/ooxml/wordprocessingml/main',
    ]),
    printerSettingsType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.printersettings',
    chartPartPattern: /^word\/charts\/[^/]+\.xml$/i,
    embeddingPattern: /^word\/embeddings\/[^/]+\.xlsx$/i,
  },
  xlsx: {
    rootDir: 'xl',
    mainTypes: new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
    ]),
    mainRootLocal: 'workbook',
    mainRootNs: new Set([
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'http://purl.oclc.org/ooxml/spreadsheetml/main',
    ]),
    printerSettingsType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.printersettings',
    chartPartPattern: null,
    embeddingPattern: null,
  },
  pptx: {
    rootDir: 'ppt',
    mainTypes: new Set([
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
      'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
    ]),
    mainRootLocal: 'presentation',
    mainRootNs: new Set([
      'http://schemas.openxmlformats.org/presentationml/2006/main',
      'http://purl.oclc.org/ooxml/presentationml/main',
    ]),
    printerSettingsType: 'application/vnd.openxmlformats-officedocument.presentationml.printersettings',
    chartPartPattern: /^ppt\/(?:slides\/)?charts\/[^/]+\.xml$/i,
    embeddingPattern: /^ppt\/embeddings\/[^/]+\.xlsx$/i,
  },
};

const ALLOWED_FONT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.obfuscatedfont',
  'application/x-fontdata',
  'application/x-font-ttf',
  'application/x-font-otf',
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-woff',
  'application/font-woff2',
]);

const OFFICE_DOC_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'.toLowerCase(),
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'.toLowerCase(),
]);

const PACKAGE_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package'.toLowerCase(),
  'http://purl.oclc.org/ooxml/officeDocument/relationships/package'.toLowerCase(),
]);

const HYPERLINK_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'.toLowerCase(),
  'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink'.toLowerCase(),
]);

const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const EMBEDDED_XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DENIED_CONTENT_TYPE = /(?:vbaproject|vbadata|macroenabled|macrosheet|dialogsheet|activex|oleobject|x-ole|externallink|msdownload|x-msdos-program|x-dosexec|x-ms-shortcut|application\/octet-stream)/i;
const DENIED_REL_TYPE = /\/(?:vbaproject|vbadata|control|activex|oleobject|externallink|externallinkpath|macrosheets|dialogsheets|attachedtemplate|frame|subdocument|slideupdateurl|mailmergesource|mailmergeheadersource)(?:$|[/?#])/i;
const SAFE_EXTERNAL_HYPERLINK = /^(?:https?:\/\/[^\s\\]+|mailto:[^\s\\]+|#[^\s\\]+)$/i;

function formatFromFilename(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  throw new OfficeError('FORMAT_UNSUPPORTED', 'Only docx, xlsx and pptx files are supported.', 'Choose a .docx, .xlsx or .pptx document.');
}

async function readSlice(source, offset, length) {
  if (Buffer.isBuffer(source)) {
    if (offset < 0 || offset + length > source.length) {
      throw new OfficeError('PACKAGE_INVALID', 'Unexpected end of Office ZIP archive.', 'Use an uncorrupted Office document.');
    }
    return source.subarray(offset, offset + length);
  }
  const buf = Buffer.alloc(length);
  let pos = 0;
  while (pos < length) {
    const { bytesRead } = await source.read(buf, pos, length - pos, offset + pos);
    if (bytesRead <= 0) break;
    pos += bytesRead;
  }
  if (pos !== length) {
    throw new OfficeError('PACKAGE_INVALID', 'Unexpected end of Office ZIP archive.', 'Use an uncorrupted Office document.');
  }
  return buf;
}

async function validateEocdr(source, size) {
  if (size < 22) {
    throw new OfficeError('PACKAGE_INVALID', 'Office document is too small to be a valid ZIP archive.', 'Use an uncorrupted Office document.');
  }
  const tailSize = Math.min(size, 65_557 + 20);
  const tailOffset = size - tailSize;
  const tail = await readSlice(source, tailOffset, tailSize);
  let end = -1;
  for (let index = tailSize - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tailSize) {
      end = index;
      break;
    }
  }
  if (end < 0) {
    throw new OfficeError('PACKAGE_INVALID', 'Office document has no valid ZIP central directory.', 'Use an uncorrupted Office document.');
  }
  if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
    throw new OfficeError('PACKAGE_LIMIT', 'Office document uses ZIP64, which is not allowed.', 'Save the document as a standard OOXML package without ZIP64.');
  }
  const disk = tail.readUInt16LE(end + 4);
  const cdDisk = tail.readUInt16LE(end + 6);
  const entriesOnDisk = tail.readUInt16LE(end + 8);
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const cdOffset = tail.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== count) {
    throw new OfficeError('PACKAGE_INVALID', 'Multi-disk or inconsistent Office ZIP directory.', 'Use an uncorrupted single-file Office document.');
  }
  if (count === 0xffff || directorySize === 0xffffffff || cdOffset === 0xffffffff || count > MAX_PARTS || directorySize > MAX_DIRECTORY) {
    throw new OfficeError('PACKAGE_LIMIT', 'Office document ZIP directory exceeds safe limits or uses ZIP64.', 'Choose a smaller Office document.');
  }
  const eocdrAbsOffset = tailOffset + end;
  if (cdOffset + directorySize !== eocdrAbsOffset) {
    throw new OfficeError('PACKAGE_INVALID', 'Office ZIP central directory bounds are ambiguous or have trailing data.', 'Use an uncorrupted Office document.');
  }
  return { count, directorySize, cdOffset };
}

async function validateDataDescriptor(source, dataEnd, cdOffset, entry) {
  if (dataEnd + 12 > cdOffset) {
    throw new OfficeError('PACKAGE_INVALID', `Truncated ZIP data descriptor for: ${entry.fileName}`, 'Use an uncorrupted Office document.');
  }
  const peek = await readSlice(source, dataEnd, Math.min(16, cdOffset - dataEnd));
  const hasSig = peek.length >= 16 && peek.readUInt32LE(0) === 0x08074b50;
  const base = hasSig ? 4 : 0;
  const ddLen = hasSig ? 16 : 12;
  if (dataEnd + ddLen > cdOffset) {
    throw new OfficeError('PACKAGE_INVALID', `Data descriptor overflows central directory for: ${entry.fileName}`, 'Use an uncorrupted Office document.');
  }
  const ddCrc = peek.readUInt32LE(base);
  const ddComp = peek.readUInt32LE(base + 4);
  const ddUncomp = peek.readUInt32LE(base + 8);
  if ((ddCrc >>> 0) !== (entry.crc32 >>> 0) || ddComp !== entry.compressedSize || ddUncomp !== entry.uncompressedSize) {
    throw new OfficeError('PACKAGE_UNSAFE', `Data descriptor diverges from central directory for: ${entry.fileName}`, 'Use an uncorrupted Office document.');
  }
  return ddLen;
}

function validatePartName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new OfficeError('PACKAGE_UNSAFE', `Unsafe Office part name: ${name}`, 'Use a document without traversal or absolute ZIP entry names.');
  }
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = trimmed.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new OfficeError('PACKAGE_UNSAFE', `Unsafe Office part path: ${name}`, 'Use a document without traversal or ambiguous ZIP entry names.');
  }
}

function shouldBufferPart(name, depth, format) {
  const lower = name.toLowerCase();
  if (lower === '[content_types].xml') return true;
  if (lower.endsWith('.rels')) return true;
  if (/^customxml\/[^/]+\.xml$/i.test(name)) return true;
  if (depth === 0 && FORMAT_SPEC[format].embeddingPattern?.test(name)) return true;
  return false;
}

function openYauzl(source, size) {
  const opts = { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false };
  return new Promise((resolve, reject) => {
    const cb = (err, zip) => (err ? reject(new OfficeError('PACKAGE_INVALID', err.message, 'Use an uncorrupted Office document.')) : resolve(zip));
    if (Buffer.isBuffer(source)) {
      yauzl.fromBuffer(source, opts, cb);
    } else {
      const reader = fdSlicer.createFromFd(source.fd, { autoClose: false });
      yauzl.fromRandomAccessReader(reader, size, opts, cb);
    }
  });
}

function readLocalHeader(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.readLocalFileHeader(entry, { minimal: false }, (err, lfh) => {
      if (err) reject(new OfficeError('PACKAGE_INVALID', `Malformed local ZIP header for ${entry.fileName}: ${err.message}`, 'Use an uncorrupted Office document.'));
      else resolve(lfh);
    });
  });
}

function readEntryBytesBounded(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(new OfficeError('PACKAGE_INVALID', `Cannot read Office part ${entry.fileName}: ${err.message}`, 'Use an uncorrupted Office document.'));
        return;
      }
      const chunks = [];
      let total = 0;
      let done = false;
      stream.on('data', (chunk) => {
        if (done) return;
        total += chunk.length;
        if (total > MAX_PART || total > entry.uncompressedSize) {
          done = true;
          stream.destroy();
          reject(new OfficeError('PACKAGE_LIMIT', `Office part exceeds size bound: ${entry.fileName}`, 'Use a smaller document.'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (e) => {
        if (done) return;
        done = true;
        reject(new OfficeError('PACKAGE_INVALID', `Corrupt stream in Office part ${entry.fileName}: ${e.message}`, 'Use an uncorrupted Office document.'));
      });
      stream.on('end', () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks, total));
      });
    });
  });
}

function streamAndVerifyEntry(zip, entry, { budget, captureBytes, maxPartOverride }) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(new OfficeError('PACKAGE_INVALID', `Cannot read Office part ${entry.fileName}: ${err.message}`, 'Use an uncorrupted Office document.'));
        return;
      }
      const maxForPart = Math.min(MAX_PART, maxPartOverride ?? MAX_PART);
      const chunks = captureBytes ? [] : null;
      let actualSize = 0;
      let runningCrc = 0;
      let done = false;
      const fail = (officeErr) => {
        if (done) return;
        done = true;
        stream.destroy();
        reject(officeErr);
      };
      stream.on('data', (chunk) => {
        if (done) return;
        actualSize += chunk.length;
        budget.actualExpanded += chunk.length;
        if (actualSize > maxForPart || budget.actualExpanded > MAX_ARCHIVE_BYTES) {
          fail(new OfficeError('PACKAGE_LIMIT', `Office part exceeds decompression budget: ${entry.fileName}`, 'Use a smaller document within the 256 MiB / 64 MiB limits.'));
          return;
        }
        if (actualSize > entry.uncompressedSize) {
          fail(new OfficeError('PACKAGE_INVALID', `Office part decompressed size exceeds declared size: ${entry.fileName}`, 'Use an uncorrupted Office document.'));
          return;
        }
        if (entry.compressedSize === 0 ? actualSize > 0 : actualSize / entry.compressedSize > MAX_RATIO) {
          fail(new OfficeError('PACKAGE_LIMIT', `Office part exceeds 200:1 decompression ratio: ${entry.fileName}`, 'Use a document without extreme ZIP compression ratios.'));
          return;
        }
        runningCrc = crc32.unsigned(chunk, runningCrc);
        if (chunks) chunks.push(chunk);
      });
      stream.on('error', (streamErr) => {
        if (done) return;
        done = true;
        reject(new OfficeError('PACKAGE_INVALID', `Corrupt stream in Office part ${entry.fileName}: ${streamErr.message}`, 'Use an uncorrupted Office document.'));
      });
      stream.on('end', () => {
        if (done) return;
        done = true;
        if (actualSize !== entry.uncompressedSize) {
          reject(new OfficeError('PACKAGE_INVALID', `Office part size mismatch: ${entry.fileName}`, 'Use an uncorrupted Office document.'));
          return;
        }
        if ((runningCrc >>> 0) !== (entry.crc32 >>> 0)) {
          reject(new OfficeError('PACKAGE_INVALID', `CRC-32 mismatch in Office part: ${entry.fileName}`, 'Use an uncorrupted Office document.'));
          return;
        }
        resolve({ actualSize, bytes: chunks ? Buffer.concat(chunks, actualSize) : null });
      });
    });
  });
}

function parseContentTypes(bytes) {
  const root = parseXmlStrict(bytes, '[Content_Types].xml');
  if (root.local !== 'Types' || root.ns !== CONTENT_TYPES_NS) {
    throw new OfficeError('PACKAGE_INVALID', 'Invalid [Content_Types].xml root element.', 'Use a valid OOXML document.');
  }
  const defaults = new Map();
  const overrides = new Map();
  for (const child of root.children) {
    if (child.ns !== CONTENT_TYPES_NS) {
      throw new OfficeError('PACKAGE_INVALID', `Unexpected element <${child.qname}> in [Content_Types].xml.`, 'Use a valid OOXML document.');
    }
    if (child.local === 'Default') {
      const ext = attrValue(child, 'Extension');
      const ct = attrValue(child, 'ContentType');
      if (!ext || !ct) throw new OfficeError('PACKAGE_INVALID', 'Incomplete Default entry in [Content_Types].xml.', 'Use a valid OOXML document.');
      const key = ext.toLowerCase();
      if (defaults.has(key)) throw new OfficeError('PACKAGE_INVALID', `Duplicate Default extension "${ext}" in [Content_Types].xml.`, 'Use a valid OOXML document.');
      if (DENIED_CONTENT_TYPE.test(ct)) {
        throw new OfficeError('PACKAGE_UNSAFE', `Disallowed active/binary content type "${ct}" in [Content_Types].xml.`, 'Remove macros, ActiveX, OLE objects, or external links before opening.');
      }
      defaults.set(key, ct.toLowerCase());
    } else if (child.local === 'Override') {
      const partName = attrValue(child, 'PartName');
      const ct = attrValue(child, 'ContentType');
      if (!partName || !ct || !partName.startsWith('/')) {
        throw new OfficeError('PACKAGE_INVALID', 'Invalid Override entry in [Content_Types].xml.', 'Use a valid OOXML document.');
      }
      const norm = partName.slice(1).toLowerCase();
      if (overrides.has(norm)) throw new OfficeError('PACKAGE_INVALID', `Duplicate Override part "${partName}" in [Content_Types].xml.`, 'Use a valid OOXML document.');
      if (DENIED_CONTENT_TYPE.test(ct)) {
        throw new OfficeError('PACKAGE_UNSAFE', `Disallowed active/binary content type "${ct}" for ${partName}.`, 'Remove macros, ActiveX, OLE objects, or external links before opening.');
      }
      overrides.set(norm, ct.toLowerCase());
    } else {
      throw new OfficeError('PACKAGE_INVALID', `Unsupported element <${child.qname}> in [Content_Types].xml.`, 'Use a valid OOXML document.');
    }
  }
  const resolveType = (partName) => {
    const lower = partName.toLowerCase();
    if (overrides.has(lower)) return overrides.get(lower);
    const dot = lower.lastIndexOf('.');
    if (dot >= 0) {
      const ext = lower.slice(dot + 1);
      if (defaults.has(ext)) return defaults.get(ext);
    }
    return undefined;
  };
  return { defaults, overrides, resolveType };
}

function ownerOfRels(relsPath) {
  if (relsPath.toLowerCase() === '_rels/.rels') return { ownerPart: '', ownerDir: '' };
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/i.exec(relsPath);
  if (!match) {
    throw new OfficeError('PACKAGE_INVALID', `Unexpected relationship part path: ${relsPath}`, 'Use a valid OOXML document.');
  }
  const ownerDir = match[1];
  const ownerFile = match[2];
  return { ownerPart: `${ownerDir}/${ownerFile}`, ownerDir };
}

function resolveInternalTarget(ownerDir, rawTarget, relsPath) {
  if (!rawTarget || rawTarget.includes('\0') || rawTarget.includes('\\') || /[\x00-\x1f]/.test(rawTarget)) {
    throw new OfficeError('PACKAGE_UNSAFE', `Unsafe relationship target "${rawTarget}" in ${relsPath}.`, 'Remove invalid relationship targets before opening.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawTarget) || rawTarget.startsWith('//')) {
    throw new OfficeError('PACKAGE_UNSAFE', `Network or scheme URI "${rawTarget}" used as internal relationship in ${relsPath}.`, 'Remove external or URI targets from internal relationships.');
  }
  const hashIdx = rawTarget.indexOf('#');
  const pathOnly = hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget;
  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    throw new OfficeError('PACKAGE_UNSAFE', `Malformed percent-encoding in relationship target "${rawTarget}" in ${relsPath}.`, 'Use an uncorrupted Office document.');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new OfficeError('PACKAGE_UNSAFE', `Unsafe decoded relationship target "${rawTarget}" in ${relsPath}.`, 'Remove traversal targets before opening.');
  }
  const isRooted = decoded.startsWith('/');
  const baseSegments = isRooted ? [] : (ownerDir ? ownerDir.split('/') : []);
  const targetSegments = (isRooted ? decoded.slice(1) : decoded).split('/');
  const resolved = [...baseSegments];
  for (const seg of targetSegments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (resolved.length === 0) {
        throw new OfficeError('PACKAGE_UNSAFE', `Relationship target escapes package root: "${rawTarget}" in ${relsPath}.`, 'Remove path-traversal relationship targets.');
      }
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  if (resolved.length === 0) {
    throw new OfficeError('PACKAGE_UNSAFE', `Relationship target resolves to empty package path in ${relsPath}.`, 'Use a valid OOXML document.');
  }
  return resolved.join('/');
}

async function guardArchive(source, size, { expectedFormat, depth, budget }) {
  if (depth > MAX_DEPTH) {
    throw new OfficeError('PACKAGE_UNSAFE', 'Nested Office archive depth exceeds limit (max 1).', 'Remove nested embeddings inside embedded chart workbooks.');
  }
  if (size > MAX_ARCHIVE_BYTES) {
    throw new OfficeError('PACKAGE_LIMIT', 'Office document exceeds 256 MiB.', 'Choose a smaller document.');
  }
  budget.inputBytes += size;
  if (budget.inputBytes > MAX_ARCHIVE_BYTES) {
    throw new OfficeError('PACKAGE_LIMIT', 'Cumulative Office package input bytes exceed 256 MiB.', 'Choose a smaller document.');
  }

  const { cdOffset } = await validateEocdr(source, size);
  const spec = FORMAT_SPEC[expectedFormat];
  const zip = await openYauzl(source, size);
  const parts = new Map(); // lowerName -> { name, actualSize, bytes, entry }
  const lowerNames = new Set();
  const spans = [];

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      zip.on('error', (err) => done(new OfficeError('PACKAGE_INVALID', err.message, 'Use an uncorrupted Office document.')));
      zip.on('end', () => done());
      zip.on('entry', (entry) => {
        (async () => {
          budget.totalEntries += 1;
          if (budget.totalEntries > MAX_PARTS) {
            throw new OfficeError('PACKAGE_LIMIT', 'Office document exceeds 10,000 total archive entries.', 'Choose a smaller document.');
          }
          if (entry.extraFields.some((field) => field.id === 0x0001)) {
            throw new OfficeError('PACKAGE_LIMIT', `ZIP64 entry is not allowed: ${entry.fileName}`, 'Save without ZIP64 extensions.');
          }
          if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x0041) !== 0) {
            throw new OfficeError('PACKAGE_UNSAFE', `Encrypted Office part is not allowed: ${entry.fileName}`, 'Decrypt or remove password protection before opening.');
          }
          if (![0, 8].includes(entry.compressionMethod)) {
            throw new OfficeError('PACKAGE_UNSAFE', `Unsupported ZIP compression method (${entry.compressionMethod}) for: ${entry.fileName}`, 'Use a standard Store/Deflate Office package.');
          }
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
            throw new OfficeError('PACKAGE_UNSAFE', `Symbolic link entry is not allowed: ${entry.fileName}`, 'Use a standard Office package without symlinks.');
          }
          const name = entry.fileName;
          validatePartName(name);
          const lower = name.toLowerCase();
          if (lowerNames.has(lower)) {
            throw new OfficeError('PACKAGE_UNSAFE', `Duplicate Office part name: ${name}`, 'Use an uncorrupted Office package without duplicate entries.');
          }
          lowerNames.add(lower);

          const lfh = await readLocalHeader(zip, entry);
          const dataEnd = lfh.fileDataStart + entry.compressedSize;
          if (dataEnd > cdOffset) {
            throw new OfficeError('PACKAGE_INVALID', `ZIP entry payload overflows central directory bounds: ${name}`, 'Use an uncorrupted Office document.');
          }
          if (!lfh.fileName.equals(entry.fileNameRaw)) {
            throw new OfficeError('PACKAGE_UNSAFE', `Local and central ZIP filenames diverge for: ${name}`, 'Use an uncorrupted Office document.');
          }
          if (lfh.compressionMethod !== entry.compressionMethod || lfh.generalPurposeBitFlag !== entry.generalPurposeBitFlag) {
            throw new OfficeError('PACKAGE_UNSAFE', `Local and central ZIP header flags or method diverge for: ${name}`, 'Use an uncorrupted Office document.');
          }
          const hasDataDescriptor = (lfh.generalPurposeBitFlag & 0x0008) !== 0;
          let ddLen = 0;
          if (!hasDataDescriptor) {
            if (lfh.crc32 !== entry.crc32 || lfh.compressedSize !== entry.compressedSize || lfh.uncompressedSize !== entry.uncompressedSize) {
              throw new OfficeError('PACKAGE_UNSAFE', `Local and central ZIP sizes or CRC diverge for: ${name}`, 'Use an uncorrupted Office document.');
            }
          } else {
            const validZero = lfh.crc32 === 0 && lfh.compressedSize === 0 && lfh.uncompressedSize === 0;
            const validMatch = lfh.crc32 === entry.crc32 && lfh.compressedSize === entry.compressedSize && lfh.uncompressedSize === entry.uncompressedSize;
            if (!validZero && !validMatch) {
              throw new OfficeError('PACKAGE_UNSAFE', `Inconsistent data-descriptor local ZIP header for: ${name}`, 'Use an uncorrupted Office document.');
            }
            ddLen = await validateDataDescriptor(source, dataEnd, cdOffset, entry);
          }

          spans.push({ start: entry.relativeOffsetOfLocalHeader, end: dataEnd + ddLen, name });

          if (name.endsWith('/')) {
            if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0) {
              throw new OfficeError('PACKAGE_INVALID', `Non-empty directory entry: ${name}`, 'Use an uncorrupted Office document.');
            }
            zip.readEntry();
            return;
          }

          if (/(?:^|\/)activex(?:\/|$)/i.test(name) || /(?:^|\/)(?:vbaproject|vbadata)[^/]*$/i.test(name) || lower.startsWith('xl/embeddings/')) {
            throw new OfficeError('UNKNOWN_BINARY_PART', `Unsupported active or embedded Office part: ${name}`, 'Remove macros, ActiveX controls, or Excel embeddings before opening.');
          }

          const isPrinterSettings = new RegExp(`^${spec.rootDir}\\/printerSettings\\/[^/]+\\.bin$`, 'i').test(name);
          const maxPartOverride = isPrinterSettings ? MAX_PRINTER_SETTINGS : MAX_PART;
          budget.declaredExpanded += entry.uncompressedSize;
          if (entry.uncompressedSize > maxPartOverride || budget.declaredExpanded > MAX_ARCHIVE_BYTES || (entry.compressedSize === 0 ? entry.uncompressedSize > 0 : entry.uncompressedSize / entry.compressedSize > MAX_RATIO)) {
            throw new OfficeError('PACKAGE_LIMIT', `Office part exceeds decompression limits: ${name}`, 'Use a smaller document; avoid extreme ZIP compression ratios.');
          }

          const captureBytes = shouldBufferPart(name, depth, expectedFormat);
          const { actualSize, bytes } = await streamAndVerifyEntry(zip, entry, { budget, captureBytes, maxPartOverride });
          parts.set(lower, { name, actualSize, bytes, entry });
          zip.readEntry();
        })().catch(done);
      });
      zip.readEntry();
    });

    // Reject overlapping local ZIP records
    spans.sort((a, b) => a.start - b.start);
    for (let idx = 1; idx < spans.length; idx++) {
      if (spans[idx].start < spans[idx - 1].end) {
        throw new OfficeError('PACKAGE_UNSAFE', `Overlapping ZIP local records: ${spans[idx - 1].name} and ${spans[idx].name}`, 'Use an uncorrupted Office document without ambiguous ZIP records.');
      }
    }

    // 1. Validate [Content_Types].xml
    const ctPart = parts.get('[content_types].xml');
    if (!ctPart?.bytes) {
      throw new OfficeError('PACKAGE_INVALID', 'Missing [Content_Types].xml in Office package.', 'Use a valid OOXML document.');
    }
    const contentTypes = parseContentTypes(ctPart.bytes);

    // 2. Validate all .rels files (including _rels/.rels)
    const rootRelsPart = parts.get('_rels/.rels');
    if (!rootRelsPart?.bytes) {
      throw new OfficeError('PACKAGE_INVALID', 'Missing root _rels/.rels in Office package.', 'Use a valid OOXML document.');
    }

    const mainDocParts = [];
    const chartEmbeddingTargets = new Set();

    for (const [lowerName, part] of parts.entries()) {
      if (!lowerName.endsWith('.rels')) continue;
      const relsRoot = parseXmlStrict(part.bytes, part.name);
      if (relsRoot.local !== 'Relationships' || relsRoot.ns !== RELS_NS) {
        throw new OfficeError('PACKAGE_INVALID', `Invalid relationships root element in ${part.name}.`, 'Use a valid OOXML document.');
      }
      const { ownerPart, ownerDir } = ownerOfRels(part.name);
      const isRootRels = lowerName === '_rels/.rels';
      if (!isRootRels && !parts.has(ownerPart.toLowerCase())) {
        throw new OfficeError('PACKAGE_INVALID', `Orphan relationship part ${part.name} has no owning part "${ownerPart}".`, 'Use a valid OOXML document.');
      }
      const isCustomXmlRels = lowerName.startsWith('customxml/_rels/');
      const isChartRels = depth === 0 && Boolean(spec.chartPartPattern?.test(ownerPart));
      const seenIds = new Set();

      for (const rel of relsRoot.children) {
        if (rel.local !== 'Relationship' || rel.ns !== RELS_NS) {
          throw new OfficeError('PACKAGE_INVALID', `Unexpected element <${rel.qname}> in ${part.name}.`, 'Use a valid OOXML document.');
        }
        const id = attrValue(rel, 'Id');
        const type = attrValue(rel, 'Type');
        const target = attrValue(rel, 'Target');
        const targetMode = attrValue(rel, 'TargetMode');
        if (!id || !type || !target) {
          throw new OfficeError('PACKAGE_INVALID', `Incomplete Relationship entry in ${part.name}.`, 'Use a valid OOXML document.');
        }
        if (seenIds.has(id)) {
          throw new OfficeError('PACKAGE_INVALID', `Duplicate Relationship Id "${id}" in ${part.name}.`, 'Use a valid OOXML document.');
        }
        seenIds.add(id);

        const lowerType = type.toLowerCase();
        if (DENIED_REL_TYPE.test(lowerType)) {
          throw new OfficeError('PACKAGE_UNSAFE', `Disallowed relationship type "${type}" in ${part.name}.`, 'Remove macros, ActiveX, OLE objects, external workbook links, or attached templates.');
        }

        const mode = targetMode === undefined ? 'internal' : targetMode.toLowerCase();
        if (mode === 'external') {
          if (depth > 0) {
            throw new OfficeError('PACKAGE_UNSAFE', `External relationship not allowed in embedded workbook (${part.name}).`, 'Remove external relationships from embedded chart data.');
          }
          if (isCustomXmlRels || isRootRels || isChartRels) {
            throw new OfficeError('PACKAGE_UNSAFE', `External relationship not allowed in ${part.name}.`, 'Remove external links from package root, charts, or customXml.');
          }
          if (!HYPERLINK_REL_TYPES.has(lowerType) || !SAFE_EXTERNAL_HYPERLINK.test(target)) {
            throw new OfficeError('PACKAGE_UNSAFE', `External relationship "${target}" (${type}) is blocked in ${part.name}.`, 'Only inert top-level web citation hyperlinks (http/https/mailto) are permitted.');
          }
          continue;
        }
        if (mode !== 'internal') {
          throw new OfficeError('PACKAGE_UNSAFE', `Unsupported TargetMode "${targetMode}" in ${part.name}.`, 'Use a valid OOXML document.');
        }

        if (HYPERLINK_REL_TYPES.has(lowerType) && target.startsWith('#')) {
          continue;
        }

        const resolved = resolveInternalTarget(ownerDir, target, part.name);
        const resolvedLower = resolved.toLowerCase();
        if (!parts.has(resolvedLower)) {
          throw new OfficeError('PACKAGE_INVALID', `Relationship target "${target}" (resolved "${resolved}") is missing in ${part.name}.`, 'Use an uncorrupted Office document.');
        }

        if (isRootRels && OFFICE_DOC_REL_TYPES.has(lowerType)) {
          const mainType = contentTypes.resolveType(resolved);
          if (mainType && spec.mainTypes.has(mainType)) {
            mainDocParts.push(parts.get(resolvedLower));
          } else {
            throw new OfficeError('PACKAGE_UNSAFE', `Main document part "${resolved}" has unsupported content type "${mainType ?? 'unknown'}" for ${expectedFormat}.`, 'Use a standard non-macro Office document matching its file extension.');
          }
        }

        if (isChartRels && PACKAGE_REL_TYPES.has(lowerType)) {
          const ownerCt = contentTypes.resolveType(ownerPart);
          if (ownerCt === CHART_CONTENT_TYPE) {
            chartEmbeddingTargets.add(resolvedLower);
          }
        }
      }
    }

    if (mainDocParts.length === 0) {
      throw new OfficeError('PACKAGE_INVALID', `Office ${expectedFormat} package is missing a valid main document part.`, 'Use a valid non-macro .docx, .xlsx, or .pptx document.');
    }

    // Verify actual XML root element & OOXML namespace of the main document part at both depths
    for (const mainPart of mainDocParts) {
      const mainBytes = mainPart.bytes ?? await readEntryBytesBounded(zip, mainPart.entry);
      const mainRoot = parseXmlStrict(mainBytes, mainPart.name);
      if (mainRoot.local !== spec.mainRootLocal || !spec.mainRootNs.has(mainRoot.ns)) {
        throw new OfficeError('PACKAGE_INVALID', `Main part "${mainPart.name}" has unexpected XML root <${mainRoot.qname}> for ${expectedFormat}.`, 'Use a valid non-macro Office document.');
      }
    }

    // 3. Classify every part by canonical path + resolved content type, parse customXml, and collect depth-1 workbooks
    const embeddedWorkbooks = [];

    for (const [lowerName, part] of parts.entries()) {
      if (lowerName === '[content_types].xml') continue;
      const ct = contentTypes.resolveType(part.name);
      if (!ct) {
        throw new OfficeError('PACKAGE_INVALID', `Part has no declared OOXML content type: ${part.name}`, 'Use a valid OOXML document.');
      }
      if (DENIED_CONTENT_TYPE.test(ct)) {
        throw new OfficeError('PACKAGE_UNSAFE', `Disallowed content type "${ct}" on part: ${part.name}`, 'Remove macros, ActiveX, OLE objects, or external links before opening.');
      }

      if (lowerName.startsWith('customxml/')) {
        if (/^customxml\/[^/]+\.xml$/i.test(part.name)) {
          parseXmlStrict(part.bytes, part.name);
          continue;
        }
        if (/^customxml\/_rels\/[^/]+\.rels$/i.test(part.name)) {
          continue;
        }
        throw new OfficeError('UNKNOWN_BINARY_PART', `Unsupported part in customXml subtree: ${part.name}`, 'Only customXml/*.xml and customXml/_rels/*.rels are permitted.');
      }

      if (/(?:^|\/)embeddings\//i.test(lowerName)) {
        if (depth > 0) {
          throw new OfficeError('PACKAGE_UNSAFE', `Nested embedding at depth ${depth} is forbidden: ${part.name}`, 'Remove nested archives inside embedded chart workbooks.');
        }
        if (spec.embeddingPattern?.test(part.name) && ct === EMBEDDED_XLSX_CONTENT_TYPE && chartEmbeddingTargets.has(lowerName)) {
          embeddedWorkbooks.push(part);
          continue;
        }
        throw new OfficeError('UNKNOWN_BINARY_PART', `Unsupported embedded Office part: ${part.name}`, 'Only chart-linked .xlsx chart workbooks are permitted in word/embeddings or ppt/embeddings.');
      }

      if (/(?:^|\/)printersettings\//i.test(lowerName)) {
        const validPath = new RegExp(`^${spec.rootDir}\\/printerSettings\\/[^/]+\\.bin$`, 'i').test(part.name);
        if (validPath && ct === spec.printerSettingsType && part.actualSize <= MAX_PRINTER_SETTINGS) {
          continue;
        }
        throw new OfficeError('UNKNOWN_BINARY_PART', `Unsupported printerSettings part: ${part.name}`, 'Inspect printer settings parts before opening.');
      }

      if (/(?:^|\/)fonts\//i.test(lowerName)) {
        const validFontPath = new RegExp(`^${spec.rootDir}\\/fonts\\/[^/]+\\.(?:odttf|fntdata|ttf|otf|woff2?)$`, 'i').test(part.name);
        if (validFontPath && ALLOWED_FONT_TYPES.has(ct)) {
          continue;
        }
        throw new OfficeError('UNKNOWN_BINARY_PART', `Unsupported font part: ${part.name}`, 'Only recognized OOXML font parts with standard font content types are permitted.');
      }

      if (TEXT_PART.test(part.name) || KNOWN_MEDIA.test(part.name)) {
        continue;
      }

      throw new OfficeError('UNKNOWN_BINARY_PART', `Unknown Office package part: ${part.name}`, 'Do not open this document with Office tools; inspect its embedded parts first.');
    }

    // Close outer zip before recursing depth-1 buffers
    zip.close();

    // 4. Recursively validate every admitted depth-0 embedded chart workbook at depth 1 sharing the exact same budget
    for (const embedded of embeddedWorkbooks) {
      await guardArchive(embedded.bytes, embedded.bytes.length, {
        expectedFormat: 'xlsx',
        depth: depth + 1,
        budget,
      });
    }
  } finally {
    zip.close();
  }
}

export async function guardPackage(file) {
  const expectedFormat = formatFromFilename(file);
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new OfficeError('FILE_MISSING', `Document is not a regular file: ${file}`, 'Provide an existing regular .docx, .xlsx, or .pptx file.');
    }
    const budget = {
      inputBytes: 0,
      declaredExpanded: 0,
      actualExpanded: 0,
      totalEntries: 0,
    };
    await guardArchive(handle, info.size, { expectedFormat, depth: 0, budget });
  } finally {
    await handle.close();
  }
}
