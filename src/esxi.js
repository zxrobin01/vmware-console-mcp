'use strict';
// ESXi / vCenter backend: host registry + govc (govmomi CLI) wrapper.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.ESXI_HOSTS_FILE || path.join(ROOT, 'config', 'esxi-hosts.json');
const DEFAULT_TIMEOUT = 60000;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function loadHosts() {
  try { const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); return j && j.hosts ? j.hosts : {}; }
  catch (e) { return {}; }
}
function saveHosts(hosts) {
  ensureDir(path.dirname(CONFIG_PATH));
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, hosts }, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}
function resolvePassword(h) {
  if (h.password_env && process.env[h.password_env]) return process.env[h.password_env];
  return h.password || '';
}
function normalizeUrl(host) {
  const h = String(host || '').trim();
  if (/^https?:\/\//i.test(h)) return h;
  return 'https://' + h;
}
function publicHost(h) {
  return {
    alias: h.alias, host: h.host, user: h.user, insecure: h.insecure !== false,
    datacenter: h.datacenter || null, password_set: !!resolvePassword(h),
    password_source: h.password_env ? ('env:' + h.password_env) : (h.password ? 'file' : null), note: h.note || null
  };
}
function listHosts() { return Object.values(loadHosts()).map(publicHost); }
function getHost(alias) {
  const hosts = loadHosts();
  const h = hosts[alias];
  if (!h) throw new Error('unknown ESXi host alias: ' + alias + '. Call esxi_hosts to list hosts or esxi_add_host to add one.');
  return h;
}
function addHost(h) {
  if (!h.alias || !/^[A-Za-z0-9_.-]+$/.test(h.alias)) throw new Error('alias must contain only letters, digits, _ . -');
  if (!h.host) throw new Error('host is required (IP or hostname)');
  if (!h.user) throw new Error('user is required');
  const hosts = loadHosts();
  hosts[h.alias] = {
    alias: h.alias, host: String(h.host).trim(), user: h.user,
    password: h.password || '', password_env: h.password_env || undefined,
    insecure: h.insecure !== false, datacenter: h.datacenter || undefined, note: h.note || undefined
  };
  saveHosts(hosts);
  return publicHost(hosts[h.alias]);
}
function removeHost(alias) {
  const hosts = loadHosts();
  if (!hosts[alias]) return false;
  delete hosts[alias];
  saveHosts(hosts);
  return true;
}
function govcPath() {
  if (process.env.GOVC_PATH) return process.env.GOVC_PATH;
  const local = path.join(ROOT, 'tools', process.platform === 'win32' ? 'govc.exe' : 'govc');
  if (fs.existsSync(local)) return local;
  return 'govc';
}
function govc(host, args, opts) {
  const o = opts || {};
  const h = typeof host === 'string' ? getHost(host) : host;
  const env = Object.assign({}, process.env, {
    GOVC_URL: normalizeUrl(h.host),
    GOVC_USERNAME: h.user,
    GOVC_PASSWORD: resolvePassword(h),
    GOVC_INSECURE: h.insecure === false ? '0' : '1',
    GOVC_PERSIST_SESSION: '0'
  });
  if (h.datacenter) env.GOVC_DATACENTER = h.datacenter; else delete env.GOVC_DATACENTER;
  delete env.GOVC_SESSION;
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(govcPath(), args, { env, windowsHide: true, timeout: o.timeoutMs || DEFAULT_TIMEOUT, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        timedOut: !!(err && (err.killed || err.signal)),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        elapsedMs: Date.now() - started,
        command: 'govc ' + args.map((a) => /^([A-Za-z0-9+/=_-]{20,})$/.test(String(a)) ? '***' : a).join(' ')
      });
    });
  });
}
function pickVMs(data) {
  if (!data) return [];
  return data.virtualMachines || data.VirtualMachines || [];
}
function parseJson(r) {
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'govc failed'), command: r.command, exitCode: r.exitCode, timedOut: r.timedOut };
  try { return { ok: true, data: JSON.parse(r.stdout), command: r.command }; }
  catch (e) { return { ok: false, error: 'cannot parse govc JSON: ' + e.message, stdout: r.stdout.slice(0, 400), command: r.command }; }
}

async function about(alias) { return govc(alias, ['about'], { timeoutMs: 30000 }); }
async function hostInfo(alias) {
  const first = await govc(alias, ['host.info', '-json'], { timeoutMs: 60000 });
  if (first.ok) return first;
  if (/multiple instances|specify/i.test((first.stderr || '') + (first.stdout || ''))) {
    const hp = await resolveHostPath(alias);
    if (hp) return govc(alias, ['host.info', '-json', '-host', hp], { timeoutMs: 60000 });
  }
  return first;
}
async function vmInfo(alias, vm) { return parseJson(await govc(alias, ['vm.info', '-json', String(vm)], { timeoutMs: 90000 })); }
async function vmInfoMany(alias, vms) {
  const out = [];
  const chunk = 25;
  for (let i = 0; i < vms.length; i += chunk) {
    const part = vms.slice(i, i + chunk);
    const r = parseJson(await govc(alias, ['vm.info', '-json'].concat(part), { timeoutMs: 180000 }));
    if (!r.ok) return { ok: false, error: r.error, done: out };
    out.push.apply(out, pickVMs(r.data));
  }
  return { ok: true, vms: out };
}
async function findVMs(alias) {
  const r = await govc(alias, ['find', '/', '-type', 'm'], { timeoutMs: 120000 });
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'govc find failed'), command: r.command };
  return { ok: true, vms: r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), command: r.command };
}
async function power(alias, vm, action, opts) {
  const o = opts || {};
  const map = {
    start: ['-on'],
    stop: o.mode === 'hard' ? ['-off'] : ['-s'],
    reset: ['-reset'],
    reboot: ['-r'],
    suspend: ['-suspend'],
    pause: ['-suspend']
  };
  const flags = map[action];
  if (!flags) throw new Error('invalid power action: ' + action + ' (start|stop|reset|reboot|suspend)');
  return govc(alias, ['vm.power'].concat(flags, [String(vm)]), { timeoutMs: 300000 });
}
async function snapshot(alias, vm, action, name) {
  const v = String(vm);
  switch (action) {
    case 'list': return govc(alias, ['snapshot.tree', '-vm', v], { timeoutMs: 60000 });
    case 'create': return govc(alias, ['snapshot.create', '-vm', v, String(name)], { timeoutMs: 600000 });
    case 'revert': return govc(alias, ['snapshot.revert', '-vm', v, String(name)], { timeoutMs: 600000 });
    case 'remove': return govc(alias, ['snapshot.remove', '-vm', v, '-r', String(name)], { timeoutMs: 600000 });
    default: throw new Error('invalid snapshot action: ' + action);
  }
}
async function clone(alias, source, dest, opts) {
  const o = opts || {};
  const args = ['vm.clone', '-vm', String(source)];
  if (o.datastore) args.push('-ds', o.datastore);
  if (o.snapshot) args.push('-snapshot', o.snapshot);
  if (o.pool) args.push('-pool', o.pool);
  args.push('-on=' + (o.power_on ? 'true' : 'false'));
  args.push(String(dest));
  return govc(alias, args, { timeoutMs: 900000 });
}
async function createVM(alias, opts) {
  const o = opts || {};
  const args = ['vm.create'];
  if (o.memory_mb) args.push('-m', String(o.memory_mb));
  if (o.cpus) args.push('-c', String(o.cpus));
  if (o.guest_id) args.push('-g', o.guest_id);
  if (o.datastore) args.push('-ds', o.datastore);
  if (o.network) args.push('-net', o.network);
  if (o.iso) args.push('-iso', o.iso);
  if (o.disk_size) args.push('-disk', o.disk_size);
  if (o.firmware) args.push('-firmware', o.firmware);
  args.push('-on=' + (o.power_on ? 'true' : 'false'));
  args.push(String(o.name));
  return govc(alias, args, { timeoutMs: 900000 });
}
async function destroy(alias, vm) { return govc(alias, ['vm.destroy', String(vm)], { timeoutMs: 300000 }); }
async function registerVM(alias, vmxPath, name) {
  const args = ['vm.register'];
  if (name) args.push('-name', name);
  args.push(String(vmxPath));
  return govc(alias, args, { timeoutMs: 300000 });
}
function parseDsPath(p) {
  const s = String(p === undefined || p === null ? '' : p);
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(s);
  if (m) return { ds: m[1], rel: m[2] || '' };
  return { ds: null, rel: s };
}
const defaultDsCache = {};
async function defaultDatastore(alias) {
  if (defaultDsCache[alias]) return defaultDsCache[alias];
  const r = await govc(alias, ['find', '/', '-type', 's'], { timeoutMs: 60000 });
  if (!r.ok) return null;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return null;
  defaultDsCache[alias] = first.split('/').pop();
  return defaultDsCache[alias];
}
async function dsArgs(alias, dsPath) {
  const p = parseDsPath(dsPath);
  let ds = p.ds;
  if (!ds) ds = await defaultDatastore(alias);
  const rel = p.rel || '.';
  return { ds, rel };
}
async function datastoreLs(alias, dsPath) {
  const { ds, rel } = await dsArgs(alias, dsPath === undefined ? '/' : dsPath);
  const args = ['datastore.ls'];
  if (ds) args.push('-ds', ds);
  args.push('-l', rel);
  return govc(alias, args, { timeoutMs: 120000 });
}
async function datastoreUpload(alias, localPath, remotePath) {
  const { ds, rel } = await dsArgs(alias, remotePath);
  const args = ['datastore.upload'];
  if (ds) args.push('-ds', ds);
  args.push(String(localPath), rel);
  return govc(alias, args, { timeoutMs: 1800000 });
}
async function datastoreDownload(alias, remotePath, localPath) {
  const { ds, rel } = await dsArgs(alias, remotePath);
  const args = ['datastore.download'];
  if (ds) args.push('-ds', ds);
  args.push(rel, String(localPath));
  return govc(alias, args, { timeoutMs: 1800000 });
}
async function datastoreInfo(alias) { return govc(alias, ['datastore.info', '-json'], { timeoutMs: 60000 }); }
async function datastoreMkdir(alias, dsPath) {
  const { ds, rel } = await dsArgs(alias, dsPath);
  const args = ['datastore.mkdir'];
  if (ds) args.push('-ds', ds);
  args.push(rel);
  return govc(alias, args, { timeoutMs: 60000 });
}
async function datastoreRm(alias, dsPath) {
  const { ds, rel } = await dsArgs(alias, dsPath);
  const args = ['datastore.rm'];
  if (ds) args.push('-ds', ds);
  args.push(rel);
  return govc(alias, args, { timeoutMs: 60000 });
}

function guestAuth(o) {
  const args = [];
  if (o.user) args.push('-l', o.user + ':' + (o.password === undefined ? '' : o.password));
  return args;
}
async function guestRun(alias, vm, o) {
  const args = ['guest.run', '-vm', String(vm)].concat(guestAuth(o));
  args.push(String(o.program));
  for (const a of (o.args || [])) args.push(String(a));
  return govc(alias, args, { timeoutMs: o.timeoutMs || 300000 });
}
async function guestPs(alias, vm, o) { return govc(alias, ['guest.ps', '-vm', String(vm), '-e=true', '-json'].concat(guestAuth(o)), { timeoutMs: 120000 }); }
async function guestKill(alias, vm, o) {
  const args = ['guest.kill', '-vm', String(vm)].concat(guestAuth(o));
  if (o.pid !== undefined) args.push('-p', String(o.pid));
  return govc(alias, args, { timeoutMs: 120000 });
}
async function guestLs(alias, vm, o) { return govc(alias, ['guest.ls', '-vm', String(vm)].concat(guestAuth(o), [String(o.path)]), { timeoutMs: 120000 }); }
async function guestMkdir(alias, vm, o) { return govc(alias, ['guest.mkdir', '-vm', String(vm), '-p=true'].concat(guestAuth(o), [String(o.path)]), { timeoutMs: 120000 }); }
async function guestUpload(alias, vm, o) { return govc(alias, ['guest.upload', '-vm', String(vm), '-f=true'].concat(guestAuth(o), [String(o.localPath), String(o.remotePath)]), { timeoutMs: 1800000 }); }
async function guestDownload(alias, vm, o) { return govc(alias, ['guest.download', '-vm', String(vm), '-f=true'].concat(guestAuth(o), [String(o.remotePath), String(o.localPath)]), { timeoutMs: 1800000 }); }

async function consoleCapture(alias, vm, outPath) {
  return govc(alias, ['vm.console', '-capture', String(outPath), String(vm)], { timeoutMs: 120000 });
}
async function keystrokes(alias, vm, o) {
  const args = ['vm.keystrokes', '-vm', String(vm)];
  if (o.text !== undefined) args.push('-s', String(o.text));
  if (o.codes) args.push('-c', o.codes);
  if (o.raw !== undefined) args.push('-r', String(o.raw));
  for (const k of Object.keys(o.modifiers || {})) if (o.modifiers[k]) args.push(k + '=true');
  return govc(alias, args, { timeoutMs: 60000 });
}
async function vncQuery(alias, vm) { return govc(alias, ['vm.vnc', String(vm)], { timeoutMs: 60000 }); }
async function vncEnable(alias, vm, o) {
  const args = ['vm.vnc', '-enable'];
  if (o.port) args.push('-port', String(o.port));
  if (o.password !== undefined) args.push('-password', String(o.password));
  args.push(String(vm));
  return govc(alias, args, { timeoutMs: 120000 });
}
async function vncDisable(alias, vm) { return govc(alias, ['vm.vnc', '-disable', String(vm)], { timeoutMs: 120000 }); }

const hostPathCache = {};
async function resolveHostPath(alias) {
  if (hostPathCache[alias]) return hostPathCache[alias];
  const r = await govc(alias, ['find', '/', '-type', 'h'], { timeoutMs: 60000 });
  if (!r.ok) return null;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (first) hostPathCache[alias] = first;
  return first || null;
}
async function esxcli(alias, argv, opts) {
  const o = opts || {};
  const hp = await resolveHostPath(alias);
  const args = ['host.esxcli'];
  if (hp) args.push('-host', hp);
  args.push.apply(args, argv);
  return govc(alias, args, { timeoutMs: o.timeoutMs || 60000 });
}
async function firewallRules(alias) { return esxcli(alias, ['network', 'firewall', 'ruleset', 'list']); }
async function firewallEnable(alias, ruleset) { return esxcli(alias, ['network', 'firewall', 'ruleset', 'set', '--enabled', 'true', '--ruleset-id', String(ruleset)]); }

module.exports = {
  CONFIG_PATH, loadHosts, saveHosts, listHosts, getHost, addHost, removeHost, publicHost,
  govcPath, govc, pickVMs, about, hostInfo, vmInfo, vmInfoMany, findVMs, power, snapshot,
  clone, createVM, destroy, registerVM, datastoreLs, datastoreUpload, datastoreDownload, datastoreInfo, datastoreMkdir, datastoreRm,
  guestRun, guestPs, guestKill, guestLs, guestMkdir, guestUpload, guestDownload,
  consoleCapture, keystrokes, vncQuery, vncEnable, vncDisable, esxcli, resolveHostPath, firewallRules, firewallEnable
};