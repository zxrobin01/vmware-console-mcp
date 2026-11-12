'use strict';
// ESXi backend integration test against govmomi's vcsim (vSphere simulator).
// Requires tools/vcsim/vcsim.exe (downloaded from the govmomi release page).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const VCSIM = path.join(ROOT, 'tools', 'vcsim', process.platform === 'win32' ? 'vcsim.exe' : 'vcsim');
const HOSTS_FILE = path.join(ROOT, 'tmp', 'esxi-hosts.test.json');
process.env.ESXI_HOSTS_FILE = HOSTS_FILE;
const PORT = Number(process.env.VCSIM_PORT || 8989);
const ALIAS = 'sim';

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail).slice(0, 220) : ''));
}
function text(r) {
  const c = (r && r.content) || [];
  return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
}
function json(r) { try { return JSON.parse(text(r)); } catch (e) { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 500); });
    };
    attempt();
  });
}

(async () => {
  if (!fs.existsSync(VCSIM)) { console.error('vcsim not found: ' + VCSIM); process.exit(2); }
  fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
  try { fs.unlinkSync(HOSTS_FILE); } catch (e) {}
  const sim = spawn(VCSIM, ['-l', '127.0.0.1:' + PORT], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const simLog = [];
  sim.stdout.on('data', (d) => simLog.push(d.toString()));
  sim.stderr.on('data', (d) => simLog.push(d.toString()));
  const up = await waitPort(PORT, 30000);
  check('vcsim listening', up, up ? '127.0.0.1:' + PORT : simLog.join('').slice(-300));
  if (!up) { try { sim.kill(); } catch (e) {} process.exit(1); }

  const t = require('../src/tools.js');
  const call = (name, args) => t.callTool(name, args || {});

  const add = json(await call('esxi_add_host', { alias: ALIAS, host: '127.0.0.1:' + PORT, user: 'user', password: 'pass', insecure: true, test: true }));
  check('esxi_add_host validates via govc about', add && add.ok === true && add.validated === true, add && (add.about || add.error));

  const hosts = json(await call('esxi_hosts', {}));
  check('esxi_hosts lists registry', hosts && hosts.ok && hosts.hosts.some((h) => h.alias === ALIAS), hosts && JSON.stringify(hosts.hosts));

  const list = json(await call('esxi_vm_list', { alias: ALIAS }));
  const vms = list && list.hosts && list.hosts[0] && list.hosts[0].vms || [];
  check('esxi_vm_list returns simulated VMs', list && list.ok && vms.length > 0, 'count=' + vms.length + ' first=' + (vms[0] && vms[0].name));
  const vm = vms[0] && vms[0].name;
  check('vm has power state', !!(vms[0] && vms[0].power), vms[0] && vms[0].power);

  const info = json(await call('esxi_vm_info', { alias: ALIAS, vm }));
  check('esxi_vm_info', info && info.ok && info.summary && info.summary.name === vm, info && (info.error || info.summary));

  const snapCreate = json(await call('esxi_snapshot', { alias: ALIAS, vm, action: 'create', name: 'vcsim-snap' }));
  check('esxi_snapshot create', snapCreate && snapCreate.ok === true, snapCreate && (snapCreate.stderr || snapCreate.stdout));
  const snapList = text(await call('esxi_snapshot', { alias: ALIAS, vm, action: 'list' }));
  check('esxi_snapshot list', /vcsim-snap/.test(snapList), snapList.replace(/\s+/g, ' ').slice(0, 160));
  const snapRevert = json(await call('esxi_snapshot', { alias: ALIAS, vm, action: 'revert', name: 'vcsim-snap' }));
  check('esxi_snapshot revert', snapRevert && snapRevert.ok === true, snapRevert && (snapRevert.stderr || ''));
  const snapRemove = json(await call('esxi_snapshot', { alias: ALIAS, vm, action: 'remove', name: 'vcsim-snap' }));
  check('esxi_snapshot remove', snapRemove && snapRemove.ok === true, snapRemove && (snapRemove.stderr || ''));

  const st = json(await call('esxi_vm_power', { alias: ALIAS, vm: 'DC0_H0_VM1', action: 'stop', mode: 'hard' }));
  check('esxi_vm_power stop', st && st.ok === true, st && (st.stderr || st.stdout));
  const st2 = json(await call('esxi_vm_power', { alias: ALIAS, vm: 'DC0_H0_VM1', action: 'start' }));
  check('esxi_vm_power start', st2 && st2.ok === true, st2 && (st2.stderr || st2.stdout));

  const ds = text(await call('esxi_datastore_ls', { alias: ALIAS, path: '/' }));
  check('esxi_datastore_ls', ds.length > 0, ds.replace(/\s+/g, ' ').slice(0, 160));

  const hi = json(await call('esxi_host_info', { alias: ALIAS }));
  check('esxi_host_info', hi && hi.ok === true, hi && (hi.name || hi.raw && String(hi.raw).slice(0, 80) || hi.error));

  const vnc = json(await call('esxi_vnc', { alias: ALIAS, vm, action: 'status' }));
  check('esxi_vnc status', vnc && vnc.ok === true, vnc && vnc.raw);
  const vncEn = json(await call('esxi_vnc', { alias: ALIAS, vm, action: 'enable', port: 5901, password: 'vncpass' }));
  check('esxi_vnc enable', vncEn && vncEn.ok === true, vncEn && (vncEn.parsed || vncEn.raw || vncEn.error));

  const shot = await call('esxi_console_screenshot', { alias: ALIAS, vm });
  const shotJson = json(shot);
  check('esxi_console_screenshot fails gracefully on vcsim', shotJson && shotJson.ok === false, shotJson && (shotJson.hint || shotJson.error || shotJson.stderr));

  const key = json(await call('esxi_console_key', { alias: ALIAS, vm, keys: 'enter' }));
  check('esxi_console_key returns structured result (vcsim: unsupported is OK)', key !== null && (key.ok === true || /does not implement|PutUsbScanCodes|not supported/i.test(JSON.stringify(key))), key && JSON.stringify(key).slice(0, 160));

  const rm = json(await call('esxi_remove_host', { alias: ALIAS }));
  check('esxi_remove_host', rm && rm.ok === true, rm && rm.removed);

  try { sim.kill(); } catch (e) {}
  await sleep(500);
  console.log('RESULT ' + (failures === 0 ? 'OK' : 'FAIL(' + failures + ')'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('VCSIM TEST ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});