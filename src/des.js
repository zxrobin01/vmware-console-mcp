'use strict';
// Minimal DES (encrypt only) used for VNC authentication (RFB security type 2).
// VNC derives the DES key from the password: pad/truncate to 8 bytes, then
// reverse the bits of every byte (RFB 6143 section 7.2.2).

const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,
             63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
             41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
            57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
            36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,
           16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];

const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
];

function toBits(buf) {
  const bits = new Uint8Array(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (buf[i] >> (7 - j)) & 1;
  }
  return bits;
}
function fromBits(bits) {
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}
function permute(bits, table) {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i] - 1];
  return out;
}
function rotl(bits, n) {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[(i + n) % bits.length];
  return out;
}
function subkeys(keyBuf) {
  const k = permute(toBits(keyBuf), PC1);
  let C = k.slice(0, 28), D = k.slice(28);
  const keys = [];
  for (let r = 0; r < 16; r++) {
    C = rotl(C, SHIFTS[r]); D = rotl(D, SHIFTS[r]);
    const cd = new Uint8Array(56); cd.set(C, 0); cd.set(D, 28);
    keys.push(permute(cd, PC2));
  }
  return keys;
}
function feistel(R, K) {
  const ER = permute(R, E);
  const x = new Uint8Array(48);
  for (let i = 0; i < 48; i++) x[i] = ER[i] ^ K[i];
  const sOut = new Uint8Array(32);
  for (let b = 0; b < 8; b++) {
    const bits = x.slice(b * 6, b * 6 + 6);
    const row = (bits[0] << 1) | bits[5];
    const col = (bits[1] << 3) | (bits[2] << 2) | (bits[3] << 1) | bits[4];
    const v = SBOX[b][row * 16 + col];
    sOut[b * 4] = (v >> 3) & 1;
    sOut[b * 4 + 1] = (v >> 2) & 1;
    sOut[b * 4 + 2] = (v >> 1) & 1;
    sOut[b * 4 + 3] = v & 1;
  }
  return permute(sOut, P);
}
function encryptBlock(keyBuf, block) {
  const keys = subkeys(keyBuf);
  const bits = permute(toBits(block), IP);
  let L = bits.slice(0, 32), R = bits.slice(32);
  for (let r = 0; r < 16; r++) {
    const f = feistel(R, keys[r]);
    const newR = new Uint8Array(32);
    for (let i = 0; i < 32; i++) newR[i] = L[i] ^ f[i];
    L = R; R = newR;
  }
  const pre = new Uint8Array(64); pre.set(R, 0); pre.set(L, 32);
  return fromBits(permute(pre, FP));
}
function vncKey(password) {
  const p = Buffer.alloc(8, 0);
  Buffer.from(password || '', 'latin1').copy(p, 0, 0, Math.min(8, Buffer.from(password || '', 'latin1').length));
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    let b = p[i], r = 0;
    for (let j = 0; j < 8; j++) { r = (r << 1) | (b & 1); b >>= 1; }
    out[i] = r;
  }
  return out;
}
function encryptChallenge(password, challenge16) {
  const k = vncKey(password);
  const c = Buffer.from(challenge16);
  const a = encryptBlock(k, c.slice(0, 8));
  const b = encryptBlock(k, c.slice(8, 16));
  return Buffer.concat([a, b]);
}
module.exports = { encryptBlock, vncKey, encryptChallenge };
