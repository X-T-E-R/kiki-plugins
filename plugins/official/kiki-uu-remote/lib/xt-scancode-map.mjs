import { keysyms } from '../vendor/rfb2/dist/keysyms.js';

/**
 * Authoritative AT Set-1 / QEMU RFB Extended Key Event scancode + X11 keysym mapping
 * derived from QEMU keycodemapdb (MIT / GPL-2.0+).
 *
 * Standard AT Set-1 make codes occupy 0x01..0x7f.
 * Extended 0xe0 xx keys use the QEMU RFB Extended Key Event encoding `0x80 | xx`.
 */

const SHIFT_LEFT_KEY = Object.freeze({
  name: 'shift',
  keysym: keysyms.ShiftLeft,
  xtScancode: 0x2a,
  isModifier: true,
});

const KEY_DEFS = [
  // Modifiers
  { aliases: ['shift', 'lshift', 'shift_l', 'shiftleft'], name: 'shift', keysym: keysyms.ShiftLeft, xtScancode: 0x2a, isModifier: true },
  { aliases: ['rshift', 'shift_r', 'shiftright'], name: 'rshift', keysym: keysyms.ShiftRight, xtScancode: 0x36, isModifier: true },
  { aliases: ['ctrl', 'control', 'lctrl', 'ctrl_l', 'controlleft'], name: 'ctrl', keysym: keysyms.ControlLeft, xtScancode: 0x1d, isModifier: true },
  { aliases: ['rctrl', 'ctrl_r', 'controlright'], name: 'rctrl', keysym: keysyms.ControlRight, xtScancode: 0x9d, isModifier: true },
  { aliases: ['alt', 'lalt', 'alt_l', 'altleft', 'option'], name: 'alt', keysym: keysyms.AltLeft, xtScancode: 0x38, isModifier: true },
  { aliases: ['ralt', 'alt_r', 'altright', 'altgr'], name: 'ralt', keysym: keysyms.AltRight, xtScancode: 0xb8, isModifier: true },
  { aliases: ['win', 'lwin', 'meta', 'meta_l', 'super', 'super_l', 'superleft', 'cmd', 'command'], name: 'win', keysym: keysyms.SuperLeft, xtScancode: 0xdb, isModifier: true },
  { aliases: ['rwin', 'meta_r', 'super_r', 'superright'], name: 'rwin', keysym: keysyms.SuperRight, xtScancode: 0xdc, isModifier: true },

  // Control & whitespace keys
  { aliases: ['esc', 'escape'], name: 'esc', keysym: keysyms.Escape, xtScancode: 0x01, isModifier: false },
  { aliases: ['backspace', 'bksp'], name: 'backspace', keysym: keysyms.BackSpace, xtScancode: 0x0e, isModifier: false },
  { aliases: ['tab'], name: 'tab', keysym: keysyms.Tab, xtScancode: 0x0f, isModifier: false },
  { aliases: ['enter', 'return', 'ret'], name: 'enter', keysym: keysyms.Return, xtScancode: 0x1c, isModifier: false },
  { aliases: ['space', 'spacebar', 'spc'], name: 'space', keysym: keysyms.Space, xtScancode: 0x39, isModifier: false },
  { aliases: ['capslock', 'caps_lock'], name: 'capslock', keysym: keysyms.CapsLock, xtScancode: 0x3a, isModifier: false },
  { aliases: ['numlock', 'num_lock'], name: 'numlock', keysym: keysyms.NumLock, xtScancode: 0x45, isModifier: false },
  { aliases: ['scrolllock', 'scroll_lock'], name: 'scrolllock', keysym: keysyms.ScrollLock, xtScancode: 0x46, isModifier: false },

  // Navigation & extended keys (0xe0 xx -> 0x80 | xx)
  { aliases: ['home'], name: 'home', keysym: keysyms.Home, xtScancode: 0xc7, isModifier: false },
  { aliases: ['up', 'arrowup'], name: 'up', keysym: keysyms.Up, xtScancode: 0xc8, isModifier: false },
  { aliases: ['pageup', 'pgup'], name: 'pageup', keysym: keysyms.PageUp, xtScancode: 0xc9, isModifier: false },
  { aliases: ['left', 'arrowleft'], name: 'left', keysym: keysyms.Left, xtScancode: 0xcb, isModifier: false },
  { aliases: ['right', 'arrowright'], name: 'right', keysym: keysyms.Right, xtScancode: 0xcd, isModifier: false },
  { aliases: ['end'], name: 'end', keysym: keysyms.End, xtScancode: 0xcf, isModifier: false },
  { aliases: ['down', 'arrowdown'], name: 'down', keysym: keysyms.Down, xtScancode: 0xd0, isModifier: false },
  { aliases: ['pagedown', 'pgdn'], name: 'pagedown', keysym: keysyms.PageDown, xtScancode: 0xd1, isModifier: false },
  { aliases: ['insert', 'ins'], name: 'insert', keysym: keysyms.Insert, xtScancode: 0xd2, isModifier: false },
  { aliases: ['delete', 'del'], name: 'delete', keysym: keysyms.Delete, xtScancode: 0xd3, isModifier: false },

  // System & application keys
  { aliases: ['printscreen', 'prtsc', 'print'], name: 'printscreen', keysym: keysyms.Print, xtScancode: 0xb7, isModifier: false },
  { aliases: ['sysrq'], name: 'sysrq', keysym: 0xff15, xtScancode: 0x54, isModifier: false },
  { aliases: ['pause', 'break'], name: 'pause', keysym: keysyms.Pause, xtScancode: 0xc6, isModifier: false },
  { aliases: ['menu', 'apps', 'contextmenu', 'compose'], name: 'menu', keysym: keysyms.Menu, xtScancode: 0xdd, isModifier: false },

  // Function keys F1-F12
  { aliases: ['f1'], name: 'f1', keysym: keysyms.F1, xtScancode: 0x3b, isModifier: false },
  { aliases: ['f2'], name: 'f2', keysym: keysyms.F2, xtScancode: 0x3c, isModifier: false },
  { aliases: ['f3'], name: 'f3', keysym: keysyms.F3, xtScancode: 0x3d, isModifier: false },
  { aliases: ['f4'], name: 'f4', keysym: keysyms.F4, xtScancode: 0x3e, isModifier: false },
  { aliases: ['f5'], name: 'f5', keysym: keysyms.F5, xtScancode: 0x3f, isModifier: false },
  { aliases: ['f6'], name: 'f6', keysym: keysyms.F6, xtScancode: 0x40, isModifier: false },
  { aliases: ['f7'], name: 'f7', keysym: keysyms.F7, xtScancode: 0x41, isModifier: false },
  { aliases: ['f8'], name: 'f8', keysym: keysyms.F8, xtScancode: 0x42, isModifier: false },
  { aliases: ['f9'], name: 'f9', keysym: keysyms.F9, xtScancode: 0x43, isModifier: false },
  { aliases: ['f10'], name: 'f10', keysym: keysyms.F10, xtScancode: 0x44, isModifier: false },
  { aliases: ['f11'], name: 'f11', keysym: keysyms.F11, xtScancode: 0x57, isModifier: false },
  { aliases: ['f12'], name: 'f12', keysym: keysyms.F12, xtScancode: 0x58, isModifier: false },

  // Digits row
  { aliases: ['1'], name: '1', keysym: 0x31, xtScancode: 0x02, isModifier: false },
  { aliases: ['2'], name: '2', keysym: 0x32, xtScancode: 0x03, isModifier: false },
  { aliases: ['3'], name: '3', keysym: 0x33, xtScancode: 0x04, isModifier: false },
  { aliases: ['4'], name: '4', keysym: 0x34, xtScancode: 0x05, isModifier: false },
  { aliases: ['5'], name: '5', keysym: 0x35, xtScancode: 0x06, isModifier: false },
  { aliases: ['6'], name: '6', keysym: 0x36, xtScancode: 0x07, isModifier: false },
  { aliases: ['7'], name: '7', keysym: 0x37, xtScancode: 0x08, isModifier: false },
  { aliases: ['8'], name: '8', keysym: 0x38, xtScancode: 0x09, isModifier: false },
  { aliases: ['9'], name: '9', keysym: 0x39, xtScancode: 0x0a, isModifier: false },
  { aliases: ['0'], name: '0', keysym: 0x30, xtScancode: 0x0b, isModifier: false },

  // Letters QWERTY (AT Set-1 physical scan codes)
  { aliases: ['q'], name: 'q', keysym: 0x71, xtScancode: 0x10, isModifier: false },
  { aliases: ['w'], name: 'w', keysym: 0x77, xtScancode: 0x11, isModifier: false },
  { aliases: ['e'], name: 'e', keysym: 0x65, xtScancode: 0x12, isModifier: false },
  { aliases: ['r'], name: 'r', keysym: 0x72, xtScancode: 0x13, isModifier: false },
  { aliases: ['t'], name: 't', keysym: 0x74, xtScancode: 0x14, isModifier: false },
  { aliases: ['y'], name: 'y', keysym: 0x79, xtScancode: 0x15, isModifier: false },
  { aliases: ['u'], name: 'u', keysym: 0x75, xtScancode: 0x16, isModifier: false },
  { aliases: ['i'], name: 'i', keysym: 0x69, xtScancode: 0x17, isModifier: false },
  { aliases: ['o'], name: 'o', keysym: 0x6f, xtScancode: 0x18, isModifier: false },
  { aliases: ['p'], name: 'p', keysym: 0x70, xtScancode: 0x19, isModifier: false },
  { aliases: ['a'], name: 'a', keysym: 0x61, xtScancode: 0x1e, isModifier: false },
  { aliases: ['s'], name: 's', keysym: 0x73, xtScancode: 0x1f, isModifier: false },
  { aliases: ['d'], name: 'd', keysym: 0x64, xtScancode: 0x20, isModifier: false },
  { aliases: ['f'], name: 'f', keysym: 0x66, xtScancode: 0x21, isModifier: false },
  { aliases: ['g'], name: 'g', keysym: 0x67, xtScancode: 0x22, isModifier: false },
  { aliases: ['h'], name: 'h', keysym: 0x68, xtScancode: 0x23, isModifier: false },
  { aliases: ['j'], name: 'j', keysym: 0x6a, xtScancode: 0x24, isModifier: false },
  { aliases: ['k'], name: 'k', keysym: 0x6b, xtScancode: 0x25, isModifier: false },
  { aliases: ['l'], name: 'l', keysym: 0x6c, xtScancode: 0x26, isModifier: false },
  { aliases: ['z'], name: 'z', keysym: 0x7a, xtScancode: 0x2c, isModifier: false },
  { aliases: ['x'], name: 'x', keysym: 0x78, xtScancode: 0x2d, isModifier: false },
  { aliases: ['c'], name: 'c', keysym: 0x63, xtScancode: 0x2e, isModifier: false },
  { aliases: ['v'], name: 'v', keysym: 0x76, xtScancode: 0x2f, isModifier: false },
  { aliases: ['b'], name: 'b', keysym: 0x62, xtScancode: 0x30, isModifier: false },
  { aliases: ['n'], name: 'n', keysym: 0x6e, xtScancode: 0x31, isModifier: false },
  { aliases: ['m'], name: 'm', keysym: 0x6d, xtScancode: 0x32, isModifier: false },

  // Unshifted punctuation symbols
  { aliases: ['-', 'minus'], name: 'minus', keysym: 0x2d, xtScancode: 0x0c, isModifier: false },
  { aliases: ['=', 'equal'], name: 'equal', keysym: 0x3d, xtScancode: 0x0d, isModifier: false },
  { aliases: ['[', 'bracketleft', 'bracket_left'], name: 'bracket_left', keysym: 0x5b, xtScancode: 0x1a, isModifier: false },
  { aliases: [']', 'bracketright', 'bracket_right'], name: 'bracket_right', keysym: 0x5d, xtScancode: 0x1b, isModifier: false },
  { aliases: [';', 'semicolon'], name: 'semicolon', keysym: 0x3b, xtScancode: 0x27, isModifier: false },
  { aliases: ["'", 'quote', 'apostrophe'], name: 'apostrophe', keysym: 0x27, xtScancode: 0x28, isModifier: false },
  { aliases: ['`', 'backquote', 'grave', 'grave_accent'], name: 'grave_accent', keysym: 0x60, xtScancode: 0x29, isModifier: false },
  { aliases: ['\\', 'backslash'], name: 'backslash', keysym: 0x5c, xtScancode: 0x2b, isModifier: false },
  { aliases: [',', 'comma'], name: 'comma', keysym: 0x2c, xtScancode: 0x33, isModifier: false },
  { aliases: ['.', 'period', 'dot'], name: 'dot', keysym: 0x2e, xtScancode: 0x34, isModifier: false },
  { aliases: ['/', 'slash'], name: 'slash', keysym: 0x2f, xtScancode: 0x35, isModifier: false },

  // Keypad keys
  { aliases: ['kp_0', 'numpad0'], name: 'kp_0', keysym: keysyms.Keypad0, xtScancode: 0x52, isModifier: false },
  { aliases: ['kp_1', 'numpad1'], name: 'kp_1', keysym: keysyms.Keypad1, xtScancode: 0x4f, isModifier: false },
  { aliases: ['kp_2', 'numpad2'], name: 'kp_2', keysym: keysyms.Keypad2, xtScancode: 0x50, isModifier: false },
  { aliases: ['kp_3', 'numpad3'], name: 'kp_3', keysym: keysyms.Keypad3, xtScancode: 0x51, isModifier: false },
  { aliases: ['kp_4', 'numpad4'], name: 'kp_4', keysym: keysyms.Keypad4, xtScancode: 0x4b, isModifier: false },
  { aliases: ['kp_5', 'numpad5'], name: 'kp_5', keysym: keysyms.Keypad5, xtScancode: 0x4c, isModifier: false },
  { aliases: ['kp_6', 'numpad6'], name: 'kp_6', keysym: keysyms.Keypad6, xtScancode: 0x4d, isModifier: false },
  { aliases: ['kp_7', 'numpad7'], name: 'kp_7', keysym: keysyms.Keypad7, xtScancode: 0x47, isModifier: false },
  { aliases: ['kp_8', 'numpad8'], name: 'kp_8', keysym: keysyms.Keypad8, xtScancode: 0x48, isModifier: false },
  { aliases: ['kp_9', 'numpad9'], name: 'kp_9', keysym: keysyms.Keypad9, xtScancode: 0x49, isModifier: false },
  { aliases: ['kp_multiply', 'numpadmultiply'], name: 'kp_multiply', keysym: keysyms.KeypadMultiply, xtScancode: 0x37, isModifier: false },
  { aliases: ['kp_subtract', 'numpadsubtract'], name: 'kp_subtract', keysym: keysyms.KeypadSubtract, xtScancode: 0x4a, isModifier: false },
  { aliases: ['kp_add', 'numpadadd'], name: 'kp_add', keysym: keysyms.KeypadAdd, xtScancode: 0x4e, isModifier: false },
  { aliases: ['kp_decimal', 'numpaddecimal'], name: 'kp_decimal', keysym: keysyms.KeypadDecimal, xtScancode: 0x53, isModifier: false },
  { aliases: ['kp_enter', 'numpadenter'], name: 'kp_enter', keysym: keysyms.KeypadEnter, xtScancode: 0x9c, isModifier: false },
  { aliases: ['kp_divide', 'numpaddivide'], name: 'kp_divide', keysym: keysyms.KeypadDivide, xtScancode: 0xb5, isModifier: false },
];

export const RFB_KEY_BY_NAME = new Map();
for (const def of KEY_DEFS) {
  const entry = Object.freeze({
    name: def.name,
    keysym: def.keysym,
    xtScancode: def.xtScancode,
    isModifier: def.isModifier,
  });
  for (const alias of def.aliases) {
    RFB_KEY_BY_NAME.set(alias, entry);
  }
}

export const ALL_MODIFIER_RFB_KEYS = Object.freeze([
  RFB_KEY_BY_NAME.get('shift'),
  RFB_KEY_BY_NAME.get('rshift'),
  RFB_KEY_BY_NAME.get('ctrl'),
  RFB_KEY_BY_NAME.get('rctrl'),
  RFB_KEY_BY_NAME.get('alt'),
  RFB_KEY_BY_NAME.get('ralt'),
  RFB_KEY_BY_NAME.get('win'),
  RFB_KEY_BY_NAME.get('rwin'),
]);

// Complete US-layout shifted ASCII symbols mapped to their physical AT Set-1 scancode
const SHIFTED_SYMBOL_TO_BASE = new Map([
  ['!', 0x02], // Shift + 1
  ['@', 0x03], // Shift + 2
  ['#', 0x04], // Shift + 3
  ['$', 0x05], // Shift + 4
  ['%', 0x06], // Shift + 5
  ['^', 0x07], // Shift + 6
  ['&', 0x08], // Shift + 7
  ['*', 0x09], // Shift + 8
  ['(', 0x0a], // Shift + 9
  [')', 0x0b], // Shift + 0
  ['_', 0x0c], // Shift + -
  ['+', 0x0d], // Shift + =
  ['{', 0x1a], // Shift + [
  ['}', 0x1b], // Shift + ]
  [':', 0x27], // Shift + ;
  ['"', 0x28], // Shift + '
  ['~', 0x29], // Shift + `
  ['|', 0x2b], // Shift + \
  ['<', 0x33], // Shift + ,
  ['>', 0x34], // Shift + .
  ['?', 0x35], // Shift + /
]);

const UNSHIFTED_SYMBOL_TO_SCANCODE = new Map([
  [' ', 0x39],
  ['-', 0x0c],
  ['=', 0x0d],
  ['[', 0x1a],
  [']', 0x1b],
  [';', 0x27],
  ["'", 0x28],
  ['`', 0x29],
  ['\\', 0x2b],
  [',', 0x33],
  ['.', 0x34],
  ['/', 0x35],
]);

export function createUnicodeUnsupportedError(detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  return Object.assign(
    new Error(
      `Unicode / non-ASCII input is unsupported on this RFB target without ExtendedClipboard or Guest Agent${suffix}.`,
    ),
    { code: 'unicode_input_unsupported' },
  );
}

/**
 * Returns true if every character in `text` is a supported ASCII character for direct XT keystrokes.
 */
export function isAsciiOnlyText(text) {
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x08) continue;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Map a single ASCII character to { keysym, xtScancode, shift }.
 * Throws a structured error with code='unicode_input_unsupported' for non-ASCII characters.
 */
export function asciiCharToRfbKey(ch) {
  const s = String(ch ?? '');
  if (s.length === 0) {
    throw new Error('asciiCharToRfbKey requires a non-empty character.');
  }
  const cp = s.codePointAt(0);
  if (cp === 0x0a || cp === 0x0d) {
    return { keysym: keysyms.Return, xtScancode: 0x1c, shift: false };
  }
  if (cp === 0x09) {
    return { keysym: keysyms.Tab, xtScancode: 0x0f, shift: false };
  }
  if (cp === 0x08) {
    return { keysym: keysyms.BackSpace, xtScancode: 0x0e, shift: false };
  }
  if (cp < 0x20 || cp > 0x7e) {
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    throw createUnicodeUnsupportedError(`character "${s[0]}" (U+${hex})`);
  }

  if (cp >= 0x61 && cp <= 0x7a) {
    const entry = RFB_KEY_BY_NAME.get(s[0]);
    return { keysym: cp, xtScancode: entry.xtScancode, shift: false };
  }
  if (cp >= 0x41 && cp <= 0x5a) {
    const lowerEntry = RFB_KEY_BY_NAME.get(s[0].toLowerCase());
    return { keysym: cp, xtScancode: lowerEntry.xtScancode, shift: true };
  }
  if (cp >= 0x30 && cp <= 0x39) {
    const entry = RFB_KEY_BY_NAME.get(s[0]);
    return { keysym: cp, xtScancode: entry.xtScancode, shift: false };
  }
  if (UNSHIFTED_SYMBOL_TO_SCANCODE.has(s[0])) {
    return { keysym: cp, xtScancode: UNSHIFTED_SYMBOL_TO_SCANCODE.get(s[0]), shift: false };
  }
  if (SHIFTED_SYMBOL_TO_BASE.has(s[0])) {
    return { keysym: cp, xtScancode: SHIFTED_SYMBOL_TO_BASE.get(s[0]), shift: true };
  }

  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  throw createUnicodeUnsupportedError(`character "${s[0]}" (U+${hex})`);
}

/**
 * Resolve a single key token into an array of RFB key entries (usually 1, or [shift, key] for shifted symbols like "+").
 */
export function resolveRfbKeyToken(token) {
  const raw = String(token ?? '').trim();
  if (!raw) {
    throw new Error('Empty RFB key token.');
  }
  const lower = raw.toLowerCase();
  if (lower === 'plus' || raw === '+') {
    return [
      SHIFT_LEFT_KEY,
      { name: 'plus', keysym: 0x2b, xtScancode: 0x0d, isModifier: false },
    ];
  }
  if (RFB_KEY_BY_NAME.has(lower)) {
    return [RFB_KEY_BY_NAME.get(lower)];
  }
  if (raw.length === 1 && SHIFTED_SYMBOL_TO_BASE.has(raw)) {
    return [
      SHIFT_LEFT_KEY,
      {
        name: raw,
        keysym: raw.charCodeAt(0),
        xtScancode: SHIFTED_SYMBOL_TO_BASE.get(raw),
        isModifier: false,
      },
    ];
  }
  if (raw.codePointAt(0) > 0x7e) {
    throw createUnicodeUnsupportedError(`key token "${raw}"`);
  }
  throw new Error(`Unsupported RFB key token: "${raw}"`);
}

/**
 * Normalize a key string (e.g. "Ctrl+Alt+Delete", "Win+R", "+") or token array into ordered RFB key descriptors
 * `{ name, keysym, xtScancode, isModifier }`.
 */
export function normalizeRfbKeyChord(keysOrKey) {
  let rawTokens;
  if (Array.isArray(keysOrKey)) {
    rawTokens = keysOrKey
      .flatMap((part) => {
        const s = String(part ?? '').trim();
        return s === '+' ? ['+'] : s.split('+');
      })
      .map((part) => part.trim())
      .filter(Boolean);
    if (rawTokens.length === 0) {
      throw new Error('RFB key chord array cannot be empty.');
    }
  } else {
    const str = String(keysOrKey ?? '').trim();
    if (!str) {
      throw new Error('RFB key chord string cannot be empty.');
    }
    if (str === '+') {
      rawTokens = ['+'];
    } else if (str.endsWith('++')) {
      const prefix = str.slice(0, -2).split('+').map((p) => p.trim()).filter(Boolean);
      rawTokens = [...prefix, '+'];
    } else {
      rawTokens = str.split('+').map((part) => part.trim()).filter(Boolean);
    }
    if (rawTokens.length === 0) {
      throw new Error(`Invalid RFB key chord: "${str}"`);
    }
  }

  const out = [];
  const seen = new Set();
  for (const tok of rawTokens) {
    for (const entry of resolveRfbKeyToken(tok)) {
      const dedupeKey = `${entry.xtScancode}:${entry.keysym}`;
      if (entry.isModifier) {
        if (seen.has(`mod:${entry.xtScancode}`)) continue;
        seen.add(`mod:${entry.xtScancode}`);
      } else if (seen.has(dedupeKey)) {
        continue;
      } else {
        seen.add(dedupeKey);
      }
      out.push(entry);
    }
  }
  return out;
}

export { SHIFT_LEFT_KEY };
