'use strict';
// Protocol-level smoke test: spawn the server, initialize, tools/list, and a
// couple of read-only calls. Usage: node tests/probe.js
const { spawn } = require('child_process');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;
const results = [];
let exitCode = 0;

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }
});
child.stderr.on('data', (d) => { if (process.env.VMWARE_MCP_DEBUG) process.stderr.write('[server] ' + d.toString()); });

function expect(name, cond, detail) {
  const ok = !!cond;
  if (!ok) exitCode = 1;
  results.push({ name, ok, detail: detail === undefined ? '' : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}
function textOf(res) {
  const c = res.result && res.result.content;
  if (!c || !c.length) return '';
  return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
}

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0' } });
  expect('initialize', init.result && init.result.serverInfo && init.result.serverInfo.name === 'vmware-console-mcp', init.result && init.result.serverInfo && init.result.serverInfo.version);
  const list = await rpc('tools/list', {});
  const names = (list.result && list.result.tools || []).map((t) => t.name);
  expect('tools/list', names.length >= 25, names.length + ' tools');
  expect('has console tools', ['console_screenshot', 'console_mouse', 'console_type', 'console_key'].every((n) => names.includes(n)), '');
  expect('has guest tools', ['guest_run', 'guest_processes', 'guest_copy_to'].every((n) => names.includes(n)), '');
  const vmList = await rpc('tools/call', { name: 'vm_list', arguments: {} });
  expect('vm_list call', !!(vmList.result && vmList.result.content), textOf(vmList).slice(0, 120));
  if (process.argv[2]) {
    const vmxPath = path.resolve(process.argv[2]);
    const info = await rpc('tools/call', { name: 'vm_info', arguments: { vmx: vmxPath } });
    expect('vm_info call', !!(info.result && info.result.content), textOf(info).slice(0, 300));
    const status = await rpc('tools/call', { name: 'vnc_status', arguments: { vmx: vmxPath } });
    expect('vnc_status call', !!(status.result && status.result.content), textOf(status).slice(0, 300));
  }
  child.kill();
  console.log('RESULT ' + (exitCode === 0 ? 'OK' : 'FAIL'));
  process.exit(exitCode);
})().catch((e) => { console.error('probe error: ' + e.message); try { child.kill(); } catch (x) {} process.exit(1); });
