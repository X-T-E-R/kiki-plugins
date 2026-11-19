import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sessionSourceDefinition } from './definitions.mjs';

const MAX_RECORD_CODE_UNITS = 48 * 1024;

function normalizeRole(kind) {
  if (kind === 'user') return 'user';
  if (kind === 'assistant' || kind === 'thought') return 'assistant';
  if (kind === 'tool_call') return 'tool_call';
  if (kind === 'tool') return 'tool';
  if (kind === 'system') return 'system';
  return 'metadata';
}

function splitIntoRecords(baseId, role, text, timestamp, toolMeta = {}) {
  const value = String(text ?? '');
  const records = [];
  for (let part = 0, offset = 0; part === 0 || offset < value.length; part += 1) {
    let end = Math.min(value.length, offset + MAX_RECORD_CODE_UNITS);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) {
      end -= 1;
    }
    records.push({
      id: baseId,
      part,
      role,
      text: value.slice(offset, end),
      ...(timestamp ? { timestamp: String(timestamp) } : {}),
      ...(toolMeta.toolName ? { toolName: String(toolMeta.toolName).slice(0, 200) } : {}),
      ...(toolMeta.toolCallId ? { toolCallId: String(toolMeta.toolCallId).slice(0, 200) } : {}),
      textOffset: offset,
      textTotal: value.length,
    });
    offset = end;
  }
  return records;
}

async function listSeatSnapshotFiles(home) {
  if (!path.isAbsolute(home)) {
    throw new Error('Choose an absolute folder containing exported Vibe42 seat snapshots');
  }
  const canonicalHome = await realpath(home);
  const dirEntries = await readdir(canonicalHome, { withFileTypes: true });
  const files = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  return { canonicalHome, files };
}

async function readSnapshot(home, externalId) {
  const { canonicalHome, files } = await listSeatSnapshotFiles(home);
  const match = files.find((name) => name === externalId || name.replace(/\.json$/i, '') === externalId);
  if (!match) {
    throw new Error(`Seat snapshot "${externalId}" was not found in ${canonicalHome}`);
  }
  const fullPath = await realpath(path.join(canonicalHome, match));
  const rawBytes = await readFile(fullPath);
  const parsed = JSON.parse(rawBytes.toString('utf8'));
  return {
    canonicalHome,
    rawBytes,
    parsed,
  };
}

function revisionForBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createV42SessionSourceAdapter() {
  return {
    async discover({ home, cursor }, context) {
      context?.signal?.throwIfAborted();
      const { canonicalHome, files } = await listSeatSnapshotFiles(home);
      const start = Number(cursor ?? 0);
      const slice = files.slice(start, start + 50);
      const entries = [];
      for (const file of slice) {
        context?.signal?.throwIfAborted();
        const raw = JSON.parse(await readFile(path.join(canonicalHome, file), 'utf8'));
        const id = String(raw.id || raw.seatRef || file.replace(/\.json$/i, ''));
        const title = String(raw.title || raw.seatRef || id).slice(0, 500);
        entries.push({ externalId: file, title });
      }
      return {
        entries,
        cursor: start + slice.length < files.length ? String(start + slice.length) : null,
      };
    },

    async probe({ home, externalId }, context) {
      context?.signal?.throwIfAborted();
      const { canonicalHome, rawBytes, parsed } = await readSnapshot(home, externalId);
      const rows = Array.isArray(parsed.rows) ? parsed.rows : (Array.isArray(parsed.messages) ? parsed.messages : []);
      const mediaDrops = rows.filter((r) => r?.media).length;
      const losses = mediaDrops > 0
        ? [{ code: 'remote_media_omitted', count: mediaDrops, detail: 'Remote media references are recorded as text placeholders.' }]
        : [];
      return {
        revision: revisionForBytes(rawBytes),
        title: String(parsed.title || parsed.seatRef || externalId).slice(0, 500),
        formatVersion: sessionSourceDefinition.formatVersion,
        status: losses.length > 0 ? 'partial' : 'preserved',
        losses,
        totalBytes: rawBytes.byteLength,
        sourceHome: canonicalHome,
      };
    },

    async parse({ home, externalId, revision, cursor }, context) {
      context?.signal?.throwIfAborted();
      const { rawBytes, parsed } = await readSnapshot(home, externalId);
      if (revisionForBytes(rawBytes) !== revision) {
        throw new Error('The Vibe42 seat snapshot changed since preview; preview it again.');
      }
      const rows = Array.isArray(parsed.rows) ? parsed.rows : (Array.isArray(parsed.messages) ? parsed.messages : []);
      const allRecords = [];
      let mediaDrops = 0;

      rows.forEach((row, index) => {
        if (row?.media) mediaDrops += 1;
        const role = normalizeRole(row?.kind || row?.role);
        const text = row?.text ?? row?.content ?? JSON.stringify(row);
        allRecords.push(
          ...splitIntoRecords(
            `${externalId}:${row?.id || index}`,
            role,
            text,
            row?.timestamp,
            { toolName: row?.toolName, toolCallId: row?.toolCallId },
          ),
        );
      });

      const start = Number(cursor ?? 0);
      const page = allRecords.slice(start, start + 32);
      const losses = start === 0 && mediaDrops > 0
        ? [{ code: 'remote_media_omitted', count: mediaDrops, detail: 'Remote media references are recorded as text placeholders.' }]
        : [];

      return {
        records: page,
        losses,
        bytesRead: rawBytes.byteLength,
        cursor: start + page.length < allRecords.length ? String(start + page.length) : null,
      };
    },
  };
}
