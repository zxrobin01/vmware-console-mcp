'use strict';
// Minimal RFB (VNC) client tuned for VMware's built-in VNC server.
// Supports: security None, VNC Authentication (DES), raw encoding, 32bpp BGRX.
// Provides: frame capture (accumulated across tiles), pointer/key events, text.
const net = require('net');
const crypto = require('crypto');
const { encryptChallenge } = require('./des');

const RAW = 0;

class RfbError extends Error {
  constructor(msg, code) { super(msg); this.name = 'RfbError'; this.code = code || 'rfb_error'; }
}

class RfbClient {
  constructor(opts) {
    this.host = (opts && opts.host) || '127.0.0.1';
    this.port = Number((opts && opts.port) || 5900);
    this.password = (opts && opts.password) || '';
    this.connectTimeoutMs = (opts && opts.connectTimeoutMs) || 5000;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = true;
    this.width = 0;
    this.height = 0;
    this.name = '';
    this.pixelFormat = null;
    this.version = null;
    this.securityType = null;
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this._pump();
  }
  _onClose() {
    this.closed = true;
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) { clearTimeout(w.timer); w.reject(new RfbError('connection closed', 'closed')); }
  }
  _pump() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      const b = this.buf.slice(0, w.n);
      this.buf = this.buf.slice(w.n);
      w.resolve(b);
    }
  }
  read(n, timeoutMs) {
    if (this.closed && this.buf.length < n) return Promise.reject(new RfbError('connection closed', 'closed'));
    if (this.buf.length >= n) {
      const b = this.buf.slice(0, n); this.buf = this.buf.slice(n); return Promise.resolve(b);
    }
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject, timer: null };
      if (timeoutMs) {
        w.timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new RfbError('read timeout after ' + timeoutMs + 'ms', 'timeout'));
        }, timeoutMs);
      }
      this.waiters.push(w);
    });
  }
  write(buf) { if (this.closed) throw new RfbError('connection closed', 'closed'); this.sock.write(buf); }

  async connect() {
    await new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      const timer = setTimeout(() => { s.destroy(); reject(new RfbError('connect timeout', 'connect_timeout')); }, this.connectTimeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(); });
      s.once('error', (e) => { clearTimeout(timer); reject(new RfbError('connect failed: ' + e.message, 'connect_error')); });
      this.sock = s;
    });
    this.closed = false;
    this.sock.on('data', d => this._onData(d));
    this.sock.on('close', () => this._onClose());
    this.sock.on('error', () => this._onClose());
    await this._handshake();
  }

  async _handshake() {
    const banner = (await this.read(12, 4000)).toString('latin1');
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
    if (!m) throw new RfbError('bad RFB banner: ' + JSON.stringify(banner), 'protocol');
    const serverMajor = Number(m[1]), serverMinor = Number(m[2]);
    this.version = serverMajor + '.' + serverMinor;
    const major = 3;
    const minor = serverMinor >= 8 ? 8 : (serverMinor >= 7 ? 7 : 3);
    this.write(Buffer.from('RFB 003.00' + minor + '\n', 'ascii'));

    let secType = 1;
    if (minor === 3) {
      const st = await this.read(4, 4000); secType = st.readUInt32BE(0);
    } else {
      const n = (await this.read(1, 4000))[0];
      if (n === 0) { const reason = await this.read(4, 2000); throw new RfbError('server refused connection: ' + reason.toString(), 'refused'); }
      const types = [...(await this.read(n, 4000))];
      if (types.includes(1)) secType = 1;
      else if (types.includes(2) && this.password) secType = 2;
      else throw new RfbError('no supported security type, server offers ' + JSON.stringify(types), 'no_auth');
      this.write(Buffer.from([secType]));
    }
    this.securityType = secType === 1 ? 'none' : (secType === 2 ? 'vnc' : 'unknown');

    if (secType === 2) {
      const challenge = await this.read(16, 4000);
      this.write(encryptChallenge(this.password, challenge));
      const res = await this.read(4, 4000);
      if (res.readUInt32BE(0) !== 0) throw new RfbError('VNC authentication failed (wrong password?)', 'auth_failed');
    } else if (secType === 1) {
      // VMware sends a non-standard 4-byte SecurityResult even for None.
      try {
        const res = await this.read(4, 800);
        if (res.readUInt32BE(0) !== 0) throw new RfbError('security result failure', 'auth_failed');
      } catch (e) {
        if (e.code !== 'timeout') throw e;
      }
    } else {
      throw new RfbError('unsupported security type ' + secType, 'no_auth');
    }

    this.write(Buffer.from([1])); // ClientInit, shared desktop

    const si = await this.read(24, 5000);
    this.width = si.readUInt16BE(0);
    this.height = si.readUInt16BE(2);
    this.pixelFormat = {
      bpp: si[4], depth: si[5], bigEndian: si[6], trueColor: si[7],
      redMax: si.readUInt16BE(8), greenMax: si.readUInt16BE(10), blueMax: si.readUInt16BE(12),
      redShift: si[14], greenShift: si[15], blueShift: si[16]
    };
    const nameLen = si.readUInt32BE(20);
    if (nameLen > 0 && nameLen < 4096) this.name = (await this.read(nameLen, 2000)).toString('utf8');
    else this.name = '';

    // Ask for 32bpp little-endian BGRX (same layout we decode as BGRA).
    const sp = Buffer.alloc(20);
    sp[0] = 0; // message-type SetPixelFormat
    sp[4] = 32; sp[5] = 24; sp[6] = 0; sp[7] = 1;
    sp.writeUInt16BE(255, 8); sp.writeUInt16BE(255, 10); sp.writeUInt16BE(255, 12);
    sp[14] = 16; sp[15] = 8; sp[16] = 0;
    this.write(sp);
    // SetEncodings: only raw
    const enc = Buffer.alloc(8);
    enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(RAW, 4);
    this.write(enc);
  }

  _requestFrame(incremental) {
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(0, 2); b.writeUInt16BE(0, 4);
    b.writeUInt16BE(this.width, 6); b.writeUInt16BE(this.height, 8);
    this.write(b);
  }

  async _readMessage(frame, cells, cellW, opts) {
    const hdr = await this.read(1, opts.timeoutMs);
    const type = hdr[0];
    if (type === 0) {
      const rest = await this.read(3, opts.timeoutMs);
      const nrect = rest.readUInt16BE(1);
      let processed = 0;
      for (let i = 0; i < nrect; i++) {
        const r = await this.read(12, opts.timeoutMs);
        const x = r.readUInt16BE(0), y = r.readUInt16BE(2), w = r.readUInt16BE(4), h = r.readUInt16BE(6);
        const enc = r.readInt32BE(8);
        if (enc === RAW) {
          const bytes = w * h * 4;
          const data = await this.read(bytes, Math.max(opts.timeoutMs, bytes / 64));
          for (let row = 0; row < h; row++) {
            const dst = ((y + row) * this.width + x) * 4;
            data.copy(frame, dst, row * w * 4, row * w * 4 + w * 4);
          }
          this._mark(cells, cellW, x, y, w, h);
          processed++;
        } else if (enc === -223 || enc === 0xFFFFFF21) {
          // desktop size pseudo-encoding: update geometry
          this.width = w; this.height = h;
        } else {
          throw new RfbError('unsupported rectangle encoding ' + enc, 'encoding');
        }
      }
      return processed > 0;
    }
    if (type === 1) { // SetColourMapEntries
      const rest = await this.read(5, opts.timeoutMs);
      const n = rest.readUInt16BE(3);
      if (n > 0) await this.read(6 * n, opts.timeoutMs);
      return false;
    }
    if (type === 2) return false; // Bell
    if (type === 3) { // ServerCutText
      const lenBuf = await this.read(7, opts.timeoutMs);
      const len = lenBuf.readUInt32BE(3);
      if (len > 0) await this.read(len, opts.timeoutMs);
      return false;
    }
    throw new RfbError('unknown server message type ' + type, 'protocol');
  }

  _cellIndex(cells, cellW, cellH, cx, cy) { return cy * cellW + cx; }
  _mark(cells, cellW, x, y, w, h) {
    const cellSize = 32;
    const cellH = Math.ceil(this.height / cellSize);
    const x0 = Math.floor(x / cellSize), x1 = Math.floor((x + w - 1) / cellSize);
    const y0 = Math.floor(y / cellSize), y1 = Math.floor((y + h - 1) / cellSize);
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= cellH) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cx >= cellW) continue;
        cells[cy * cellW + cx] = 1;
      }
    }
  }

  async capture(opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 4000;
    const cellSize = 32;
    const cellW = Math.ceil(this.width / cellSize), cellH = Math.ceil(this.height / cellSize);
    const frame = Buffer.alloc(this.width * this.height * 4);
    const cells = new Uint8Array(cellW * cellH);
    const deadline = Date.now() + timeoutMs;
    let updates = 0;
    this._requestFrame(false);
    while (Date.now() < deadline) {
      const remaining = Math.max(250, Math.min(1200, deadline - Date.now()));
      try {
        const got = await this._readMessage(frame, cells, cellW, { timeoutMs: remaining });
        if (got) updates++;
        let covered = 0;
        for (let i = 0; i < cells.length; i++) if (cells[i]) covered++;
        if (covered >= cells.length * 0.995) break;
        if (got) this._requestFrame(false);
      } catch (e) {
        if (e.code !== 'timeout') throw e;
        if (updates > 0) break;
        this._requestFrame(false);
      }
    }
    let covered = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]) covered++;
    return { frame, width: this.width, height: this.height, name: this.name, updates, coverage: covered / cells.length };
  }

  pointer(x, y, mask) {
    const b = Buffer.alloc(6);
    b[0] = 5; b[1] = mask & 0x07;
    b.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(x))), 2);
    b.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(y))), 4);
    this.write(b);
  }
  keyEvent(keysym, down) {
    const b = Buffer.alloc(8);
    b[0] = 4; b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.write(b);
  }
}

module.exports = { RfbClient, RfbError };
