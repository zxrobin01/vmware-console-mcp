'use strict';
// End-to-end test against a throwaway blank VM:
// create VM -> vnc_enable -> start -> screenshot -> mouse/type/key -> screenshot -> stop -> cleanup.
// Usage: node tests/e2e.js [--password 8chars] [--port 5999]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp', 'e2e-vm');
const DEMO = path.join(ROOT, 'demo');
const VMX = path.join(TMP, 'e2e-probe.vmx');
const PORT = Number((process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 0) || 5999);
const PW = process.argv.includes('--password') ? process.argv[process.argv.indexOf('--password') + 1] : '';
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;
let failures = 0;

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + method)), 300000);
    pending.set(id, { resolve, reject, timer });
  });
}
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
    }
  }
});
if (process.env.VMWARE_MCP_DEBUG) child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));

const results = [];
function check(name, cond, detail) {
  if (!cond) failures++;
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}
function text(res) {
  const c = (res && res.content) || [];
  return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
}
async function call(name, args) {
  const res = await rpc('tools/call', { name, arguments: args || {} });
  if (res.error) throw new Error(name + ': ' + res.error.message);
  return res.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitPort(port, timeoutMs) {
  const net = require('net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
      setTimeout(() => { try { s.destroy(); } catch (e) {} resolve(false); }, 500);
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

const VMX_TEMPLATE = [
  '.encoding = "windows-1252"',
  'config.version = "8"',
  'virtualHW.version = "20"',
  'displayName = "e2e-probe"',
  'guestOS = "other"',
  'memsize = "256"',
  'numvcpus = "1"',
  'vmci0.present = "TRUE"',
  'floppy0.present = "FALSE"',
  'scsi0.present = "FALSE"',
  'ide0:0.present = "FALSE"',
  'ethernet0.present = "FALSE"',
  'usb.present = "FALSE"',
  'sound.present = "FALSE"',
  'svga.autodetect = "FALSE"',
  'svga.maxWidth = "1024"',
  'svga.maxHeight = "768"',
  ''
].join('\r\n');

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } });
  // preflight: remove leftovers from an aborted previous run
  if (fs.existsSync(VMX)) {
    try { await call('vm_power', { vmx: VMX, action: 'stop', mode: 'hard' }); } catch (e) { console.log('preflight stop: ' + e.message); }
  }
  if (fs.existsSync(TMP) && fs.existsSync(VMX)) {
    try { await call('vm_delete', { vmx: VMX, force: true }); } catch (e) { /* ignore */ }
  }
  await sleep(800);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(DEMO, { recursive: true });
  fs.writeFileSync(VMX, VMX_TEMPLATE, 'latin1');

  const en = await call('vnc_enable', { vmx: VMX, port: PORT, password: PW || undefined });
  const enText = text(en);
  check('vnc_enable', /"enabled": true/.test(enText), enText.split('\n').filter((l) => /port|enabled/.test(l)).join(' '));

  const st = await call('vm_power', { vmx: VMX, action: 'start', gui: false });
  const stText = text(st);
  check('vm_power start', /"ok": true/.test(stText), stText.match(/"vnc_ready": \w+/)?.[0] || '');
  check('vnc port listening', await waitPort(PORT, 45000), 'port ' + PORT);

  const info = await call('console_info', { vmx: VMX });
  const infoText = text(info);
  check('console_info', /"connected": true/.test(infoText), infoText.replace(/\s+/g, ' ').slice(0, 140));

  const shot1 = await call('console_screenshot', { vmx: VMX, save_path: path.join(DEMO, 'console-1.png') });
  const img1 = (shot1.content || []).find((x) => x.type === 'image');
  const meta1 = JSON.parse(text(shot1));
  check('console_screenshot', !!img1 && img1.data.length > 500, meta1.width + 'x' + meta1.height + ' coverage=' + meta1.coverage);
  fs.writeFileSync(path.join(DEMO, 'console-1.png'), Buffer.from(img1.data, 'base64'));

  const mv = await call('console_mouse', { vmx: VMX, action: 'move', x: 200, y: 150 });
  check('console_mouse move', /"ok": true/.test(text(mv)), '');
  const clk = await call('console_mouse', { vmx: VMX, action: 'click', x: 200, y: 150 });
  check('console_mouse click', /"ok": true/.test(text(clk)), '');
  const typ = await call('console_type', { vmx: VMX, text: 'hello vmware', enter: true });
  check('console_type', /"typed": 12/.test(text(typ)), '');
  const key = await call('console_key', { vmx: VMX, keys: 'ctrl+alt+delete' });
  check('console_key', /"ok": true/.test(text(key)), '');

  await sleep(600);
  const shot2 = await call('console_screenshot', { vmx: VMX, save_path: path.join(DEMO, 'console-2.png') });
  const img2 = (shot2.content || []).find((x) => x.type === 'image');
  const meta2 = JSON.parse(text(shot2));
  check('second screenshot', !!img2 && img2.data.length > 500, meta2.width + 'x' + meta2.height);
  fs.writeFileSync(path.join(DEMO, 'console-2.png'), Buffer.from(img2.data, 'base64'));

  const guestNoTools = await rpc('tools/call', { name: 'guest_run', arguments: { vmx: VMX, program: 'c:\\windows\\system32\\cmd.exe', args: ['/c', 'echo hi'], timeout_ms: 5000 } });
  const guestText = text(guestNoTools.result);
  check('guest_run without Tools fails fast with hint', guestNoTools.result.isError === true && /VMware Tools/i.test(guestText), guestText.replace(/\s+/g, ' ').slice(0, 140));

  const snap = await call('vm_snapshot', { vmx: VMX, action: 'list', show_tree: true });
  check('vm_snapshot list', !!(snap.content), text(snap).replace(/\s+/g, ' ').slice(0, 100));

  const lst = await call('vm_list', {});
  check('vm_list sees probe running', text(lst).includes('e2e-probe'), '');

  const stop = await call('vm_power', { vmx: VMX, action: 'stop', mode: 'hard' });
  check('vm_power stop', /"ok": true/.test(text(stop)), '');
  await sleep(1500);

  // cleanup: delete VM through the tool, then remove leftovers
  try { await call('vm_delete', { vmx: VMX, force: true }); } catch (e) { console.log('cleanup vm_delete: ' + e.message); }
  await sleep(1000);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('cleanup rm: ' + e.message); }
  check('cleanup', !fs.existsSync(TMP), !fs.existsSync(TMP) ? '' : 'tmp still exists');

  child.kill();
  console.log('RESULT ' + (failures === 0 ? 'OK' : 'FAIL(' + failures + ')'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('E2E ERROR: ' + (e && e.stack ? e.stack : e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  try { child.kill(); } catch (x) {}
  process.exit(1);
});