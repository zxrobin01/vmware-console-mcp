'use strict';
// X11 keysyms used by RFB KeyEvent. Printable Latin-1 characters map to their
// own code point; everything else is looked up here. Unicode text uses the
// 0x01000000 | codepoint form (accepted by most servers; VMware supports it).

const SPECIAL = {
  enter: 0xFF0D, return: 0xFF0D, tab: 0xFF09, esc: 0xFF1B, escape: 0xFF1B,
  backspace: 0xFF08, bs: 0xFF08, delete: 0xFFFF, del: 0xFFFF, insert: 0xFF63, ins: 0xFF63,
  home: 0xFF50, end: 0xFF57, pageup: 0xFF55, pgup: 0xFF55, pagedown: 0xFF56, pgdn: 0xFF56,
  up: 0xFF52, down: 0xFF54, left: 0xFF51, right: 0xFF53,
  space: 0x20, capslock: 0xFFE5, numlock: 0xFF7F, scrolllock: 0xFF14,
  printscreen: 0xFF61, prtsc: 0xFF61, pause: 0xFF13, menu: 0xFF67,
  minus: 0x2D, equal: 0x3D, comma: 0x2C, period: 0x2E, slash: 0x2F,
  backslash: 0x5C, semicolon: 0x3B, apostrophe: 0x27, quote: 0x27,
  grave: 0x60, bracketleft: 0x5B, bracketright: 0x5D,
  f1: 0xFFBE, f2: 0xFFBF, f3: 0xFFC0, f4: 0xFFC1, f5: 0xFFC2, f6: 0xFFC3,
  f7: 0xFFC4, f8: 0xFFC5, f9: 0xFFC6, f10: 0xFFC7, f11: 0xFFC8, f12: 0xFFC9,
  shift: 0xFFE1, lshift: 0xFFE1, rshift: 0xFFE2,
  ctrl: 0xFFE3, control: 0xFFE3, lctrl: 0xFFE3, rctrl: 0xFFE4,
  alt: 0xFFE9, lalt: 0xFFE9, ralt: 0xFFEA,
  meta: 0xFFEB, win: 0xFFEB, super: 0xFFEB, cmd: 0xFFEB,
};
const MODIFIERS = new Set(['shift', 'lshift', 'rshift', 'ctrl', 'control', 'lctrl', 'rctrl', 'alt', 'lalt', 'ralt', 'meta', 'win', 'super', 'cmd']);

function keysymFor(name) {
  const n = String(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SPECIAL, n)) return SPECIAL[n];
  if (n.length === 1) {
    const cp = n.codePointAt(0);
    if (cp < 0x100) return cp; // Latin-1: keysym == code point
    return 0x01000000 | cp;
  }
  throw new Error('unknown key name: ' + name);
}

function parseCombo(combo) {
  const parts = String(combo).split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('empty key combo');
  const seq = [];
  for (const p of parts) {
    const r = { name: p, keysym: keysymFor(p), modifier: MODIFIERS.has(p.toLowerCase()) };
    seq.push(r);
  }
  return seq;
}

// text -> array of { keysym, text? } ; "\n" means Enter
function textKeysyms(text) {
  const out = [];
  for (const ch of String(text)) {
    if (ch === '\n') { out.push({ keysym: 0xFF0D, ch: '\n' }); continue; }
    if (ch === '\t') { out.push({ keysym: 0xFF09, ch }); continue; }
    const cp = ch.codePointAt(0);
    out.push({ keysym: cp < 0x100 ? cp : (0x01000000 | cp), ch });
  }
  return out;
}

module.exports = { SPECIAL, keysymFor, parseCombo, textKeysyms, MODIFIERS };
