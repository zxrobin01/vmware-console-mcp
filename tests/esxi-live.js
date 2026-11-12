'use strict';
// Live ESXi validation. Usage:
//   node tests/esxi-live.js <alias> [--vm <name>] [--screenshot] [--keys]
// The host must already be registered (esxi_add_host) or provided via env.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const t = require('../src/tools.js');
const alias = process.argv[2];
const has = (f) => process.argv.includes(f);
const argVal = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const vm = argVal('--vm');
const text = (r) => ((r && r.content) || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
const json = (r) => { try { return JSON.parse(text(r)); } catch (e) { return null; } };
let fails = 0;
function check(name, cond, detail) {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail).slice(0, 300) : ''));
}
(async () => {
  if (!alias) { console.error('usage: node tests/esxi-live.js <alias> [--vm name] [--screenshot] [--keys]'); process.exit(2); }
  const test = json(await t.callTool('esxi_test_host', { alias }));
  check('esxi_test_host', test && test.ok === true, test && (test.about || test.error));
  const hi = json(await t.callTool('esxi_host_info', { alias }));
  check('esxi_host_info', hi && hi.ok === true, hi && (hi.version || hi.name || hi.error));
  const list = json(await t.callTool('esxi_vm_list', { alias }));
  const vms = list && list.hosts && list.hosts[0] && list.hosts[0].vms || [];
  check('esxi_vm_list', list && list.ok === true, 'VMs=' + vms.length);
  for (const v of vms.slice(0, 8)) console.log('  - ' + v.name + ' [' + v.power + '] ' + (v.guest || ''));
  const ds = text(await t.callTool('esxi_datastore_ls', { alias, path: '/' }));
  check('esxi_datastore_ls', ds.length > 0, ds.replace(/\s+/g, ' ').slice(0, 120));
  if (vm) {
    const info = json(await t.callTool('esxi_vm_info', { alias, vm }));
    check('esxi_vm_info(' + vm + ')', info && info.ok === true, info && (info.summary && (info.summary.power + ' ' + info.summary.guest) || info.error));
    if (has('--screenshot')) {
      const shot = await t.callTool('esxi_console_screenshot', { alias, vm, save_path: path.join(ROOT, 'demo', 'esxi-live-' + alias + '.png') });
      const img = (shot.content || []).find((x) => x.type === 'image');
      const meta = json(shot);
      check('esxi_console_screenshot', !!img, meta && (meta.bytes + 'B ' + (meta.source || '') || meta.hint || meta.error));
      if (img) fs.mkdirSync(path.join(ROOT, 'demo'), { recursive: true });
    }
    if (has('--keys')) {
      const k = json(await t.callTool('esxi_console_key', { alias, vm, keys: 'enter' }));
      check('esxi_console_key(enter)', k !== null, JSON.stringify(k).slice(0, 200));
    }
  }
  console.log('RESULT ' + (fails === 0 ? 'OK' : 'FAIL(' + fails + ')'));
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('LIVE ERR ' + (e && e.stack ? e.stack : e)); process.exit(1); });
