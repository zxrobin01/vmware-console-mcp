'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  'C:/Program Files (x86)/VMware/VMware Workstation/vmrun.exe',
  'C:/Program Files/VMware/VMware Workstation/vmrun.exe',
  'C:/Program Files (x86)/VMware/VMware Player/vmrun.exe',
  'C:/Program Files/VMware/VMware Player/vmrun.exe'
];

let cached = null;

function detect() {
  if (cached) return cached;
  const envPath = process.env.VMWARE_VMRUN;
  let exe = null;
  if (envPath && fs.existsSync(envPath)) exe = envPath;
  if (!exe) {
    for (const c of CANDIDATES) {
      if (fs.existsSync(c)) { exe = c; break; }
    }
  }
  if (!exe) throw new Error('vmrun.exe not found. Install VMware Workstation/Player or set VMWARE_VMRUN.');
  const isWorkstation = /Workstation/i.test(exe);
  const hostType = process.env.VMRUN_HOST_TYPE || (isWorkstation ? 'ws' : 'player');
  cached = { exe, hostType };
  return cached;
}

function normalize(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }

function execVmrun(args, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 30000;
  const { exe, hostType } = detect();
  const base = [];
  if (!o.noHostType) base.push('-T', hostType);
  if (o.user) base.push('-gu', o.user);
  if (o.password) base.push('-gp', o.password);
  if (process.env.VMWARE_VM_PASSWORD) base.push('-vp', process.env.VMWARE_VM_PASSWORD);
  const full = base.concat(args);
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(exe, full, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errtxt = String(stderr || '');
      let exitCode = 0;
      if (err) exitCode = typeof err.code === 'number' ? err.code : 1;
      const killed = !!(err && (err.killed || err.signal));
      const timedOut = killed;
      let parsed = null;
      const m = /Exit code:\s*(-?\d+)/i.exec(out);
      if (m) parsed = Number(m[1]);
      resolve({
        ok: !err && (parsed === null || parsed === 0),
        exitCode,
        timedOut,
        signal: err ? err.signal : null,
        stdout: out.trim(),
        stderr: errtxt.trim(),
        elapsedMs: Date.now() - started,
        command: 'vmrun ' + full.join(' ').replace(/-gp\s+\S+/, '-gp ***')
      });
    });
  });
}

function quote(a) { return a; }

async function list() {
  const r = await execVmrun(['list'], { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, error: r.stdout || r.stderr, running: [] };
  const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const totalLine = lines.find(l => /^Total running VMs:/i.test(l));
  const total = totalLine ? Number(totalLine.split(':')[1].trim()) : 0;
  const running = lines.filter(l => /\.vmx$/i.test(l));
  return { ok: true, total, running, stdout: r.stdout };
}

async function isRunning(vmxPath) {
  const l = await list();
  const target = normalize(vmxPath);
  return l.running.some(p => normalize(p) === target);
}

const power = {
  start: (vmx, opts) => execVmrun(['start', vmx, (opts && opts.gui) ? 'gui' : 'nogui'], { timeoutMs: 180000 }),
  stop: (vmx, opts) => execVmrun(['stop', vmx, (opts && opts.mode) || 'soft'], { timeoutMs: 120000 }),
  reset: (vmx, opts) => execVmrun(['reset', vmx, (opts && opts.mode) || 'soft'], { timeoutMs: 120000 }),
  suspend: (vmx, opts) => execVmrun(['suspend', vmx, (opts && opts.mode) || 'soft'], { timeoutMs: 120000 }),
  pause: (vmx) => execVmrun(['pause', vmx], { timeoutMs: 60000 }),
  unpause: (vmx) => execVmrun(['unpause', vmx], { timeoutMs: 60000 })
};

const snapshot = {
  list: (vmx, opts) => execVmrun(['listSnapshots', vmx].concat(opts && opts.showTree ? ['showTree'] : []), { timeoutMs: 30000 }),
  create: (vmx, name) => execVmrun(['snapshot', vmx, name], { timeoutMs: 180000 }),
  delete: (vmx, name, children) => execVmrun(['deleteSnapshot', vmx, name].concat(children ? ['andDeleteChildren'] : []), { timeoutMs: 180000 }),
  revert: (vmx, name) => execVmrun(['revertToSnapshot', vmx, name], { timeoutMs: 180000 })
};

function clone(vmx, dest, opts) {
  const args = ['clone', vmx, dest, (opts && opts.type) || 'full'];
  if (opts && opts.snapshot) args.push('-snapshot=' + opts.snapshot);
  if (opts && opts.name) args.push('-cloneName=' + opts.name);
  return execVmrun(args, { timeoutMs: 600000 });
}

function deleteVM(vmx) { return execVmrun(['deleteVM', vmx], { timeoutMs: 120000 }); }
function upgradeVM(vmx) { return execVmrun(['upgradevm', vmx], { timeoutMs: 120000 }); }
function checkToolsState(vmx) { return execVmrun(['checkToolsState', vmx], { timeoutMs: 30000 }); }
function getGuestIPAddress(vmx, wait) { return execVmrun(['getGuestIPAddress', vmx].concat(wait ? ['-wait'] : []), { timeoutMs: wait ? 120000 : 30000 }); }
function installTools(vmx) { return execVmrun(['installTools', vmx], { timeoutMs: 120000 }); }
function captureScreen(vmx, hostPath) { return execVmrun(['captureScreen', vmx, hostPath], { timeoutMs: 60000 }); }
function typeKeystrokesInGuest(vmx, text, creds) { return execVmrun(['typeKeystrokesInGuest', vmx, text], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }

function runProgramInGuest(vmx, program, args, creds) {
  const a = ['runProgramInGuest', vmx];
  if (creds && creds.noWait) a.push('-noWait');
  if (creds && creds.interactive) a.push('-interactive');
  if (creds && creds.activeWindow) a.push('-activeWindow');
  a.push(program);
  for (const x of (args || [])) a.push(String(x));
  return execVmrun(a, { timeoutMs: (creds && creds.timeoutMs) || 120000, user: creds && creds.user, password: creds && creds.password });
}

function runScriptInGuest(vmx, interpreter, script, creds) {
  const a = ['runScriptInGuest', vmx];
  if (creds && creds.noWait) a.push('-noWait');
  if (creds && creds.interactive) a.push('-interactive');
  if (creds && creds.activeWindow) a.push('-activeWindow');
  a.push(interpreter, script);
  return execVmrun(a, { timeoutMs: (creds && creds.timeoutMs) || 120000, user: creds && creds.user, password: creds && creds.password });
}

function listProcessesInGuest(vmx, creds) { return execVmrun(['listProcessesInGuest', vmx], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }
function killProcessInGuest(vmx, pid, creds) { return execVmrun(['killProcessInGuest', vmx, String(pid)], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }
function copyFileFromHostToGuest(vmx, hostPath, guestPath, creds) { return execVmrun(['CopyFileFromHostToGuest', vmx, hostPath, guestPath], { timeoutMs: (creds && creds.timeoutMs) || 180000, user: creds && creds.user, password: creds && creds.password }); }
function copyFileFromGuestToHost(vmx, guestPath, hostPath, creds) { return execVmrun(['CopyFileFromGuestToHost', vmx, guestPath, hostPath], { timeoutMs: (creds && creds.timeoutMs) || 180000, user: creds && creds.user, password: creds && creds.password }); }
function createDirectoryInGuest(vmx, guestPath, creds) { return execVmrun(['createDirectoryInGuest', vmx, guestPath], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }
function listDirectoryInGuest(vmx, guestPath, creds) { return execVmrun(['listDirectoryInGuest', vmx, guestPath], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }
function deleteFileInGuest(vmx, guestPath, creds) { return execVmrun(['deleteFileInGuest', vmx, guestPath], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }
function renameFileInGuest(vmx, from, to, creds) { return execVmrun(['renameFileInGuest', vmx, from, to], { timeoutMs: 60000, user: creds && creds.user, password: creds && creds.password }); }

module.exports = {
  detect, list, isRunning, power, snapshot, clone, deleteVM, upgradeVM,
  checkToolsState, getGuestIPAddress, installTools, captureScreen, typeKeystrokesInGuest,
  runProgramInGuest, runScriptInGuest, listProcessesInGuest, killProcessInGuest,
  copyFileFromHostToGuest, copyFileFromGuestToHost, createDirectoryInGuest,
  listDirectoryInGuest, deleteFileInGuest, renameFileInGuest, execVmrun
};