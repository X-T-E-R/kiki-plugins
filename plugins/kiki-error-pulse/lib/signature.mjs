import { createHash } from 'node:crypto';
import path from 'node:path';

const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
const TOOL_APPENDIX_RE = /<tool-result-appendix>[\s\S]*$/i;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const SYSTEM_ERROR_WRAPPER_RE = /<system>\s*ERROR:\s*(?:Tool execution failed\.?|[^<\r\n]*)\s*<\/system>/gi;

// Secret redaction patterns — always executed before structural normalization.
const SECRET_PATTERNS = [
  /\bBearer\s+[^\s"'`,;)\]}<>]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bgithub_pat_[^\s"'`,;)\]}<>]+/g,
  /\bmdp_[^\s"'`,;)\]}<>]+/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
];
const URL_BASIC_AUTH_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'<>]+:[^\s@"'<>]+@/gi;

const PLACEHOLDER_MAP = {
  '\u0001RED\u0002': '<REDACTED>',
  '\u0001UUID\u0002': '<UUID>',
  '\u0001PATH\u0002': '<PATH>',
  '\u0001HEX\u0002': '<HEX>',
  '\u0001NUM\u0002': '<NUM>',
};
const PLACEHOLDER_RESTORE_RE = /\u0001(?:RED|UUID|PATH|HEX|NUM)\u0002/g;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const WIN_DRIVE_PATH_RE = /[A-Za-z]:[\\/](?:[^\s"'`<>|*?:,;)\]}]+)+/g;
const WIN_UNC_PATH_RE = /\\\\[A-Za-z0-9_.-]+\\[^\s"'`<>|*?:,;)\]}]+/g;
const TILDE_PATH_RE = /~\/[^\s"'`<>|*?:,;)\]}]+/g;
const UNIX_ROOT_PATH_RE = /(?<![A-Za-z0-9_:/])\/(?:tmp|etc|var|opt|usr|home|root|Users|Volumes|private|proc|sys|dev|run|mnt|workspace|app)(?:\/[A-Za-z0-9._@+-]+)+/g;
const POSIX_MULTI_PATH_RE = /(?<![A-Za-z0-9_:/])\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+){1,}/g;
const REL_DOT_PATH_RE = /(?<![A-Za-z0-9_])\.\.?\/[A-Za-z0-9._@/-]+/g;
const REL_EXT_PATH_RE = /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
const REL_BACKSLASH_PATH_RE = /\b[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)+\b/g;
const HEX_PREFIX_RE = /\b0x[0-9a-fA-F]{4,}\b/g;
const HEX_HASH_RE = /\b(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{10,}\b/g;
const LONG_NUM_RE = /\b\d{5,}\b/g;

const TIER1_DIAGNOSTIC_RE =
  /\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError|URIError|EvalError|[A-Z][A-Za-z0-9_]*(?:Error|Exception|Fault)|FATAL|PANIC|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|ERR_[A-Z0-9_]+|command not found|not recognized as an internal or external command|No such file or directory|Permission denied|Access is denied|timed out)\b/i;

const TIER2_DIAGNOSTIC_RE =
  /\b(?:Error|Exception|Invalid|denied|not found|timed out|timeout|failed|failure|cannot|unable to|refused|aborted|rejected|unexpected|conflict|missing)\b/i;

const PURE_EXIT_FOOTER_RE =
  /^(?:(?:command|process|shell)\s+(?:failed|exited|completed|terminated)\s+with\s+)?(?:exit(?:\s+code)?|status(?:\s+code)?|return\s+code)\s*[:=]?\s*-?\d+\.?$/i;

const EXIT_CODE_EXTRACTORS = [
  /\[exit\s*=\s*(-?\d+)\]/i,
  /\bexit\s+code\s*[:=]?\s*(-?\d+)\b/i,
  /\bexited\s+with\s+(?:code|status)\s*[:=]?\s*(-?\d+)\b/i,
  /\breturned\s+non-zero\s+exit\s+status\s+(-?\d+)\b/i,
  /\(exit\s+(-?\d+)\)\s*$/i,
];

const FAST_SUCCESS_RESULT_CALL_ID_RE = /"toolCallId"\s*:\s*"([^"\\]+)"/;

/**
 * Fast pre-filter that skips ~85-90% of text delta / token measurement lines without JSON.parse.
 */
export function shouldInspectLine(line) {
  if (typeof line !== 'string' || line.length < 10) return false;
  return (
    line.includes('"tool.') ||
    line.includes('Error') ||
    line.includes('.failed') ||
    line.includes('error') ||
    (line.includes('"turn.ended"') && line.includes('"failed"')) ||
    (line.includes('"task.terminated"') && (line.includes('"failed"') || line.includes('"timed_out"')))
  );
}

export function redactSecrets(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let out = input.replace(URL_BASIC_AUTH_RE, '$1<REDACTED>@');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '<REDACTED>');
  }
  return out;
}

export function stripErrorWrappers(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return raw
    .replace(TOOL_APPENDIX_RE, '')
    .replace(SYSTEM_REMINDER_RE, '')
    .replace(SYSTEM_ERROR_WRAPPER_RE, '')
    .replace(ANSI_ESCAPE_RE, '')
    .trim();
}

function truncateClean(value, maxChars) {
  const clean = redactSecrets(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function formatArgsPreview(args, maxChars = 160) {
  if (args == null) return '';
  let raw = '';
  if (typeof args === 'string') {
    raw = args;
  } else if (typeof args === 'object') {
    try {
      raw = JSON.stringify(args);
    } catch {
      raw = String(args);
    }
  } else {
    raw = String(args);
  }
  return truncateClean(raw, maxChars);
}

export function formatErrorPreview(rawError, maxChars = 240) {
  const stripped = stripErrorWrappers(String(rawError ?? ''));
  return truncateClean(stripped || String(rawError ?? ''), maxChars);
}

export function formatWorkspaceLabel(rawWorkspace) {
  if (typeof rawWorkspace !== 'string' || !rawWorkspace.trim()) return 'default';
  const cleaned = redactSecrets(rawWorkspace.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned) return 'default';
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) return 'default';
  // Keep only the non-sensitive workspace folder tail (omit OS user-home prefixes).
  if (parts.length >= 2 && !/^(?:users|home)$/i.test(parts[parts.length - 2])) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.slice(0, 80);
  }
  return parts[parts.length - 1].slice(0, 80);
}

export function extractBashExitCode(strippedText, explicitExitCode) {
  if (typeof explicitExitCode === 'number' && Number.isFinite(explicitExitCode) && explicitExitCode !== 0) {
    return Math.trunc(explicitExitCode);
  }
  if (typeof strippedText !== 'string' || !strippedText) return null;
  const lines = strippedText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    for (const pattern of EXIT_CODE_EXTRACTORS) {
      const match = pattern.exec(line);
      if (match) {
        const code = Number.parseInt(match[1], 10);
        if (Number.isFinite(code) && code !== 0) return code;
      }
    }
  }
  for (const pattern of EXIT_CODE_EXTRACTORS) {
    const match = pattern.exec(strippedText);
    if (match) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isFinite(code) && code !== 0) return code;
    }
  }
  return null;
}

function extractLaneNames(parsed) {
  const names = [];
  const pushUnique = (val) => {
    if (typeof val === 'string' && val.trim() && !names.includes(val.trim())) {
      names.push(val.trim());
    }
  };

  if (Array.isArray(parsed.lane_results)) {
    const failed = parsed.lane_results.filter((r) => r && (r.error || r.status === 'failed' || r.status === 'error'));
    for (const item of failed.length > 0 ? failed : parsed.lane_results) {
      pushUnique(item?.lane ?? item?.id ?? item?.provider);
    }
  }
  if (Array.isArray(parsed.attempts)) {
    const failed = parsed.attempts.filter((a) => a && (a.error || (a.status && a.status !== 'ok' && a.status !== 'succeeded')));
    for (const item of failed.length > 0 ? failed : parsed.attempts) {
      pushUnique(item?.pipeline ?? item?.lane ?? item?.provider);
    }
  }
  if (names.length === 0 && Array.isArray(parsed.lanes)) {
    for (const item of parsed.lanes) {
      if (typeof item === 'string') pushUnique(item);
      else if (item && typeof item === 'object') pushUnique(item.lane ?? item.id ?? item.name);
    }
  }
  pushUnique(parsed.lane);
  pushUnique(parsed.pipeline);
  if (parsed.route && typeof parsed.route === 'object') {
    pushUnique(parsed.route.pipeline ?? parsed.route.lane);
  }
  return names.slice(0, 4);
}

function extractFirstNbError(parsed) {
  const candidates = [];
  if (parsed.error) candidates.push(parsed.error);
  if (Array.isArray(parsed.errors)) candidates.push(...parsed.errors);
  if (Array.isArray(parsed.lane_results)) {
    for (const r of parsed.lane_results) {
      if (r?.error) candidates.push(r.error);
      else if (r?.status === 'failed' || r?.status === 'error') candidates.push(r);
    }
  }
  if (Array.isArray(parsed.attempts)) {
    for (const a of parsed.attempts) {
      if (a?.error) candidates.push(a.error);
      else if (a?.status && a.status !== 'ok' && a.status !== 'succeeded') candidates.push(a);
    }
  }
  if (Array.isArray(parsed.warnings)) candidates.push(...parsed.warnings);

  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) {
      return { code: '', message: item.trim() };
    }
    if (item && typeof item === 'object') {
      const code =
        (typeof item.code === 'string' && item.code.trim()) ||
        (typeof item.error_code === 'string' && item.error_code.trim()) ||
        (typeof item.kind === 'string' && item.kind.trim()) ||
        '';
      const message =
        (typeof item.message === 'string' && item.message.trim()) ||
        (typeof item.detail === 'string' && item.detail.trim()) ||
        (typeof item.reason === 'string' && item.reason.trim()) ||
        '';
      if (code || message) return { code, message };
    }
  }
  return { code: '', message: '' };
}

function extractNbSearchRegexFallback(strippedText, tool) {
  const head = strippedText.slice(0, 16384);
  const isNbSearch =
    tool === 'WebSearch' ||
    tool === 'FetchURL' ||
    head.includes('"schema_version"') ||
    head.includes('nb-search');
  if (!isNbSearch) return null;

  const statusMatch = /"status"\s*:\s*"([^"\\]+)"/.exec(head);
  const lanesArrMatch = /"lanes"\s*:\s*\[([^\]]{1,240})\]/.exec(head);
  const singleLaneMatch = /"(?:lane|pipeline)"\s*:\s*"([^"\\]+)"/.exec(head);
  const codeMatch =
    /"error"\s*:\s*\{\s*"code"\s*:\s*"([^"\\]+)"/.exec(head) ||
    /"error_code"\s*:\s*"([^"\\]+)"/.exec(head) ||
    /"errors"\s*:\s*\[\s*\{[^}]*?"code"\s*:\s*"([^"\\]+)"/.exec(head) ||
    /"code"\s*:\s*"([^"\\]+)"/.exec(head);

  const parts = ['nb-search'];
  if (statusMatch) parts.push(`status=${statusMatch[1]}`);
  if (lanesArrMatch) {
    const lanes = [...lanesArrMatch[1].matchAll(/"([A-Za-z0-9._-]+)"/g)].map((m) => m[1]).slice(0, 4);
    if (lanes.length > 0) parts.push(`lanes=${lanes.join(',')}`);
  } else if (singleLaneMatch) {
    parts.push(`lanes=${singleLaneMatch[1]}`);
  }
  if (codeMatch) parts.push(`code=${codeMatch[1]}`);

  return parts.length > 1 ? parts.join(' ') : null;
}

function tryExtractStructuredErrorLine(strippedText, tool = '') {
  if (!strippedText.startsWith('{')) return null;

  const maxParseLen =
    tool === 'WebSearch' || tool === 'FetchURL' || strippedText.slice(0, 400).includes('"schema_version"')
      ? 262_144
      : 32_768;

  if (strippedText.length <= maxParseLen) {
    try {
      const parsed = JSON.parse(strippedText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const isNbSearch =
          tool === 'WebSearch' ||
          tool === 'FetchURL' ||
          typeof parsed.schema_version === 'string' ||
          Array.isArray(parsed.lanes) ||
          Array.isArray(parsed.lane_results) ||
          Array.isArray(parsed.attempts);

        if (isNbSearch) {
          const status = typeof parsed.status === 'string' && parsed.status.trim() ? parsed.status.trim() : '';
          const lanes = extractLaneNames(parsed);
          const firstErr = extractFirstNbError(parsed);
          const parts = ['nb-search'];
          if (status) parts.push(`status=${status}`);
          if (lanes.length > 0) parts.push(`lanes=${lanes.join(',')}`);
          if (firstErr.code) parts.push(`code=${firstErr.code}`);
          else if (firstErr.message) parts.push(firstErr.message.split(/\r?\n/)[0].slice(0, 100));
          if (parts.length > 1) return parts.join(' ');
        }

        const errObj = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
        const code = typeof errObj.code === 'string' ? errObj.code.trim() : '';
        const msg =
          typeof errObj.message === 'string'
            ? errObj.message.trim()
            : typeof parsed.error === 'string'
              ? parsed.error.trim()
              : typeof parsed.detail === 'string'
                ? parsed.detail.trim()
                : typeof parsed.reason === 'string'
                  ? parsed.reason.trim()
                  : '';
        if (code && msg) return `[${code}] ${msg}`;
        if (msg) return msg;
        if (code) return `[${code}]`;
        if (typeof parsed.status === 'string' && parsed.status.trim()) {
          return `status=${parsed.status.trim()}`;
        }
      }
    } catch {
      return extractNbSearchRegexFallback(strippedText, tool);
    }
  }

  return extractNbSearchRegexFallback(strippedText, tool);
}

export function selectCoreErrorLine(strippedText, tool = '') {
  if (!strippedText) return 'Unknown error';
  const structured = tryExtractStructuredErrorLine(strippedText, tool);
  if (structured) return structured.split(/\r?\n/)[0].trim();

  const rawLines = strippedText.split(/\r?\n/);
  const candidates = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].trim();
    if (!line) continue;
    if (/^[{}\[\],:;]+$/.test(line)) continue;
    if (PURE_EXIT_FOOTER_RE.test(line)) continue;
    if (/^[-=_*]{3,}$/.test(line)) continue;
    candidates.push(line);
  }
  if (candidates.length === 0) {
    const fallback = rawLines.find((line) => line.trim())?.trim();
    return fallback || 'Unknown error';
  }

  let bestLine = candidates[0];
  let bestScore = -1;

  for (let i = 0; i < candidates.length; i += 1) {
    const line = candidates[i];
    const isStackFrame = /^at\s+\S+/.test(line) || /^File\s+"[^"]+",\s+line\s+\d+/i.test(line);
    const isTracebackHeader = /^Traceback \(most recent call last\):$/i.test(line);
    const isNpmBoilerplate = /^npm\s+(?:ERR!|error)\s+(?:A complete log|code\s+\S+$)/i.test(line);
    const isShellPromptEcho = /^(?:\$|>|#)\s+\S+/.test(line);

    let score = 15;
    if (isTracebackHeader) score = 20;
    else if (isStackFrame || isNpmBoilerplate || isShellPromptEcho) score = 5;
    else if (TIER1_DIAGNOSTIC_RE.test(line)) score = 100;
    else if (TIER2_DIAGNOSTIC_RE.test(line)) score = 65;

    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
      if (score === 100) break;
    }
  }

  return bestLine;
}

export function normalizeSignatureText(input) {
  if (typeof input !== 'string' || !input.trim()) return 'Unknown error';

  // 1. Redact credentials into protected sentinel first so later rules never split or leak tokens.
  let out = input.replace(URL_BASIC_AUTH_RE, '$1\u0001RED\u0002@');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '\u0001RED\u0002');
  }
  out = out.replaceAll('<REDACTED>', '\u0001RED\u0002');

  // 2. Normalize UUIDs and ISO timestamps.
  out = out.replace(UUID_RE, '\u0001UUID\u0002');
  out = out.replace(ISO_TS_RE, '\u0001NUM\u0002');

  // 3. Normalize Windows & POSIX paths (including trailing :line[:col] locations).
  out = out
    .replace(WIN_UNC_PATH_RE, '\u0001PATH\u0002')
    .replace(WIN_DRIVE_PATH_RE, '\u0001PATH\u0002')
    .replace(TILDE_PATH_RE, '\u0001PATH\u0002')
    .replace(UNIX_ROOT_PATH_RE, '\u0001PATH\u0002')
    .replace(POSIX_MULTI_PATH_RE, '\u0001PATH\u0002')
    .replace(REL_DOT_PATH_RE, '\u0001PATH\u0002')
    .replace(REL_EXT_PATH_RE, '\u0001PATH\u0002')
    .replace(REL_BACKSLASH_PATH_RE, '\u0001PATH\u0002')
    .replace(/\u0001PATH\u0002(?::\d+){1,2}/g, '\u0001PATH\u0002');

  // 4. Normalize memory addresses / hex hashes and 5+ digit numbers / timestamps.
  out = out
    .replace(HEX_PREFIX_RE, '\u0001HEX\u0002')
    .replace(HEX_HASH_RE, '\u0001HEX\u0002')
    .replace(LONG_NUM_RE, '\u0001NUM\u0002');

  // 5. Restore readable placeholders and compact whitespace.
  out = out
    .replace(PLACEHOLDER_RESTORE_RE, (token) => PLACEHOLDER_MAP[token] || token)
    .replace(/\s+/g, ' ')
    .trim();

  return out.length > 220 ? `${out.slice(0, 219)}…` : out || 'Unknown error';
}

export function buildErrorSignature({ kind = 'tool', tool = 'unknown', rawError = '', exitCode = null }) {
  const stripped = stripErrorWrappers(String(rawError ?? ''));
  const coreLine = selectCoreErrorLine(stripped, tool);
  let normalizedCore = normalizeSignatureText(coreLine);

  if (tool === 'Bash') {
    const resolvedExit = extractBashExitCode(stripped, exitCode);
    if (resolvedExit !== null) {
      normalizedCore = normalizedCore.replace(/^\[exit=-?\d+\]\s*/i, '');
      normalizedCore = `[exit=${resolvedExit}] ${normalizedCore}`;
    }
  }

  const key = `${kind}|${tool}|${normalizedCore}`;
  const id = `sig_${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
  return {
    id,
    kind,
    tool,
    signature: normalizedCore,
  };
}

export function resolveToolDisplayName(rawName, rawArgs) {
  const base = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'unknown';
  if (base !== 'CallTool') return base;
  let inner = '';
  if (rawArgs && typeof rawArgs === 'object' && typeof rawArgs.name === 'string') {
    inner = rawArgs.name.trim();
  } else if (typeof rawArgs === 'string' && rawArgs.includes('"name"')) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (typeof parsed?.name === 'string') inner = parsed.name.trim();
    } catch {
      const m = /"name"\s*:\s*"([^"\\]+)"/.exec(rawArgs);
      if (m) inner = m[1].trim();
    }
  }
  return inner ? `CallTool:${inner}` : 'CallTool';
}

function normalizeTimestampMs(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackMs;
}

function stringifyToolOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (output && typeof output === 'object') {
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return '';
}

/**
 * Parse one pre-filtered wire.jsonl line into zero or more normalized pulse records.
 * Mutates `fileState.pendingCalls` to pair tool.call -> tool.result across lines and scans.
 */
export function extractLineObservations(line, fileState, fallbackTsMs) {
  if (!shouldInspectLine(line)) return null;

  // Ultra-fast path: large successful tool.result payloads (e.g. 200 KB Read output) need no JSON.parse!
  if (
    line.length > 4096 &&
    line.includes('"tool.result"') &&
    !line.includes('"isError":true') &&
    !line.includes('"isError": true') &&
    !line.includes('<system>ERROR:') &&
    !line.includes('"status":"error"') &&
    !line.includes('"status":"failed"')
  ) {
    const m = FAST_SUCCESS_RESULT_CALL_ID_RE.exec(line);
    if (m) {
      const pending = fileState.pendingCalls.get(m[1]);
      if (pending) {
        fileState.pendingCalls.delete(m[1]);
        return [
          {
            type: 'tool_outcome',
            tool: pending.tool,
            countedCall: true,
            isError: false,
            timestamp: pending.timestamp || fallbackTsMs,
          },
        ];
      }
    }
  }

  let root;
  try {
    root = JSON.parse(line);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;

  const ev =
    root.type === 'context.append_loop_event' && root.event && typeof root.event === 'object'
      ? root.event
      : root;
  const evType = typeof ev.type === 'string' ? ev.type : typeof root.type === 'string' ? root.type : '';
  if (!evType) return null;

  const timestamp = normalizeTimestampMs(
    ev.time ?? ev.timestamp ?? root.time ?? root.timestamp ?? root.createdAt,
    fallbackTsMs,
  );
  const lineMeta = {
    workspace: typeof root.workspace === 'string' ? root.workspace : undefined,
    sessionId: typeof root.sessionId === 'string' ? root.sessionId : undefined,
    agentId: typeof root.agentId === 'string' ? root.agentId : undefined,
  };

  // 1. Tool call
  if (evType === 'tool.call' || evType === 'tool_call') {
    const rawArgs = ev.args ?? ev.arguments ?? ev.input;
    const tool = resolveToolDisplayName(ev.name ?? ev.tool ?? ev.toolName, rawArgs);
    const callId = ev.toolCallId ?? ev.id ?? ev.callId;
    if (typeof callId === 'string' && callId) {
      if (fileState.pendingCalls.size >= 64) {
        const oldestKey = fileState.pendingCalls.keys().next().value;
        if (oldestKey !== undefined) fileState.pendingCalls.delete(oldestKey);
      }
      fileState.pendingCalls.set(callId, {
        tool,
        argsPreview: formatArgsPreview(rawArgs, 160),
        timestamp,
      });
    }
    return [{ type: 'tool_call', tool, timestamp, ...lineMeta }];
  }

  // 2. Tool result or explicit tool failure
  if (evType === 'tool.result' || evType === 'tool_Result' || evType === 'tool.failed' || evType === 'tool.error') {
    const callId = ev.toolCallId ?? ev.id ?? ev.callId;
    const pending = typeof callId === 'string' && callId ? fileState.pendingCalls.get(callId) : undefined;
    if (pending) fileState.pendingCalls.delete(callId);

    const res = ev.result && typeof ev.result === 'object' ? ev.result : ev;
    const rawArgs = ev.args ?? ev.arguments ?? res.args;
    const tool = pending?.tool || resolveToolDisplayName(ev.name ?? ev.tool ?? res.tool, rawArgs);
    const outputText = stringifyToolOutput(res.output ?? res.content);
    const explicitErrorText =
      typeof res.error === 'string'
        ? res.error
        : typeof res.error?.message === 'string'
          ? res.error.message
          : typeof ev.error === 'string'
            ? ev.error
            : typeof ev.error?.message === 'string'
              ? ev.error.message
              : '';
    const exitCode =
      typeof res.exitCode === 'number'
        ? res.exitCode
        : typeof ev.exitCode === 'number'
          ? ev.exitCode
          : null;

    const isError =
      evType === 'tool.failed' ||
      evType === 'tool.error' ||
      res.isError === true ||
      ev.isError === true ||
      res.status === 'error' ||
      res.status === 'failed' ||
      (typeof exitCode === 'number' && exitCode !== 0) ||
      outputText.includes('<system>ERROR:') ||
      Boolean(explicitErrorText && evType !== 'tool.result') ||
      Boolean(explicitErrorText && !outputText);

    const rawError = outputText && explicitErrorText && !outputText.includes(explicitErrorText)
      ? `${explicitErrorText}\n${outputText}`
      : outputText || explicitErrorText || 'Tool execution failed';

    return [
      {
        type: 'tool_outcome',
        tool,
        countedCall: Boolean(pending),
        isError,
        exitCode,
        argsPreview: pending?.argsPreview || formatArgsPreview(rawArgs, 160),
        rawError: isError ? rawError : '',
        timestamp,
        ...lineMeta,
      },
    ];
  }

  // 3. Lifecycle anomalies (subagent.failed, turn.failed, provider.error, turn.step.retrying, failed turn/task)
  if (
    evType === 'subagent.failed' ||
    evType === 'turn.failed' ||
    evType === 'provider.error' ||
    evType === 'step.failed' ||
    evType === 'model.error'
  ) {
    const errObj = ev.error && typeof ev.error === 'object' ? ev.error : root.error;
    const code =
      (typeof ev.code === 'string' && ev.code) ||
      (typeof errObj?.code === 'string' && errObj.code) ||
      (typeof ev.errorCode === 'string' && ev.errorCode) ||
      '';
    const msg =
      (typeof ev.message === 'string' && ev.message) ||
      (typeof ev.errorMessage === 'string' && ev.errorMessage) ||
      (typeof errObj?.message === 'string' && errObj.message) ||
      (typeof ev.error === 'string' && ev.error) ||
      (typeof ev.reason === 'string' && ev.reason) ||
      evType;
    const rawError = code && !msg.includes(code) ? `[${code}] ${msg}` : msg;
    const contextArgs = ev.model || ev.modelAlias || ev.provider || ev.profile || ev.subagentId || undefined;
    return [
      {
        type: 'lifecycle_error',
        lifecycleType: evType,
        rawError,
        argsPreview: contextArgs ? formatArgsPreview(contextArgs, 160) : '',
        timestamp,
        ...lineMeta,
      },
    ];
  }

  if (evType === 'turn.step.retrying') {
    const errName = typeof ev.errorName === 'string' ? ev.errorName : '';
    const errMsg = typeof ev.errorMessage === 'string' ? ev.errorMessage : 'Step retry triggered';
    const rawError = errName && !errMsg.includes(errName) ? `${errName}: ${errMsg}` : errMsg;
    return [
      {
        type: 'lifecycle_error',
        lifecycleType: 'provider.error',
        rawError,
        argsPreview: ev.stepId ? formatArgsPreview(`step=${ev.stepId} attempt=${ev.failedAttempt ?? 1}`, 160) : '',
        timestamp,
        ...lineMeta,
      },
    ];
  }

  if (evType === 'turn.ended' && ev.reason === 'failed') {
    const detail =
      (typeof ev.errorMessage === 'string' && ev.errorMessage) ||
      (typeof ev.error?.message === 'string' && ev.error.message) ||
      'Turn ended with reason=failed';
    return [
      {
        type: 'lifecycle_error',
        lifecycleType: 'turn.failed',
        rawError: detail,
        argsPreview: ev.turnId ? formatArgsPreview(`turnId=${ev.turnId}`, 160) : '',
        timestamp,
        ...lineMeta,
      },
    ];
  }

  if (evType === 'task.terminated' && ev.info && (ev.info.status === 'failed' || ev.info.status === 'timed_out')) {
    const isAgent = ev.info.kind === 'agent';
    const lifecycleType = isAgent ? 'subagent.failed' : 'task.failed';
    const tail = typeof root.outputTail === 'string' && root.outputTail.trim() ? root.outputTail : '';
    const rawError = tail || `Background ${ev.info.kind || 'task'} ${ev.info.status}`;
    return [
      {
        type: 'lifecycle_error',
        lifecycleType,
        rawError,
        argsPreview: formatArgsPreview(ev.info.description || ev.info.command || ev.info.taskId || '', 160),
        timestamp,
        ...lineMeta,
      },
    ];
  }

  return null;
}

export function extractSessionMetaFromRelPath(relPath) {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  const agentsIdx = parts.indexOf('agents');
  let agentId = 'main';
  let sessionIdx = parts.length - 2;

  if (agentsIdx >= 1 && agentsIdx + 1 < parts.length - 1) {
    agentId = parts[agentsIdx + 1] || 'main';
    sessionIdx = agentsIdx - 1;
  }

  const sessionId = sessionIdx >= 0 ? parts[sessionIdx] : 'unknown';
  const rawBucket = sessionIdx >= 1 ? parts[0] : 'default';
  const workspaceFallback =
    /^[0-9a-f]{32,}$/i.test(rawBucket) ? `ws_${rawBucket.slice(0, 8)}` : formatWorkspaceLabel(rawBucket);
  const sessionRelDir = sessionIdx >= 0 ? path.join(...parts.slice(0, sessionIdx + 1)) : '';

  return {
    workspaceFallback,
    sessionId,
    agentId,
    sessionRelDir,
  };
}
