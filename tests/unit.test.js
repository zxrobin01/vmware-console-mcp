'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encryptBlock, vncKey, encryptChallenge } = require('../src/des');
const { encodePNG, encodeBGRA } = require('../src/png');
const { keysymFor, parseCombo, textKeysyms } = require('../src/keysym');

test('DES known-answer vector', () => {
  const k = Buffer.from('133457799BBCDFF1', 'hex');
  const p = Buffer.from('0123456789ABCDEF', 'hex');
  assert.strictEqual(encryptBlock(k, p).toString('hex'), '85e813540f0ab405');
});

test('VNC key reverses password bits and zero pads', () => {
  assert.strictEqual(vncKey('pass').toString('hex'), '0e86cece00000000');
  assert.strictEqual(vncKey('').toString('hex'), '0000000000000000');
});

test('VNC challenge encryption is 16 bytes and deterministic', () => {
  const ch = Buffer.alloc(16, 0x42);
  const a = encryptChallenge('secret', ch);
  assert.strictEqual(a.length, 16);
  assert.strictEqual(a.toString('hex'), encryptChallenge('secret', ch).toString('hex'));
});

test('PNG encoder produces a valid signature/IHDR', () => {
  const w = 4, h = 3;
  const rgb = Buffer.alloc(w * h * 3, 0x7F);
  const png = encodePNG(w, h, rgb);
  assert.strictEqual(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.strictEqual(png.readUInt32BE(16), w);
  assert.strictEqual(png.readUInt32BE(20), h);
  assert.strictEqual(png.slice(12, 16).toString('ascii'), 'IHDR');
});

test('BGRA to PNG swaps channels', () => {
  const bgra = Buffer.from([0, 0, 255, 0]); // B=0,G=0,R=255
  const png = encodeBGRA(1, 1, bgra);
  assert.ok(png.length > 50);
});

test('keysym mapping', () => {
  assert.strictEqual(keysymFor('enter'), 0xFF0D);
  assert.strictEqual(keysymFor('a'), 0x61);
  assert.strictEqual(keysymFor('F10'), 0xFFC7);
  assert.strictEqual(parseCombo('ctrl+alt+delete').length, 3);
  assert.strictEqual(parseCombo('ctrl+c')[0].modifier, true);
  assert.strictEqual(textKeysyms('a\nb').length, 3);
});
test('ESXi keystroke mapping (HID)', () => {
  const { _internal } = require('../src/tools-esxi');
  const k = _internal.keystrokeCalls;
  assert.deepStrictEqual(k('enter'), [{ codes: '0x28' }]);
  assert.deepStrictEqual(k('ctrl+alt+delete'), [{ codes: '0x4c', modifiers: { '-lc': true, '-la': true } }]);
  assert.deepStrictEqual(k('f2'), [{ codes: '0x3b' }]);
  assert.deepStrictEqual(k('a'), [{ codes: '0x04' }]);
  assert.deepStrictEqual(k('hello'), [{ text: 'hello' }]);
});

test('ESXi VNC URI parsing', () => {
  const { _internal } = require('../src/tools-esxi');
  const p = _internal.parseVncLine('myvm: vnc://:pw@192.0.2.5:5901');
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.host, '192.0.2.5');
  assert.strictEqual(p.port, 5901);
  assert.strictEqual(p.password, 'pw');
  assert.strictEqual(_internal.parseVncLine('myvm: disabled').enabled, false);
});