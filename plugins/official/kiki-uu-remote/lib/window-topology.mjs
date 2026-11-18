const QT_MAIN_WINDOW_CLASS_RE = /^Qt\d+QWindowIcon$/i;
const QT_POPUP_TOOLBAR_CLASS_RE = /^Qt\d+QWindowToolSaveBits$/i;
const CHROME_EMBED_CLASS_RE = /^(?:Chrome_WidgetWin_\d+|Chrome_RenderWidgetHostHWND)$/i;

const LAUNCHER_TITLES = new Set([
  'uu远程',
  '网易uu远程',
  'gameviewer',
  'uu remote',
  'netease uu remote',
]);

export function normalizeSessionId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^uu:\d+$/i.test(text)) return `uu:${text.slice(3)}`;
  if (/^\d+$/.test(text)) return `uu:${text}`;
  return text;
}

export function parseHwndFromSessionId(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  const match = /^uu:(\d+)$/.exec(normalized);
  return match ? Number(match[1]) : null;
}

export function computeRectIntersectionArea(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

export function isWindowOffscreen(outerBounds, monitors = []) {
  if (!outerBounds || outerBounds.width <= 0 || outerBounds.height <= 0) return false;
  if (!Array.isArray(monitors) || monitors.length === 0) return false;

  const winArea = Math.max(1, outerBounds.width * outerBounds.height);
  const headerStrip = {
    x: outerBounds.x,
    y: outerBounds.y,
    width: outerBounds.width,
    height: Math.min(outerBounds.height, 96),
  };

  let maxOverlapArea = 0;
  let maxHeaderOverlapWidth = 0;
  for (const mon of monitors) {
    const bounds = mon?.bounds || mon;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
    const area = computeRectIntersectionArea(outerBounds, bounds);
    if (area > maxOverlapArea) maxOverlapArea = area;

    const hLeft = Math.max(headerStrip.x, bounds.x);
    const hRight = Math.min(headerStrip.x + headerStrip.width, bounds.x + bounds.width);
    const hTop = Math.max(headerStrip.y, bounds.y);
    const hBottom = Math.min(headerStrip.y + headerStrip.height, bounds.y + bounds.height);
    if (hRight > hLeft && hBottom > hTop) {
      maxHeaderOverlapWidth = Math.max(maxHeaderOverlapWidth, hRight - hLeft);
    }
  }

  if (maxOverlapArea <= 0) return true;
  const overlapRatio = maxOverlapArea / winArea;
  return overlapRatio < 0.08 && maxHeaderOverlapWidth < 96;
}

export function computeRescueBounds(outerBounds, primaryMonitor, index = 0) {
  const workArea = primaryMonitor?.workArea || primaryMonitor?.bounds || {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  };
  const baseWidth = outerBounds?.width > 120 ? outerBounds.width : 1280;
  const baseHeight = outerBounds?.height > 120 ? outerBounds.height : 800;
  const width = Math.max(320, Math.min(baseWidth, workArea.width - 32));
  const height = Math.max(240, Math.min(baseHeight, workArea.height - 32));
  const cascade = (index % 6) * 28;
  const x = workArea.x + Math.min(
    Math.max(0, workArea.width - width),
    Math.max(16, Math.floor((workArea.width - width) / 2) + cascade),
  );
  const y = workArea.y + Math.min(
    Math.max(0, workArea.height - height),
    Math.max(16, Math.floor((workArea.height - height) / 2) + cascade),
  );
  return { x, y, width, height };
}

function selectInnerStageChild(children = []) {
  const candidates = children.filter((child) => {
    if (!child || child.visible === false) return false;
    if (!QT_MAIN_WINDOW_CLASS_RE.test(String(child.className || ''))) return false;
    const b = child.clientBounds || child.bounds;
    return b && b.width >= 64 && b.height >= 64;
  });

  if (candidates.length === 0) return null;

  const gameViewerTitled = candidates.filter(
    (child) => String(child.title || '').trim().toLowerCase() === 'gameviewer',
  );
  const pool = gameViewerTitled.length > 0 ? gameViewerTitled : candidates;

  return pool.reduce((best, item) => {
    const b = item.clientBounds || item.bounds;
    const bestB = best.clientBounds || best.bounds;
    return b.width * b.height > bestB.width * bestB.height ? item : best;
  });
}

/**
 * Classify enumerated top-level GameViewer windows into launcher, active/minimized/offscreen
 * remote desktop sessions, and ignored floating toolbars.
 */
export function classifyUuWindows(rawWindows = [], monitors = []) {
  const sessions = [];
  const launchers = [];
  const ignored = [];

  for (const win of rawWindows) {
    if (!win || !win.hwnd) continue;
    const hwnd = Number(win.hwnd);
    const className = String(win.className || '');
    const title = String(win.title || '').trim();
    const isIconic = Boolean(win.isIconic) || (win.outerBounds?.x <= -30000 && win.outerBounds?.y <= -30000);
    const visible = Boolean(win.visible);

    if (!visible && !isIconic) continue;

    if (QT_POPUP_TOOLBAR_CLASS_RE.test(className)) {
      ignored.push({ hwnd, className, title, reason: 'toolbar_popup' });
      continue;
    }

    if (!QT_MAIN_WINDOW_CLASS_RE.test(className)) {
      ignored.push({ hwnd, className, title, reason: 'non_qt_window' });
      continue;
    }

    const children = Array.isArray(win.children) ? win.children : [];
    const hasEmbeddedChromium = children.some((child) =>
      CHROME_EMBED_CLASS_RE.test(String(child?.className || '')),
    );
    const normalizedTitle = title.toLowerCase();
    const isLauncherByTitle = LAUNCHER_TITLES.has(normalizedTitle);

    if (hasEmbeddedChromium || isLauncherByTitle || !title) {
      const offscreen = !isIconic && isWindowOffscreen(win.outerBounds, monitors);
      launchers.push({
        hwnd,
        title: title || 'UU Remote',
        className,
        pid: win.pid ?? null,
        isIconic,
        offscreen,
        outerBounds: win.outerBounds || null,
      });
      continue;
    }

    const stageChild = selectInnerStageChild(children);
    const outerBounds = win.outerBounds || { x: 0, y: 0, width: 0, height: 0 };
    const fallbackClient = win.clientBounds && win.clientBounds.width > 0 && win.clientBounds.height > 0
      ? win.clientBounds
      : outerBounds;
    const rawStageBounds = stageChild
      ? (stageChild.clientBounds || stageChild.bounds)
      : fallbackClient;

    const canvasBounds = {
      x: Math.round(Number(rawStageBounds?.x ?? outerBounds.x) || 0),
      y: Math.round(Number(rawStageBounds?.y ?? outerBounds.y) || 0),
      width: Math.max(0, Math.round(Number(rawStageBounds?.width ?? outerBounds.width) || 0)),
      height: Math.max(0, Math.round(Number(rawStageBounds?.height ?? outerBounds.height) || 0)),
    };

    const state = isIconic
      ? 'minimized'
      : isWindowOffscreen(outerBounds, monitors)
        ? 'offscreen'
        : 'active';

    const dpi = Number(win.dpi) > 0 ? Math.round(Number(win.dpi)) : 96;
    const scaleFactor = Number((dpi / 96).toFixed(2));

    sessions.push({
      id: `uu:${hwnd}`,
      hwnd,
      stageHwnd: stageChild ? Number(stageChild.hwnd) : hwnd,
      hasInnerStage: Boolean(stageChild),
      pid: win.pid ?? null,
      label: title,
      className,
      state,
      dpi,
      scaleFactor,
      outerBounds,
      canvasBounds,
    });
  }

  return { sessions, launchers, ignored };
}
