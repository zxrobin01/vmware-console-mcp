'use strict';
const path = require('path');
const { RfbClient } = require('./rfb');
const { encodeBGRA } = require('./png');
const { keysymFor, parseCombo, textKeysyms } = require('./keysym');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class ConsoleManager {
  constructor(opts) {
    this.opts = opts || {};
    this.sessions = new Map();
    this.defaultTimeoutMs = this.opts.captureTimeoutMs || 4000;
  }
  _key(vmx) { return path.resolve(vmx).toLowerCase(); }

  async connect(vmx, cfg) {
    const key = this._key(vmx);
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) return existing;
    if (existing) this.sessions.delete(key);
    const client = new RfbClient({
      host: cfg.host || '127.0.0.1',
      port: cfg.port,
      password: cfg.password || '',
      connectTimeoutMs: cfg.connectTimeoutMs || 5000
    });
    await client.connect();
    this.sessions.set(key, client);
    return client;
  }

  get(vmx) { return this.sessions.get(this._key(vmx)) || null; }

  async close(vmx) {
    const key = this._key(vmx);
    const c = this.sessions.get(key);
    if (!c) return { closed: false, connected: false };
    try { c.sock.destroy(); } catch (e) { /* ignore */ }
    c.closed = true;
    this.sessions.delete(key);
    return { closed: true, connected: false };
  }

  async screenshot(vmx, cfg, opts) {
    const c = await this.connect(vmx, cfg);
    const timeoutMs = (opts && opts.timeoutMs) || this.defaultTimeoutMs;
    const cap = await c.capture({ timeoutMs });
    let frame = cap.frame, width = cap.width, height = cap.height, scale = 1;
    const maxWidth = opts && opts.maxWidth ? Number(opts.maxWidth) : 0;
    if (maxWidth && width > maxWidth) {
      const nw = Math.floor(maxWidth), nh = Math.max(1, Math.round(height * nw / width));
      const out = Buffer.alloc(nw * nh * 4);
      for (let y = 0; y < nh; y++) {
        const sy = Math.min(height - 1, Math.floor(y * height / nh));
        for (let x = 0; x < nw; x++) {
          const sx = Math.min(width - 1, Math.floor(x * width / nw));
          const si = (sy * width + sx) * 4, di = (y * nw + x) * 4;
          out[di] = frame[si]; out[di + 1] = frame[si + 1]; out[di + 2] = frame[si + 2]; out[di + 3] = 255;
        }
      }
      frame = out; width = nw; height = nh; scale = nw / cap.width;
    }
    const png = encodeBGRA(width, height, frame);
    return { png, width, height, native_width: cap.width, native_height: cap.height, scale, name: cap.name, updates: cap.updates, coverage: Number(cap.coverage.toFixed(4)), security: c.securityType, encoding: 'png' };
  }

  async mouse(vmx, cfg, args) {
    const c = await this.connect(vmx, cfg);
    const x = Number(args.x), y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required numbers');
    const action = (args.action || 'click').toLowerCase();
    const button = (args.button || 'left').toLowerCase();
    const masks = { left: 1, middle: 2, right: 4 };
    const mask = masks[button] !== undefined ? masks[button] : 1;
    const pause = args.delay_ms !== undefined ? Number(args.delay_ms) : 40;
    switch (action) {
      case 'move':
        c.pointer(x, y, 0); break;
      case 'click':
        c.pointer(x, y, 0); await sleep(pause);
        c.pointer(x, y, mask); await sleep(pause); c.pointer(x, y, 0); break;
      case 'dblclick':
        c.pointer(x, y, 0); await sleep(pause);
        for (let i = 0; i < 2; i++) { c.pointer(x, y, mask); await sleep(pause); c.pointer(x, y, 0); await sleep(pause); }
        break;
      case 'rightclick':
        c.pointer(x, y, 0); await sleep(pause); c.pointer(x, y, 4); await sleep(pause); c.pointer(x, y, 0); break;
      case 'down':
        c.pointer(x, y, mask); break;
      case 'up':
        c.pointer(x, y, 0); break;
      case 'scroll': {
        const amount = args.amount === undefined ? 3 : Number(args.amount);
        const dir = (args.direction || 'down').toLowerCase();
        const wheel = dir === 'up' ? 8 : 16;
        c.pointer(x, y, 0); await sleep(pause);
        for (let i = 0; i < Math.abs(amount); i++) { c.pointer(x, y, wheel); await sleep(15); c.pointer(x, y, 0); await sleep(15); }
        break;
      }
      default:
        throw new Error('unknown mouse action: ' + action);
    }
    return { ok: true, action, x, y, button };
  }

  async type(vmx, cfg, args) {
    const c = await this.connect(vmx, cfg);
    const text = String(args.text === undefined ? '' : args.text);
    const delayMs = args.delay_ms === undefined ? 12 : Number(args.delay_ms);
    if (!text) return { ok: true, typed: 0 };
    const keys = textKeysyms(text);
    for (const k of keys) {
      c.keyEvent(k.keysym, true);
      await sleep(delayMs);
      c.keyEvent(k.keysym, false);
      await sleep(delayMs);
    }
    if (args.enter) { c.keyEvent(0xFF0D, true); await sleep(delayMs); c.keyEvent(0xFF0D, false); }
    return { ok: true, typed: keys.length, enter: !!args.enter };
  }

  async key(vmx, cfg, args) {
    const c = await this.connect(vmx, cfg);
    const combos = Array.isArray(args.keys) ? args.keys : [String(args.keys || '')];
    let count = 0;
    for (const combo of combos) {
      const seq = parseCombo(combo);
      const modsDown = [];
      for (let i = 0; i < seq.length - 1; i++) if (seq[i].modifier) { c.keyEvent(seq[i].keysym, true); modsDown.push(seq[i].keysym); }
      const last = seq[seq.length - 1];
      c.keyEvent(last.keysym, true); await sleep(15);
      c.keyEvent(last.keysym, false);
      for (let i = modsDown.length - 1; i >= 0; i--) { c.keyEvent(modsDown[i], false); await sleep(10); }
      await sleep(30);
      count++;
    }
    return { ok: true, combos: count };
  }

  info(vmx) {
    const c = this.get(vmx);
    if (!c) return { connected: false };
    return { connected: !c.closed, width: c.width, height: c.height, name: c.name, security: c.securityType, version: c.version };
  }
}

module.exports = { ConsoleManager };