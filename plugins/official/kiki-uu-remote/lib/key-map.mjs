const VK_BY_NAME = new Map([
  ['backspace', 0x08],
  ['bksp', 0x08],
  ['tab', 0x09],
  ['enter', 0x0d],
  ['return', 0x0d],
  ['shift', 0x10],
  ['lshift', 0xa0],
  ['rshift', 0xa1],
  ['ctrl', 0x11],
  ['control', 0x11],
  ['lctrl', 0xa2],
  ['rctrl', 0xa3],
  ['alt', 0x12],
  ['option', 0x12],
  ['menu', 0x12],
  ['lalt', 0xa4],
  ['ralt', 0xa5],
  ['pause', 0x13],
  ['capslock', 0x14],
  ['esc', 0x1b],
  ['escape', 0x1b],
  ['space', 0x20],
  ['spacebar', 0x20],
  ['pageup', 0x21],
  ['pgup', 0x21],
  ['pagedown', 0x22],
  ['pgdn', 0x22],
  ['end', 0x23],
  ['home', 0x24],
  ['left', 0x25],
  ['arrowleft', 0x25],
  ['up', 0x26],
  ['arrowup', 0x26],
  ['right', 0x27],
  ['arrowright', 0x27],
  ['down', 0x28],
  ['arrowdown', 0x28],
  ['printscreen', 0x2c],
  ['prtsc', 0x2c],
  ['insert', 0x2d],
  ['ins', 0x2d],
  ['delete', 0x2e],
  ['del', 0x2e],
  ['win', 0x5b],
  ['meta', 0x5b],
  ['super', 0x5b],
  ['command', 0x5b],
  ['cmd', 0x5b],
  ['lwin', 0x5b],
  ['rwin', 0x5c],
  ['apps', 0x5d],
  ['contextmenu', 0x5d],
  ['numlock', 0x90],
  ['scrolllock', 0x91],
  [';', 0xba],
  ['semicolon', 0xba],
  ['=', 0xbb],
  ['equal', 0xbb],
  ['plus', 0xbb],
  [',', 0xbc],
  ['comma', 0xbc],
  ['-', 0xbd],
  ['minus', 0xbd],
  ['.', 0xbe],
  ['period', 0xbe],
  ['/', 0xbf],
  ['slash', 0xbf],
  ['`', 0xc0],
  ['backquote', 0xc0],
  ['[', 0xdb],
  ['bracketleft', 0xdb],
  ['\\', 0xdc],
  ['backslash', 0xdc],
  [']', 0xdd],
  ['bracketright', 0xdd],
  ["'", 0xde],
  ['quote', 0xde],
]);

for (let i = 1; i <= 24; i += 1) {
  VK_BY_NAME.set(`f${i}`, 0x70 + (i - 1));
}

const MODIFIER_VKS = new Set([0x10, 0xa0, 0xa1, 0x11, 0xa2, 0xa3, 0x12, 0xa4, 0xa5, 0x5b, 0x5c]);
const CTRL_VKS = new Set([0x11, 0xa2, 0xa3]);
const ALT_VKS = new Set([0x12, 0xa4, 0xa5]);

const UU_RESERVED_CTRL_ALT_PRIMARY = new Set([
  0x0d, // Enter (toggle fullscreen)
  0x47, // G
  0x46, // F
  0x50, // P
  0x55, // U
  0x25, // Left
  0x27, // Right
]);

export function resolveVirtualKey(token) {
  const raw = String(token ?? '').trim();
  if (!raw) throw new Error('Empty key token.');
  const lower = raw.toLowerCase();
  if (VK_BY_NAME.has(lower)) {
    return { name: lower, vk: VK_BY_NAME.get(lower), isModifier: MODIFIER_VKS.has(VK_BY_NAME.get(lower)) };
  }
  if (/^[a-z]$/i.test(raw)) {
    const vk = raw.toUpperCase().charCodeAt(0);
    return { name: lower, vk, isModifier: false };
  }
  if (/^[0-9]$/.test(raw)) {
    const vk = raw.charCodeAt(0);
    return { name: raw, vk, isModifier: false };
  }
  throw new Error(`Unsupported key token: "${raw}"`);
}

export function normalizeKeyChordInput(keysOrKey) {
  if (Array.isArray(keysOrKey)) {
    const tokens = keysOrKey
      .flatMap((part) => String(part ?? '').split('+'))
      .map((part) => part.trim())
      .filter(Boolean);
    if (tokens.length === 0) throw new Error('Key chord array cannot be empty.');
    return tokens.map(resolveVirtualKey);
  }
  const str = String(keysOrKey ?? '').trim();
  if (!str) throw new Error('Key chord string cannot be empty.');
  if (str === '+') return [resolveVirtualKey('plus')];
  const tokens = str
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) throw new Error(`Invalid key chord: "${str}"`);
  return tokens.map(resolveVirtualKey);
}

export function checkUuClientHotkeyCollision(resolvedChord) {
  const hasCtrl = resolvedChord.some((k) => CTRL_VKS.has(k.vk));
  const hasAlt = resolvedChord.some((k) => ALT_VKS.has(k.vk));
  if (!hasCtrl || !hasAlt) {
    return { collides: false, reserved: false };
  }
  const nonMod = resolvedChord.filter((k) => !k.isModifier);
  const hitsKnown = nonMod.some((k) => UU_RESERVED_CTRL_ALT_PRIMARY.has(k.vk));
  return {
    collides: true,
    reserved: hitsKnown,
    reason: hitsKnown
      ? 'Ctrl+Alt+{Enter,G,F,P,U,Left,Right} triggers UU Remote local client overlay/fullscreen controls instead of the remote desktop.'
      : 'Ctrl+Alt+* chords are intercepted by UU Remote client shortcuts; pass allowClientHotkey=true only if intentional.',
  };
}

export function assertSafeRemoteKeyChord(keysOrKey, { allowClientHotkey = false } = {}) {
  const chord = normalizeKeyChordInput(keysOrKey);
  if (!allowClientHotkey) {
    const check = checkUuClientHotkeyCollision(chord);
    if (check.collides) {
      throw new Error(check.reason);
    }
  }
  return chord;
}
