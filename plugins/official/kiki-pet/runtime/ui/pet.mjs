// Native transparent desk-pet window frontend.
// GPL-3.0-or-later. Interaction and animation patterns adapt OpenPet
// (github.com/X-T-E-R/OpenPet, pinned in the workspace sources); the
// normalized-atlas contract, gaze strip, asset caching, Tauri bridge use and
// phase mapping are Kiki's own.
//
// The renderer is supervised, not the process: a stall here is what the
// heartbeat detects, so the heartbeat keeps running while paused and while
// the pet is deliberately idle.

const $ = (sel) => document.querySelector(sel);
const T = () => globalThis.__TAURI__;

const canvas = $('[data-sprite]');
const ctx = canvas.getContext('2d');
const pet = $('[data-pet]');
const bubbleEl = $('[data-bubble]');
const bubbleText = $('[data-bubble-text]');
const connectingEl = $('[data-connecting]');
const menuEl = $('[data-menu]');
const shadowEl = $('.shadow');

const PHASE_ANIMATION = {
  idle: 'idle',
  working: 'running',
  waiting: 'waiting',
  completed: 'waving',
  failed: 'failed',
};

let snapshot = null;
let image = null;
let animation = null;
let startedAt = 0;
let raf = 0;
let hoverHeld = false;
let lastMoveAt = 0;
let dragging = false;
let pressStart = null;
let bubbleTimer = 0;
let menuOpen = false;

// ------------------------------------------------------------- animation ---

function frameAt(anim, elapsedMs) {
  const durs = Array.isArray(anim.frameDurationsMs) ? anim.frameDurationsMs : [];
  const total = durs.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const cursor = ((elapsedMs % total) + total) % total;
  let consumed = 0;
  for (let i = 0; i < durs.length; i += 1) {
    consumed += durs[i];
    if (cursor < consumed) return Math.min(i, anim.frameCount - 1);
  }
  return Math.max(0, anim.frameCount - 1);
}

function pickAnimation(next) {
  const anims = next?.activePet?.animations ?? {};
  const active = next?.action;
  // An explicit unexpired action wins; an unknown id falls back through the
  // phase mapping rather than freezing on a missing row.
  if (active && typeof active.animationId === 'string' && anims[active.animationId]) {
    return { id: active.animationId, ...anims[active.animationId], until: active.until };
  }
  const phase = PHASE_ANIMATION[next?.activity?.phase] ?? 'idle';
  const id = anims[phase] ? phase : (anims.idle ? 'idle' : Object.keys(anims)[0]);
  return id ? { id, ...anims[id] } : null;
}

function currentAnimation() {
  const a = pickAnimation(snapshot);
  if (!a) return null;
  if (a.until !== undefined && snapshot && Date.now() > a.until) return pickAnimation({ ...snapshot, action: null });
  return a;
}

function cellSize() {
  const atlas = snapshot?.activePet?.atlas;
  if (!atlas) return { w: 120, h: 120 };
  const scale = snapshot?.settings?.scale ?? 1;
  return { w: Math.round(atlas.cellWidth * scale), h: Math.round(atlas.cellHeight * scale) };
}

// Codex v2 ships a gaze strip: 16 static head-turn frames (index 0 is up, then
// clockwise in 22.5° steps) at rows 9 and 10, plus a neutral cell. These are
// not sleeping/happy animations — they only apply while the pet is idle and
// unpaused, and they fall back to neutral after the reset delay.
function gazeFor() {
  const gaze = snapshot?.activePet?.gaze;
  if (!gaze || !gaze.frames?.length) return null;
  const phase = snapshot?.activity?.phase;
  const settings = snapshot?.settings ?? {};
  if (phase !== 'idle' || settings.paused || settings.reducedMotion || dragging) return null;
  // `hoverPause` is the user asking for stillness on hover, which outranks a
  // cursor-tracking glance; the pet holds its neutral frame instead.
  if (hoverHeld && settings.hoverPause) return null;
  if (gazeResetTimer === 0) return null;
  const index = gazeIndexFromPointer();
  const frame = gaze.frames[Math.max(0, Math.min(gaze.frames.length - 1, index))];
  return frame ? { row: frame.row, column: frame.column } : null;
}

let gazeResetTimer = 0;

function gazeIndexFromPointer() {
  const gaze = snapshot?.activePet?.gaze;
  if (!gaze) return 0;
  const originX = window.innerWidth / 2;
  const originY = window.innerHeight * 0.6;
  const dx = pointerX - originX;
  const dy = pointerY - originY;
  if (Math.hypot(dx, dy) < (gaze.deadZonePx ?? 24)) return 0;
  // index 0 is straight up, then clockwise: up is -90° in screen space.
  const angle = Math.atan2(dx, -dy);
  const steps = gaze.frames.length;
  const index = Math.round((angle / (Math.PI * 2)) * steps) % steps;
  return index < 0 ? index + steps : index;
}

let pointerX = 0;
let pointerY = 0;

// The pet only looks at the cursor while it is being moved, then returns to
// neutral after the pet's own reset delay. Timed, not per-frame, so a still
// cursor costs nothing.
window.addEventListener('pointermove', (ev) => {
  pointerX = ev.clientX;
  pointerY = ev.clientY;
  noteGazeMovement();
  clearTimeout(gazeIdleTimer);
  const reset = snapshot?.activePet?.gaze?.resetAfterMs ?? 1200;
  gazeIdleTimer = setTimeout(() => { gazeResetTimer = 0; schedule(); }, reset);
});

let gazeIdleTimer = 0;

function noteGazeMovement() {
  if (!snapshot?.activePet?.gaze) return;
  gazeResetTimer = 1;
  schedule();
}

function draw() {
  raf = 0;
  const anim = currentAnimation();
  if (!snapshot || !image || !anim) return;
  const atlas = snapshot.activePet.atlas;
  const { w, h } = cellSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const settings = snapshot.settings ?? {};
  const still = settings.paused || settings.reducedMotion || hoverHeld;
  let sx;
  let sy;
  let sw = atlas.cellWidth;
  let sh = atlas.cellHeight;
  if (!still) {
    const gaze = gazeFor();
    if (gaze) {
      // A static gaze cell replaces the idle frame, at the same cell size.
      sx = gaze.column * atlas.cellWidth;
      sy = gaze.row * atlas.cellHeight;
    } else {
      const frame = frameAt(anim, performance.now() - startedAt);
      sx = (frame % Math.max(1, atlas.columns)) * atlas.cellWidth;
      sy = anim.row * atlas.cellHeight;
    }
  } else {
    sx = 0;
    sy = anim.row * atlas.cellHeight;
  }
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);

  if (!still) raf = requestAnimationFrame(draw);
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(draw);
}

// ------------------------------------------------------------------ image ---

// Contract v2: `pet-state` carries activePet.spriteUrl only on the first state
// or when the id+hash changes. Later descriptor-only events must keep using the
// cached sheet, so a settings or activity push never blanks or restarts the
// frame clock. The initial `pet_snapshot` may carry the image too.
let spriteCache = { key: null, image: null, failed: false };

function adoptSprite(key, dataUrl) {
  const entry = { key, image: null, failed: false };
  spriteCache = entry;
  const img = new Image();
  img.onload = () => {
    if (spriteCache !== entry) return;
    entry.image = img;
    image = img;
    startedAt = performance.now();
    resize();
    schedule();
  };
  img.onerror = () => { if (spriteCache === entry) entry.failed = true; };
  img.src = dataUrl;
}

function loadImage(next) {
  const active = next?.activePet;
  if (!active?.id) { image = null; spriteCache = { key: null, image: null, failed: false }; return; }
  const key = `${active.id}:${active.provenance?.sha256 ?? ''}`;
  if (spriteCache.key === key) {
    // Same pet: keep the decoded sheet and the running frame clock.
    image = spriteCache.image;
    if (!spriteCache.image && !spriteCache.failed && active.spriteUrl) adoptSprite(key, active.spriteUrl);
    return;
  }
  if (typeof active.spriteUrl === 'string' && active.spriteUrl.startsWith('data:')) {
    adoptSprite(key, active.spriteUrl);
    return;
  }
  // A descriptor for a sheet we have not seen: keep the previous frame rather
  // than flashing an empty window.
  image = null;
}

// ------------------------------------------------------------------ sizes ---

function resize() {
  const { w, h } = cellSize();
  // The window must be tall enough for a bubble above the pet, otherwise a
  // short message is clipped by the window edge. Headroom scales with the pet
  // so a large sprite still gets a proportionate bubble area.
  const headroom = Math.max(64, Math.round(h * 0.55));
  const surfaceW = Math.max(120, w + 32);
  const surfaceH = Math.round(h + headroom + 12);
  // Only ask for a new window size when geometry actually changed; pet_resize
  // is a real native resize and is clamped by the runtime.
  const want = { width: Math.round(surfaceW), height: Math.round(surfaceH) };
  if (want.width !== lastSize.w || want.height !== lastSize.h) {
    lastSize = want;
    void invoke('pet_resize', want).catch(() => {});
  }
  pet.style.setProperty('--sprite-w', `${w}px`);
  pet.style.setProperty('--sprite-h', `${h}px`);
  pet.style.setProperty('--headroom', `${headroom}px`);
  shadowEl.style.width = `${Math.round(w * 0.42)}px`;
}

let lastSize = { width: 0, height: 0 };

// ----------------------------------------------------------------- bubble ---

function showBubble(next) {
  const b = next?.bubble;
  if (!b || typeof b.text !== 'string' || b.text === '') { hideBubble(); return; }
  bubbleText.textContent = b.text;
  bubbleEl.hidden = false;
  // Text only: never innerHTML, and cap the length the bubble will lay out.
  bubbleEl.classList.toggle('long', b.text.length > 64);
  clearTimeout(bubbleTimer);
  const ttl = Math.max(800, Math.min(10000, (b.until ?? Date.now() + 4000) - Date.now()));
  bubbleTimer = setTimeout(hideBubble, ttl);
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleEl.hidden = true;
}

const PHASE_BUBBLE = {
  idle: 'Idle',
  working: 'Working…',
  waiting: 'Waiting on you',
  completed: 'Done',
  failed: 'Something needs attention',
};

// ----------------------------------------------------------------- render ---

function render(next) {
  if (!next) return;
  const first = snapshot === null;
  snapshot = next;
  connectingEl.hidden = true;
  loadImage(next);
  resize();
  showBubble(next);
  syncMenu();
  // A phase change with no explicit bubble still deserves one short line, but
  // only on the transition, so a static phase never re-fires a timer.
  const phase = next.activity?.phase;
  if (!first && phase !== lastPhase && !next.bubble) {
    const text = PHASE_BUBBLE[phase];
    if (text) {
      bubbleText.textContent = text;
      bubbleEl.hidden = false;
      bubbleEl.classList.remove('long');
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(hideBubble, next.settings?.bubbleTtlMs ?? 4000);
    }
  }
  lastPhase = phase;
  schedule();
}

let lastPhase = null;

// ------------------------------------------------------------------ tauri ---

async function invoke(cmd, args) {
  const t = T();
  if (!t?.core?.invoke) return undefined;
  return t.core.invoke(cmd, args);
}

function dispatch(action, args) {
  return invoke('pet_dispatch', { action, args }).catch(() => {});
}

async function readSnapshot() {
  try {
    const next = await invoke('pet_snapshot');
    if (next) render(next);
    else connectingEl.hidden = false;
  } catch {
    connectingEl.hidden = false;
  }
}

function currentWindow() {
  return T()?.window?.getCurrentWindow?.();
}

// ------------------------------------------------------------------ input ---

function localPoint(ev) {
  const r = pet.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

pet.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2) return;
  pressStart = { x: ev.clientX, y: ev.clientY, at: performance.now() };
  dragging = false;
  pet.setPointerCapture?.(ev.pointerId);
});

pet.addEventListener('pointermove', (ev) => {
  if (!pressStart) return;
  const dx = ev.clientX - pressStart.x;
  const dy = ev.clientY - pressStart.y;
  if (!dragging && Math.hypot(dx, dy) > 4) {
    dragging = true;
    // A native drag, not a stream of pointer coordinates: the OS moves the
    // window and a normal release ends it.
    currentWindow()?.startDragging?.();
  }
});

pet.addEventListener('pointerup', (ev) => {
  const start = pressStart;
  pressStart = null;
  if (!start) return;
  if (dragging) { dragging = false; return; }
  if (performance.now() - start.at > 600) return;
  // A tap: wave for attention, or report the phase when a task is live.
  const phase = snapshot?.activity?.phase ?? 'idle';
  if (phase === 'idle') void dispatch('action', { animationId: 'waving', durationMs: 1600 });
  else void dispatch('focus', {});
  void dispatch('say', { text: PHASE_BUBBLE[phase] ?? 'Idle', ttlMs: 2600 });
});

pet.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  openMenu();
});

pet.addEventListener('pointerenter', () => {
  if (snapshot?.settings?.hoverPause) hoverHeld = true;
});
pet.addEventListener('pointerleave', () => {
  hoverHeld = false;
  schedule();
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeMenu();
  if (ev.key === ' ' || ev.key === 'Enter') {
    ev.preventDefault();
    void dispatch('action', { animationId: 'waving', durationMs: 1600 });
  }
});

// ------------------------------------------------------------------- menu ---

function openMenu() {
  menuOpen = true;
  syncMenu();
  menuEl.hidden = false;
  menuEl.querySelector('.menu-item')?.focus();
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  menuEl.hidden = true;
}

function syncMenu() {
  const s = snapshot?.settings ?? {};
  for (const item of menuEl.querySelectorAll('[data-menu]')) {
    const kind = item.dataset.menu;
    if (kind === 'pause') {
      item.setAttribute('aria-checked', s.paused ? 'true' : 'false');
      item.textContent = s.paused ? 'Resume animations' : 'Pause animations';
    }
    if (kind === 'walk') {
      item.setAttribute('aria-checked', s.autonomousWalking ? 'true' : 'false');
      item.textContent = s.autonomousWalking ? 'Stop walking on its own' : 'Walk on its own';
    }
    if (kind === 'status') {
      const phase = snapshot?.activity?.phase ?? 'idle';
      item.textContent = phase === 'idle' ? 'Nothing is running right now' : 'Go to the Kiki session';
    }
  }
}

menuEl.addEventListener('click', (ev) => {
  const item = ev.target.closest('[data-menu]');
  if (!item) return;
  const s = snapshot?.settings ?? {};
  switch (item.dataset.menu) {
    case 'status': {
      const phase = snapshot?.activity?.phase ?? 'idle';
      if (phase !== 'idle') void dispatch('focus', {});
      else void dispatch('say', { text: 'Nothing is running right now', ttlMs: 2400 });
      break;
    }
    case 'pause': void dispatch('settings', { paused: !s.paused }); break;
    case 'walk': void dispatch('settings', { autonomousWalking: !s.autonomousWalking }); break;
    case 'stop': void dispatch('stop', {}); break;
    default: break;
  }
  closeMenu();
});

window.addEventListener('pointerdown', (ev) => {
  if (menuOpen && !menuEl.contains(ev.target)) closeMenu();
}, true);

// ----------------------------------------------------------------- walking ---

// Opt-in autonomous walking nudges the real window a few pixels at a time;
// the runtime clamps the delta and keeps the window inside the work area.
function walkTick() {
  const s = snapshot?.settings ?? {};
  // A press of any kind owns the window: nudging it while the user is
  // dragging (or has merely touched it) fights the native drag.
  if (s.autonomousWalking && !s.paused && !s.reducedMotion && !hoverHeld && !pressStart && !menuOpen) {
    if (Date.now() - lastMoveAt > 900) {
      lastMoveAt = Date.now();
      const dir = Math.random() < 0.5 ? -1 : 1;
      void invoke('pet_move', { dx: dir * 12, dy: 0 }).catch(() => {});
    }
  }
  setTimeout(walkTick, 1000);
}

// ------------------------------------------------------------------- boot ---

// The heartbeat is the health signal for this renderer. It must keep running
// even while paused or reduced-motion, otherwise a healthy pet looks dead.
function heartbeat() {
  void invoke('pet_heartbeat').catch(() => {});
  setTimeout(heartbeat, 1000);
}

async function boot() {
  heartbeat();
  walkTick();
  await readSnapshot();
  const t = T();
  t?.event?.listen?.('pet-state', (event) => render(event.payload))?.catch?.(() => {});
  // The pet is draggable and activatable from the keyboard, so it must be
  // focusable; a click anywhere on the body also restores focus.
  pet.tabIndex = 0;
  pet.addEventListener('pointerdown', () => pet.focus());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
