export function readStorageConfig(text) {
  let section = '';
  let mode;
  let storagePath;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const field = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1];
    const value = field[2].trim();
    if (section === 'taskBoard' && key === 'storage' && value.startsWith('{')) {
      const inlineMode = /mode\s*=\s*"?(auto|global|fixed)"?/.exec(value);
      const inlinePath = /path\s*=\s*"((?:\\.|[^"\\])*)"/.exec(value);
      if (inlineMode) mode = inlineMode[1];
      if (inlinePath) storagePath = inlinePath[1].replaceAll('\\"', '"');
    }
    if (section === 'taskBoard.storage' && key === 'mode') {
      const quoted = /^"(auto|global|fixed)"$/.exec(value) ?? /^(auto|global|fixed)$/.exec(value);
      if (quoted) mode = quoted[1];
    }
    if (section === 'taskBoard.storage' && key === 'path') {
      const quoted = /^"((?:\\.|[^"\\])*)"$/.exec(value);
      storagePath = quoted ? quoted[1].replaceAll('\\"', '"') : value;
    }
  }
  if (mode !== 'auto' && mode !== 'global' && mode !== 'fixed') return { mode: 'auto' };
  if (mode === 'fixed' && (typeof storagePath !== 'string' || storagePath.trim() === '' || /[\u0000-\u001f]/u.test(storagePath))) return { mode: 'auto' };
  return mode === 'fixed' ? { mode, path: storagePath.trim() } : { mode };
}
