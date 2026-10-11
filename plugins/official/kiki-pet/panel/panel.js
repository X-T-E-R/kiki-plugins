// Panel frontend for the Kiki desk-pet plugin.
// GPL-3.0-or-later. Interaction and animation patterns adapt OpenPet
// (github.com/X-T-E-R/OpenPet, pinned in the workspace sources); the
// normalized-atlas geometry, asset caching and the panel bridge shape here
// are Kiki's own.
// Talks to the backend over the verified Host panel bridge on the
// `kiki.panel.v1` channel. No streaming subscription: poll `state` on a timer
// while visible.

const CHANNEL = 'kiki.panel.v1';
const POLL_MS = 2000;
const STAGE_MAX = 104;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-') || k === 'role' || k === 'aria-checked' || k === 'aria-label' || k === 'type') {
      if (k === 'type') node.type = v;
      else node.setAttribute(k, v);
    } else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

// ---------------------------------------------------------------- bridge ---

let seq = 0;
const pending = new Map();
let hostSession = null;

function post(message) {
  parent.postMessage(message, '*');
}

function call(method, extra = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The panel host did not answer. Try again.'));
    }, 12000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    post({ channel: CHANNEL, kind: 'request', id, method, ...extra });
  });
}

async function pluginCall(action, args) {
  const r = await call('plugin.call', { action, args });
  if (r.ok) return r.result;
  throw new Error(typeof r.error === 'string' && r.error ? r.error : 'The pet backend refused that request.');
}

window.addEventListener('message', (ev) => {
  if (ev.source !== parent || !ev.data || ev.data.channel !== CHANNEL) return;
  const msg = ev.data;
  if (msg.kind === 'init') { hostSession = msg.sessionId ?? null; return; }
  if (msg.kind !== 'response') return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.ok) slot.resolve(msg);
  else slot.reject(new Error(typeof msg.error === 'string' && msg.error ? msg.error : 'Request failed.'));
});

const callState = () => pluginCall('state');

// ------------------------------------------------------------- animation ---
// Normalized atlas geometry from the backend is authoritative; never assume a
// fixed grid. Renders one frame at a time into a <canvas>.

function frameAt(anim, elapsedMs) {
  const durs = anim.frameDurationsMs && anim.frameDurationsMs.length ? anim.frameDurationsMs : [];
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

const PHASE_ANIMATION = {
  idle: 'idle',
  working: 'running',
  waiting: 'waiting',
  completed: 'waving',
  failed: 'failed',
};

function animationFor(snapshot, id) {
  const anims = snapshot?.activePet?.animations ?? {};
  if (id && anims[id]) return { id, ...anims[id] };
  const phase = PHASE_ANIMATION[snapshot?.activity?.phase] ?? 'idle';
  if (anims[phase]) return { id: phase, ...anims[phase] };
  const fallbackId = anims.idle ? 'idle' : Object.keys(anims)[0];
  return fallbackId ? { id: fallbackId, ...anims[fallbackId] } : null;
}

// Renders a pet's current frame; respects paused/reducedMotion by holding a
// representative frame instead of looping.
//
// Contract v2: `state` and mutation results carry Pet descriptors WITHOUT the
// sprite bytes. The sheet is fetched once per id+sha through the `asset`
// action and kept in a cache, so a 2s poll never re-fetches, never re-decodes,
// and never restarts the frame clock.
const spriteCache = new Map();

function petKey(pet) {
  return `${pet?.id ?? ''}:${pet?.provenance?.sha256 ?? ''}`;
}

function cacheGet(pet) {
  if (!pet?.id) return null;
  return spriteCache.get(petKey(pet)) ?? null;
}

function cacheAdopt(key, dataUrl) {
  if (!dataUrl) {
    // Claim the slot without decoding anything, so a burst of callers fetches
    // exactly once while the real sheet is still in flight.
    const pending = { image: null, error: false, ready: null, loading: true };
    spriteCache.set(key, pending);
    return pending;
  }
  const entry = { image: null, error: false, ready: null, loading: false };
  spriteCache.set(key, entry);
  while (spriteCache.size > 6) {
    const oldest = spriteCache.keys().next().value;
    if (oldest === key) break;
    spriteCache.delete(oldest);
  }
  const img = new Image();
  img.decoding = 'async';
  entry.ready = new Promise((resolve) => {
    img.onload = () => { entry.image = img; resolve(entry); };
    img.onerror = () => { entry.error = true; resolve(entry); };
  });
  img.src = dataUrl;
  // Callers await the decode, so they never paint a half-loaded sheet.
  return entry.ready;
}

/** Fetch the sprite sheet for a descriptor, once per id+sha. */
async function ensureSprite(pet) {
  const key = petKey(pet);
  if (!pet?.id) return cacheAdopt(key, '');
  const hit = spriteCache.get(key);
  if (hit) {
    // Another caller already owns this fetch; join it instead of starting a
    // second one for the same id+hash.
    if (hit.inflight) { await hit.inflight; return spriteCache.get(key) ?? hit; }
    return hit.image ? hit : (hit.ready ?? hit);
  }
  const claim = cacheAdopt(key, '');
  claim.inflight = (async () => {
    try {
      const r = await pluginCall('asset', { id: pet.id, sha256: pet.provenance?.sha256 });
      if (r && typeof r.spriteUrl === 'string' && r.spriteUrl.startsWith('data:')) {
        await cacheAdopt(key, r.spriteUrl);
        return;
      }
      const e = spriteCache.get(key);
      if (e) e.error = true;
    } catch {
      const e = spriteCache.get(key);
      if (e) e.error = true;
    }
  })();
  await claim.inflight;
  return spriteCache.get(key) ?? claim;
}

class PetStage {
  constructor(host) {
    this.host = host;
    this.canvas = el('canvas', { class: 'stage-canvas' });
    this.caption = el('span', { class: 'stage-caption' });
    this.wrap = el('div', { class: 'stage' }, [this.canvas, this.caption]);
    this.image = null;
    this.raf = 0;
    this.startedAt = 0;
    this.current = null;
    this.onNeedSprite = null;
    host.append(this.wrap);
  }

  async load(snapshot) {
    const pet = snapshot?.activePet;
    if (!pet?.id) {
      this.image = null;
      this.current = null;
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.wrap.classList.add('stage-empty');
      this.caption.textContent = 'No pet loaded';
      return;
    }
    this.wrap.classList.remove('stage-empty');
    let entry = cacheGet(pet);
    if (!entry) {
      this.caption.textContent = 'Loading preview…';
      entry = await ensureSprite(pet);
      // The pet may have been switched while the fetch was in flight.
      if (state.snapshot?.activePet?.id !== pet.id) return;
    }
    if (entry.error) {
      this.image = null;
      this.caption.textContent = 'Preview unavailable';
      return;
    }
    if (entry.image) {
      const key = petKey(pet);
      if (this.current !== key) {
        // A genuinely different pet: restart the frame clock exactly once.
        this.current = key;
        this.startedAt = performance.now();
      }
      this.image = entry.image;
      this.kick();
      return;
    }
    this.image = null;
    this.caption.textContent = 'Loading preview…';
    this.onNeedSprite?.(pet);
  }

  setAnimation(anim, snapshot) {
    this.anim = anim;
    this.snapshot = snapshot;
    this.kick();
  }

  kick() {
    if (this.raf) return;
    const loop = () => {
      this.raf = 0;
      this.draw();
      const s = this.snapshot;
      const paused = s?.settings?.paused;
      const reduced = s?.settings?.reducedMotion;
      if (!paused && !reduced && this.anim) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  draw() {
    const pet = this.snapshot?.activePet;
    const anim = this.anim;
    if (!this.image || !pet || !anim) return;
    const atlas = pet.atlas;
    const cw = atlas.cellWidth;
    const ch = atlas.cellHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // The stage shows one cell of the normalized atlas, not the whole sheet,
    // so size by cell proportion and honour the user's pet scale.
    const fit = Math.min(1, STAGE_MAX / Math.max(cw, ch));
    const w = Math.max(48, Math.round(cw * fit * (this.snapshot?.settings?.scale ?? 1)));
    const h = Math.max(48, Math.round(ch * fit * (this.snapshot?.settings?.scale ?? 1)));
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const still = this.snapshot?.settings?.paused || this.snapshot?.settings?.reducedMotion;
    const frame = still ? 0 : frameAt(anim, performance.now() - this.startedAt);
    const col = frame % Math.max(1, atlas.columns);
    ctx.drawImage(this.image, col * cw, anim.row * ch, cw, ch, 0, 0, w, h);
    this.caption.textContent = this.animLabel(anim.id);
  }

  animLabel(id) {
    if (id === 'idle') return 'Idle';
    if (id === 'running') return 'Running in place';
    if (id === 'waiting') return 'Waiting';
    if (id === 'waving') return 'Waving';
    if (id === 'failed') return 'Needs attention';
    return id;
  }
}

// ------------------------------------------------------------------ state ---

const PHASE_COPY = {
  idle: { label: 'Idle', detail: 'No task in flight.' },
  working: { label: 'Working', detail: 'Kiki is running a task.' },
  waiting: { label: 'Waiting on you', detail: 'Approval or a question is blocking.' },
  completed: { label: 'Task complete', detail: 'The last task finished.' },
  failed: { label: 'Task failed', detail: 'The last task hit an error.' },
};

const RUNTIME_COPY = {
  stopped: 'Pet is stopped',
  starting: 'Pet is starting…',
  running: 'Pet is running',
  failed: 'Pet runtime failed',
};

const PLAYABLE = ['waving', 'jumping', 'waiting', 'running', 'review', 'failed'];

const state = {
  snapshot: null,
  stage: null,
  busy: false,
};

function setBusy(flag) {
  state.busy = flag;
  $$('[data-action="start"], [data-action="stop"]').forEach((b) => { b.disabled = flag; });
  const submit = $('[data-import-submit]');
  if (submit) { submit.disabled = flag; submit.dataset.busy = flag ? '1' : '0'; }
}

function applyRuntime(snapshot) {
  const box = $('[data-runtime-status]');
  const runtime = snapshot?.runtime ?? { status: 'stopped' };
  box.dataset.tone = runtime.status === 'failed' ? 'bad' : runtime.status === 'running' ? 'good' : runtime.status === 'starting' ? 'busy' : 'idle';
  $('.runtime-text', box).textContent = RUNTIME_COPY[runtime.status] ?? 'Pet status unknown';

  const err = $('[data-runtime-error]');
  if (runtime.status === 'failed' && runtime.error) {
    err.textContent = runtime.error;
    err.hidden = false;
  } else err.hidden = true;

  // A running pet needs no start control; the header already says so. Only a
  // stopped or failed runtime offers one, and then it doubles as recovery.
  const start = $('[data-action="start"]');
  const needsStart = runtime.status === 'stopped' || runtime.status === 'failed';
  start.hidden = !needsStart;
  start.textContent = runtime.status === 'failed' ? 'Restart the pet' : 'Start the pet';
  start.disabled = state.busy || runtime.status === 'starting';
  $('[data-action="stop"]').disabled = state.busy || runtime.status === 'stopped';
}

function applyActivity(snapshot) {
  const box = $('[data-now]');
  const activity = snapshot?.activity;
  if (!activity) { box.hidden = true; return; }
  box.hidden = false;
  const copy = PHASE_COPY[activity.phase] ?? PHASE_COPY.idle;
  const mark = $('[data-phase-mark]');
  mark.dataset.phase = activity.phase;
  $('[data-phase-label]').textContent = copy.label;
  let detail = copy.detail;
  if (activity.reason === 'approval') detail = 'Waiting on your approval.';
  if (activity.reason === 'question') detail = 'Kiki asked a question.';
  if (activity.reason === 'cancelled') detail = 'The task was cancelled.';
  $('[data-phase-detail]').textContent = detail;

  const focusBtn = $('[data-action="focus"]');
  const hasSession = typeof activity.sessionId === 'string' && activity.sessionId.length > 0;
  focusBtn.dataset.hasSession = hasSession ? 'true' : 'false';
  // With no live session there is nothing to open, so the control is not
  // shown at all rather than left as a dead affordance.
  focusBtn.hidden = !hasSession;
  focusBtn.disabled = !hasSession;
}

function applyPets(snapshot) {
  const list = snapshot?.pets ?? [];
  const active = snapshot?.activePet;
  $('[data-pet-count]').textContent = list.length === 0 ? 'none installed' : `${list.length} installed`;

  void state.stage.load(snapshot);
  if (active) {
    $('[data-active-name]').textContent = active.displayName ?? active.id;
    const prov = active.provenance ?? {};
    const parts = [];
    if (prov.sourceUrl) {
      parts.push(el('a', { class: 'attr-link', href: prov.sourceUrl, target: '_blank', rel: 'noreferrer noopener', 'data-open-external': '1', text: prov.sourceName || prov.sourceUrl }));
    } else if (prov.sourceName) {
      parts.push(el('span', { text: prov.sourceName }));
    }
    const license = prov.license || 'unknown license';
    parts.push(el('span', { class: 'attr-sep', text: '·' }));
    parts.push(el('span', { class: `attr-license${/unknown/i.test(license) ? ' unknown' : ''}`, text: license }));
    if (prov.author) { parts.push(el('span', { class: 'attr-sep', text: '·' })); parts.push(el('span', { text: prov.author })); }
    $('[data-active-attr]').replaceChildren(...parts);
  } else {
    $('[data-active-name]').textContent = 'No pet yet';
    $('[data-active-attr]').replaceChildren();
  }

  // Playable action strip from the active pet's own animation ids.
  const anims = active?.animations ?? {};
  const strip = $('[data-play-strip]');
  strip.replaceChildren();
  const ids = PLAYABLE.filter((id) => anims[id]);
  for (const id of ids) {
    strip.append(el('button', { type: 'button', class: 'btn play-btn', 'data-play': id, text: playLabel(id) }));
  }
  if (ids.length === 0) strip.append(el('span', { class: 'count', text: 'no actions' }));

  applyLibrary(list, active);
}

// The installed-pets strip. Thumbnails come from the same id+sha cache as the
// stage, so selecting a pet that was already previewed costs no new fetch.
// The 2s poll re-enters this on every tick, so it reconciles in place instead
// of rebuilding: rebuilding would drop focus and restart thumbnail paints.
let librarySignature = '';

function applyLibrary(list, active) {
  const box = $('[data-library]');
  const signature = list.map((p) => `${p.id}:${p.provenance?.sha256 ?? ''}`).join('|') + `#${active?.id ?? ''}`;
  if (signature === librarySignature && box.childElementCount > 0) return;
  librarySignature = signature;
  box.replaceChildren();
  if (list.length === 0) return;
  for (const pet of list) {
    const isActive = pet.id === active?.id;
    const thumb = el('span', { class: 'lib-thumb' });
    const entry = cacheGet(pet);
    if (entry?.image) {
      thumb.append(drawThumb(pet, entry.image));
    } else {
      thumb.classList.add('lib-thumb-empty');
      // The sheet is already being fetched for the active pet or was just
      // requested here; when the decode lands, repaint this one thumbnail in
      // place rather than rebuilding the strip.
      void ensureSprite(pet).then((entry) => {
        if (!entry?.image) return;
        const host = box.querySelector(`[data-lib="${cssEscape(pet.id)}"] .lib-thumb`);
        if (!host) return;
        host.classList.remove('lib-thumb-empty');
        host.replaceChildren(drawThumb(pet, entry.image));
      });
    }
    const license = pet.provenance?.license ?? 'unknown';
    const btn = el('button', {
      type: 'button',
      class: `lib${isActive ? ' on' : ''}`,
      'data-lib': pet.id,
      role: 'radio',
      'aria-checked': isActive ? 'true' : 'false',
      title: `${pet.displayName ?? pet.id} — ${license}`,
    }, [thumb, el('span', { class: 'lib-name', text: pet.displayName ?? pet.id })]);
    if (/unknown/i.test(license)) btn.classList.add('lib-unknown');
    box.append(btn);
  }
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["'\\\]]/g, '\\$&');
}

function drawThumb(pet, image) {
  const atlas = pet.atlas;
  const canvas = el('canvas', { class: 'lib-canvas' });
  const size = 40;
  const anim = pet.animations?.idle ?? Object.values(pet.animations ?? {})[0];
  const cw = atlas?.cellWidth ?? size;
  const ch = atlas?.cellHeight ?? size;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  const fit = Math.min(size / cw, size / ch);
  const w = cw * fit;
  const h = ch * fit;
  ctx.drawImage(image, 0, (anim?.row ?? 0) * ch, cw, ch, (size - w) / 2, (size - h) / 2, w, h);
  return canvas;
}

function playLabel(id) {
  if (id === 'waving') return 'Wave';
  if (id === 'jumping') return 'Jump';
  if (id === 'running') return 'Run';
  if (id === 'waiting') return 'Wait';
  if (id === 'review') return 'Review';
  if (id === 'failed') return 'Alert';
  return id;
}

function applySettings(snapshot) {
  const s = snapshot?.settings;
  if (!s) return;
  const scale = $('[data-setting="scale"]');
  if (document.activeElement !== scale) scale.value = String(s.scale);
  $('[data-scale-readout]').textContent = `${Math.round(s.scale * 100)}%`;
  const ttl = $('[data-setting="bubbleTtlMs"]');
  if (document.activeElement !== ttl) ttl.value = String(s.bubbleTtlMs);
  for (const btn of $$('[data-toggle]')) {
    const key = btn.dataset.toggle;
    btn.setAttribute('aria-checked', s[key] ? 'true' : 'false');
  }
  // The hint appears only when the setting actually changes the behaviour, so
  // it is a fact rather than permanent explanation.
  const hint = $('[data-hover-hint]');
  const gazeCapable = Boolean(snapshot?.activePet?.gaze);
  hint.hidden = !(gazeCapable && s.hoverPause);
}

function applySources(snapshot) {
  const box = $('[data-sources]');
  const sources = snapshot?.sources ?? [];
  box.replaceChildren();
  if (sources.length === 0) {
    box.append(el('p', { class: 'count', text: 'No source catalog loaded yet.' }));
    return;
  }
  box.append(el('div', { class: 'sources-head', text: 'Where pets come from' }));
  for (const src of sources) {
    const row = el('div', { class: 'source-row' });
    const main = el('div', { class: 'source-main' });
    main.append(el('span', { class: 'source-label', text: src.label ?? src.id }));
    if (src.description) main.append(el('span', { class: 'source-desc', text: src.description }));
    row.append(main);
    const note = src.licenseNote;
    if (note) row.append(el('span', { class: `source-license${/unknown|unspecified|no licen/i.test(note) ? ' unknown' : ''}`, text: note }));
    if (src.url) {
      row.append(el('button', {
        type: 'button', class: 'btn linky source-open', 'data-open-external': src.url, text: 'Open',
      }));
    }
    box.append(row);
  }
}

function render(snapshot) {
  if (!snapshot) return;
  state.snapshot = snapshot;
  applyRuntime(snapshot);
  applyActivity(snapshot);
  applyPets(snapshot);
  applySettings(snapshot);
  applySources(snapshot);
  const anim = animationFor(snapshot, null);
  state.stage.setAnimation(anim, snapshot);
}

async function refresh() {
  if (document.hidden) return;
  try {
    const snapshot = await callState();
    render(snapshot);
  } catch (error) {
    const err = $('[data-runtime-error]');
    err.textContent = errorText(error);
    err.hidden = false;
  }
}

// ------------------------------------------------------------------ error ---

function errorText(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.replace(/^Error:\s*/, '');
}

async function withBusy(fn) {
  setBusy(true);
  try { await fn(); } catch (error) {
    const err = $('[data-runtime-error]');
    err.textContent = errorText(error);
    err.hidden = false;
  } finally {
    setBusy(false);
    refresh();
  }
}

// ----------------------------------------------------------------- events ---

function wire() {
  $('[data-action="start"]').addEventListener('click', () => withBusy(() => pluginCall('start')));
  $('[data-action="stop"]').addEventListener('click', () => withBusy(() => pluginCall('stop')));
  // The backend resolves the active session and routes to it itself, so this
  // is one request: no second navigation message, and it works with the panel
  // closed.
  $('[data-action="focus"]').addEventListener('click', () => withBusy(() => pluginCall('focus')));

  document.addEventListener('click', (ev) => {
    const open = ev.target.closest('[data-open-external]');
    if (open) {
      ev.preventDefault();
      const url = open.dataset.openExternal;
      if (/^https?:\/\//i.test(url)) void call('plugin.openExternal', { url }).catch(() => {});
      return;
    }
    const play = ev.target.closest('[data-play]');
    if (play) { void withBusy(() => pluginCall('action', { animationId: play.dataset.play })); return; }
    const lib = ev.target.closest('[data-lib]');
    if (lib && !state.busy) { void withBusy(() => pluginCall('select', { id: lib.dataset.lib })); }
  });

  for (const btn of $$('[data-toggle]')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      const next = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', next ? 'true' : 'false');
      void withBusy(() => pluginCall('settings', { [key]: next }));
    });
  }

  const scale = $('[data-setting="scale"]');
  scale.addEventListener('input', () => {
    $('[data-scale-readout]').textContent = `${Math.round(Number(scale.value) * 100)}%`;
  });
  scale.addEventListener('change', () => void withBusy(() => pluginCall('settings', { scale: Number(scale.value) })));

  const ttl = $('[data-setting="bubbleTtlMs"]');
  ttl.addEventListener('change', () => void withBusy(() => pluginCall('settings', { bubbleTtlMs: Number(ttl.value) })));

  const moreBtn = $('[data-import-more]');
  moreBtn.addEventListener('click', () => {
    const extra = $('[data-import-extra]');
    extra.hidden = !extra.hidden;
    moreBtn.textContent = extra.hidden ? 'Add author / license' : 'Fewer details';
  });

  // The panel runs in a Host iframe sandboxed `allow-scripts` only, which
  // blocks native form submission, so the button (and Enter) drives the import
  // directly. The <form> stays for grouping and labelling only.
  async function runImport() {
    const source = $('[data-import-source]').value.trim();
    const errBox = $('[data-import-error]');
    errBox.hidden = true;
    if (!source) {
      errBox.textContent = 'Enter a package path or a public page URL.';
      errBox.hidden = false;
      $('[data-import-source]').focus();
      return;
    }
    const args = { source };
    const author = $('[data-import-author]').value.trim();
    const license = $('[data-import-license]').value.trim();
    if (author) args.author = author;
    if (license) args.license = license;
    setBusy(true);
    try {
      const r = await pluginCall('import', args);
      if (r?.state) render(r.state);
      $('[data-import-source]').value = '';
      $('[data-import-author]').value = '';
      $('[data-import-license]').value = '';
    } catch (error) {
      // Keep the user's input in place so they can correct and retry.
      errBox.textContent = errorText(error);
      errBox.hidden = false;
    } finally {
      setBusy(false);
    }
  }

  $('[data-import-submit]').addEventListener('click', () => void runImport());
  $('[data-import-form]').addEventListener('submit', (ev) => { ev.preventDefault(); void runImport(); });
  for (const input of $$('[data-import-form] input')) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); void runImport(); }
    });
  }
}

// ------------------------------------------------------------------ boot ----

function boot() {
  state.stage = new PetStage($('[data-preview]'));
  // A descriptor can arrive before its sheet does; when the decode lands,
  // repaint the stage without waiting for the next 2s poll.
  state.stage.onNeedSprite = () => { setTimeout(() => void state.stage.load(state.snapshot), 120); };
  wire();
  setInterval(refresh, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // Host posts init before or after our first state call; neither is required.
  refresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
