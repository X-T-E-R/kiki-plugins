import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INDEX_SCHEMA_VERSION = 1;
export const RETENTION_HOURS = 30 * 24;
export const MAX_SAMPLES_PER_SIGNATURE = 5;
export const MAX_SIGNATURES = 350;
export const MAX_STREAK_EPISODES = 120;
export const MAX_PENDING_CALLS_SAVED = 16;
export const SOFT_MAX_INDEX_BYTES = 1800 * 1024;

export function createEmptyIndex() {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    updatedAt: null,
    lastScan: null,
    files: {},
    buckets: {},
    signatures: {},
    streakEpisodes: [],
  };
}

export function normalizeLoadedIndex(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return createEmptyIndex();
  }
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
    lastScan: raw.lastScan && typeof raw.lastScan === 'object' ? raw.lastScan : null,
    files: raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : {},
    buckets: raw.buckets && typeof raw.buckets === 'object' && !Array.isArray(raw.buckets) ? raw.buckets : {},
    signatures:
      raw.signatures && typeof raw.signatures === 'object' && !Array.isArray(raw.signatures) ? raw.signatures : {},
    streakEpisodes: Array.isArray(raw.streakEpisodes) ? raw.streakEpisodes : [],
  };
}

export async function readIndexFile(indexPath) {
  try {
    const text = await readFile(indexPath, 'utf8');
    return { exists: true, index: normalizeLoadedIndex(JSON.parse(text)) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, index: createEmptyIndex() };
    }
    return { exists: false, corrupted: true, index: createEmptyIndex() };
  }
}

async function replaceFileWindowsSafe(tmpPath, targetPath) {
  try {
    await rename(tmpPath, targetPath);
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') {
      throw error;
    }
  }
  const backupPath = `${targetPath}.bak`;
  await rm(backupPath, { force: true }).catch(() => {});
  let movedExisting = false;
  try {
    await rename(targetPath, backupPath);
    movedExisting = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(tmpPath, targetPath);
    if (movedExisting) await rm(backupPath, { force: true }).catch(() => {});
  } catch (error) {
    if (movedExisting) await rename(backupPath, targetPath).catch(() => {});
    throw error;
  }
}

export async function writeIndexAtomic(indexPath, index, nowMs = Date.now()) {
  pruneIndex(index, nowMs);
  let serialized = JSON.stringify(index);
  if (Buffer.byteLength(serialized, 'utf8') > SOFT_MAX_INDEX_BYTES) {
    trimIndexUnderByteCap(index);
    serialized = JSON.stringify(index);
  }
  await mkdir(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, serialized, 'utf8');
    await replaceFileWindowsSafe(tmpPath, indexPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function getOrCreateBucket(index, hourEpoch) {
  const key = String(hourEpoch);
  let bucket = index.buckets[key];
  if (!bucket) {
    bucket = {
      calls: 0,
      errors: 0,
      lifecycleErrors: 0,
      streaks: 0,
      tools: {},
      lifecycle: {},
      sigs: {},
    };
    index.buckets[key] = bucket;
  }
  return bucket;
}

function ensureToolTuple(bucket, tool) {
  let tuple = bucket.tools[tool];
  if (!Array.isArray(tuple)) {
    tuple = [0, 0, 0];
    bucket.tools[tool] = tuple;
  }
  return tuple;
}

function ensureSigTuple(bucket, sigId) {
  let tuple = bucket.sigs[sigId];
  if (!Array.isArray(tuple)) {
    tuple = [0, 0];
    bucket.sigs[sigId] = tuple;
  }
  return tuple;
}

function hourOf(timestampMs, nowMs) {
  const boundedTs = Math.min(timestampMs, nowMs + 3600_000);
  return Math.floor(boundedTs / 3600_000);
}

export function recordToolCallInIndex(index, { tool, timestamp }, nowMs) {
  const minHour = Math.floor(nowMs / 3600_000) - RETENTION_HOURS;
  const h = hourOf(timestamp, nowMs);
  if (h < minHour) return;
  const bucket = getOrCreateBucket(index, h);
  bucket.calls += 1;
  const tuple = ensureToolTuple(bucket, tool);
  tuple[0] += 1;
}

export function recordErrorSignatureInIndex(
  index,
  { sig, sample, timestamp, isLifecycle = false, countUncountedToolCall = false },
  nowMs,
) {
  const minHour = Math.floor(nowMs / 3600_000) - RETENTION_HOURS;
  const h = hourOf(timestamp, nowMs);
  if (h < minHour) return false;

  const bucket = getOrCreateBucket(index, h);
  if (isLifecycle) {
    bucket.lifecycleErrors += 1;
    bucket.lifecycle[sig.tool] = (bucket.lifecycle[sig.tool] || 0) + 1;
  } else {
    if (countUncountedToolCall) {
      bucket.calls += 1;
      ensureToolTuple(bucket, sig.tool)[0] += 1;
    }
    bucket.errors += 1;
    ensureToolTuple(bucket, sig.tool)[1] += 1;
  }

  const sigTuple = ensureSigTuple(bucket, sig.id);
  sigTuple[0] += 1;

  let entry = index.signatures[sig.id];
  if (!entry) {
    entry = {
      id: sig.id,
      kind: sig.kind,
      tool: sig.tool,
      signature: sig.signature,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      maxStreakLength: 1,
      samples: [],
    };
    index.signatures[sig.id] = entry;
  } else {
    if (timestamp < entry.firstSeenAt) entry.firstSeenAt = timestamp;
    if (timestamp > entry.lastSeenAt) entry.lastSeenAt = timestamp;
  }

  if (sample) {
    entry.samples.push(sample);
    if (entry.samples.length > MAX_SAMPLES_PER_SIGNATURE) {
      entry.samples.splice(0, entry.samples.length - MAX_SAMPLES_PER_SIGNATURE);
    }
  }
  return true;
}

export function recordStreakTransitionInIndex(index, streakInfo, nowMs) {
  const minHour = Math.floor(nowMs / 3600_000) - RETENTION_HOURS;
  const h = hourOf(streakInfo.updatedAt, nowMs);
  if (h < minHour) return;

  const sigEntry = index.signatures[streakInfo.signatureId];
  if (sigEntry && streakInfo.count > (sigEntry.maxStreakLength || 1)) {
    sigEntry.maxStreakLength = streakInfo.count;
  }

  if (streakInfo.count === 2) {
    const bucket = getOrCreateBucket(index, h);
    bucket.streaks += 1;
    ensureToolTuple(bucket, streakInfo.tool)[2] += 1;
    ensureSigTuple(bucket, streakInfo.signatureId)[1] += 1;

    index.streakEpisodes.push({
      id: streakInfo.streakId,
      tool: streakInfo.tool,
      length: 2,
      signatureId: streakInfo.signatureId,
      signature: streakInfo.signature,
      workspace: streakInfo.workspace,
      sessionId: streakInfo.sessionId,
      agentId: streakInfo.agentId,
      startedAt: streakInfo.startedAt,
      timestamp: streakInfo.updatedAt,
      errorPreview: streakInfo.errorPreview,
    });
    if (index.streakEpisodes.length > MAX_STREAK_EPISODES * 2) {
      index.streakEpisodes.splice(0, index.streakEpisodes.length - MAX_STREAK_EPISODES);
    }
  } else if (streakInfo.count > 2) {
    for (let i = index.streakEpisodes.length - 1; i >= 0; i -= 1) {
      if (index.streakEpisodes[i].id === streakInfo.streakId) {
        const ep = index.streakEpisodes[i];
        ep.length = streakInfo.count;
        ep.signatureId = streakInfo.signatureId;
        ep.signature = streakInfo.signature;
        ep.timestamp = streakInfo.updatedAt;
        ep.errorPreview = streakInfo.errorPreview;
        return;
      }
    }
    // Fallback if episode rotated out: re-insert updated episode.
    index.streakEpisodes.push({
      id: streakInfo.streakId,
      tool: streakInfo.tool,
      length: streakInfo.count,
      signatureId: streakInfo.signatureId,
      signature: streakInfo.signature,
      workspace: streakInfo.workspace,
      sessionId: streakInfo.sessionId,
      agentId: streakInfo.agentId,
      startedAt: streakInfo.startedAt,
      timestamp: streakInfo.updatedAt,
      errorPreview: streakInfo.errorPreview,
    });
  }
}

export function pruneIndex(index, nowMs = Date.now()) {
  const minHour = Math.floor(nowMs / 3600_000) - RETENTION_HOURS;
  const minTs = minHour * 3600_000;
  const referencedSigCounts = new Map();

  for (const [hourKey, bucket] of Object.entries(index.buckets)) {
    const h = Number(hourKey);
    if (!Number.isFinite(h) || h < minHour || !bucket || typeof bucket !== 'object') {
      delete index.buckets[hourKey];
      continue;
    }
    for (const [sigId, tuple] of Object.entries(bucket.sigs || {})) {
      const count = Array.isArray(tuple) ? tuple[0] || 0 : 0;
      if (count > 0) {
        referencedSigCounts.set(sigId, (referencedSigCounts.get(sigId) || 0) + count);
      }
    }
  }

  for (const sigId of Object.keys(index.signatures)) {
    if (!referencedSigCounts.has(sigId)) {
      delete index.signatures[sigId];
      continue;
    }
    const sig = index.signatures[sigId];
    if (Array.isArray(sig.samples) && sig.samples.length > MAX_SAMPLES_PER_SIGNATURE) {
      sig.samples = sig.samples.slice(-MAX_SAMPLES_PER_SIGNATURE);
    }
  }

  const sigKeys = Object.keys(index.signatures);
  if (sigKeys.length > MAX_SIGNATURES) {
    sigKeys.sort((a, b) => {
      const ca = referencedSigCounts.get(a) || 0;
      const cb = referencedSigCounts.get(b) || 0;
      if (cb !== ca) return cb - ca;
      return (index.signatures[b]?.lastSeenAt || 0) - (index.signatures[a]?.lastSeenAt || 0);
    });
    for (const dropId of sigKeys.slice(MAX_SIGNATURES)) {
      delete index.signatures[dropId];
    }
  }

  if (Array.isArray(index.streakEpisodes)) {
    index.streakEpisodes = index.streakEpisodes
      .filter((ep) => ep && typeof ep.timestamp === 'number' && ep.timestamp >= minTs)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_STREAK_EPISODES);
  }
}

function trimIndexUnderByteCap(index) {
  const sigEntries = Object.values(index.signatures).sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
  const dropCount = Math.ceil(sigEntries.length * 0.35);
  for (let i = 0; i < dropCount; i += 1) {
    delete index.signatures[sigEntries[i].id];
  }
  index.streakEpisodes = (index.streakEpisodes || []).slice(0, 50);
  for (const fileMeta of Object.values(index.files)) {
    if (fileMeta?.tailState?.pendingCalls?.length > 4) {
      fileMeta.tailState.pendingCalls = fileMeta.tailState.pendingCalls.slice(-4);
    }
  }
}

function matchesToolFilter(toolName, toolFilter) {
  if (!toolFilter) return true;
  const needle = toolFilter.trim().toLowerCase();
  if (!needle) return true;
  const actual = String(toolName || '').toLowerCase();
  return actual === needle || actual.startsWith(`${needle}:`);
}

function aggregateWindow(index, { windowHours = 168, toolFilter = '' }, nowMs = Date.now()) {
  const clampedHours = Math.max(1, Math.min(720, Math.trunc(Number(windowHours) || 168)));
  const minHour = Math.floor((nowMs - clampedHours * 3600_000) / 3600_000);
  const minTs = nowMs - clampedHours * 3600_000;

  let totalCalls = 0;
  let totalErrors = 0;
  let totalLifecycleErrors = 0;
  let totalStreaks = 0;

  const toolMap = new Map();
  const lifecycleMap = new Map();
  const sigMap = new Map();

  for (const [hourKey, bucket] of Object.entries(index.buckets)) {
    const h = Number(hourKey);
    if (!Number.isFinite(h) || h < minHour || !bucket) continue;

    for (const [tool, tuple] of Object.entries(bucket.tools || {})) {
      if (!matchesToolFilter(tool, toolFilter)) continue;
      const calls = tuple[0] || 0;
      const errors = tuple[1] || 0;
      const streaks = tuple[2] || 0;
      totalCalls += calls;
      totalErrors += errors;
      totalStreaks += streaks;
      const prev = toolMap.get(tool) || { tool, calls: 0, errors: 0, streaks: 0 };
      prev.calls += calls;
      prev.errors += errors;
      prev.streaks += streaks;
      toolMap.set(tool, prev);
    }

    for (const [lfType, count] of Object.entries(bucket.lifecycle || {})) {
      if (!matchesToolFilter(lfType, toolFilter)) continue;
      const c = count || 0;
      totalLifecycleErrors += c;
      lifecycleMap.set(lfType, (lifecycleMap.get(lfType) || 0) + c);
    }

    for (const [sigId, tuple] of Object.entries(bucket.sigs || {})) {
      const meta = index.signatures[sigId];
      if (!meta) continue;
      if (!matchesToolFilter(meta.tool, toolFilter)) continue;
      const count = tuple[0] || 0;
      const streaks = tuple[1] || 0;
      if (count <= 0) continue;
      const prev = sigMap.get(sigId) || { id: sigId, count: 0, streaks: 0, meta };
      prev.count += count;
      prev.streaks += streaks;
      sigMap.set(sigId, prev);
    }
  }

  const tools = [...toolMap.values()]
    .map((item) => ({
      tool: item.tool,
      calls: item.calls,
      errors: item.errors,
      errorRate: item.calls > 0 ? Number((item.errors / item.calls).toFixed(4)) : 0,
      streaks: item.streaks,
    }))
    .sort((a, b) => {
      if (b.errors !== a.errors) return b.errors - a.errors;
      if (b.errorRate !== a.errorRate) return b.errorRate - a.errorRate;
      return b.calls - a.calls;
    });

  const lifecycleByType = [...lifecycleMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const signatures = [...sigMap.values()]
    .map(({ id, count, streaks, meta }) => ({
      signatureId: id,
      kind: meta.kind,
      tool: meta.tool,
      signature: meta.signature,
      count,
      streaks,
      maxStreakLength: meta.maxStreakLength || (streaks > 0 ? 2 : 1),
      firstSeenAt: meta.firstSeenAt,
      lastSeenAt: meta.lastSeenAt,
      sampleCount: Array.isArray(meta.samples) ? meta.samples.length : 0,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.streaks !== a.streaks) return b.streaks - a.streaks;
      return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    });

  const streakEpisodes = (index.streakEpisodes || [])
    .filter((ep) => ep && ep.timestamp >= minTs && matchesToolFilter(ep.tool, toolFilter))
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return b.timestamp - a.timestamp;
    });

  return {
    windowHours: clampedHours,
    totals: {
      calls: totalCalls,
      errors: totalErrors,
      errorRate: totalCalls > 0 ? Number((totalErrors / totalCalls).toFixed(4)) : 0,
      streaks: totalStreaks,
      lifecycleErrors: totalLifecycleErrors,
      trackedFiles: Object.keys(index.files).length,
    },
    tools,
    lifecycleByType,
    signatures,
    streakEpisodes,
  };
}

export function queryIndexReport(
  index,
  { action = 'summary', windowHours = 168, toolFilter = '', signatureId = '', limit = 15, indexed = true } = {},
  nowMs = Date.now(),
) {
  const cap = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 15)));
  const agg = aggregateWindow(index, { windowHours, toolFilter }, nowMs);

  if (action === 'top_signatures') {
    return {
      ok: true,
      action,
      indexed,
      windowHours: agg.windowHours,
      toolFilter: toolFilter || null,
      lastScan: index.lastScan,
      totals: agg.totals,
      signatures: agg.signatures.slice(0, cap),
    };
  }

  if (action === 'streaks') {
    const hotspotSignatures = agg.signatures.filter((s) => s.streaks > 0).slice(0, cap);
    return {
      ok: true,
      action,
      indexed,
      windowHours: agg.windowHours,
      toolFilter: toolFilter || null,
      lastScan: index.lastScan,
      totalStreaks: agg.totals.streaks,
      hotspots: hotspotSignatures,
      episodes: agg.streakEpisodes.slice(0, cap),
    };
  }

  if (action === 'samples') {
    if (signatureId) {
      const meta = index.signatures[signatureId];
      if (!meta) {
        return {
          ok: true,
          action,
          indexed,
          signatureId,
          found: false,
          samples: [],
          lastScan: index.lastScan,
        };
      }
      const winStat = agg.signatures.find((s) => s.signatureId === signatureId);
      return {
        ok: true,
        action,
        indexed,
        signatureId,
        found: true,
        kind: meta.kind,
        tool: meta.tool,
        signature: meta.signature,
        windowCount: winStat?.count ?? 0,
        streaks: winStat?.streaks ?? 0,
        maxStreakLength: meta.maxStreakLength || 1,
        samples: [...(meta.samples || [])].reverse(),
        lastScan: index.lastScan,
      };
    }

    const groups = agg.signatures.slice(0, cap).map((sig) => {
      const meta = index.signatures[sig.signatureId];
      return {
        signatureId: sig.signatureId,
        kind: sig.kind,
        tool: sig.tool,
        signature: sig.signature,
        count: sig.count,
        streaks: sig.streaks,
        samples: [...(meta?.samples || [])].reverse(),
      };
    });
    return {
      ok: true,
      action,
      indexed,
      windowHours: agg.windowHours,
      toolFilter: toolFilter || null,
      lastScan: index.lastScan,
      groups,
    };
  }

  // Default: summary (and scan_now base view)
  return {
    ok: true,
    action,
    indexed,
    windowHours: agg.windowHours,
    toolFilter: toolFilter || null,
    lastScan: index.lastScan,
    totals: agg.totals,
    highErrorTools: agg.tools.filter((t) => t.errors > 0 || agg.tools.length <= 8).slice(0, cap),
    lifecycleFailures: agg.lifecycleByType.slice(0, cap),
    topSignatures: agg.signatures.slice(0, cap),
    topStreaks: agg.streakEpisodes.slice(0, Math.min(cap, 10)),
  };
}
