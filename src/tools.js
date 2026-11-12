'use strict';
// Tool definitions and implementations for vmware-console-mcp.
const fs = require('fs');
const path = require('path');
const net = require('net');
const vmrun = require('./vmrun');
const vmx = require('./vmx');
const { ConsoleManager } = require('./console');
const { encodeBGRA } = require('./png');
const { ESXI_TOOLS, callEsxiTool } = require('./tools-esxi');

const consoleMgr = new ConsoleManager();

function log() {
  if (!process.env.VMWARE_MCP_DEBUG) return;
  const parts = [];
  for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
  process.stderr.write('[vmware-console-mcp] ' + parts.join(' ') + '\n');
}
function resolveVmx(p) {
  if (!p) throw new Error('vmx is required (absolute path to the .vmx file)');
  const abs = path.resolve(String(p));
  if (!/\.vmx$/i.test(abs)) throw new Error('not a .vmx file: ' + abs);
  if (!fs.existsSync(abs)) throw new Error('vmx not found: ' + abs);
  return abs;
}
function vncCfg(vmxPath) { return vmx.getVncConfig(vmxPath); }
function requireVnc(vmxPath) {
  const c = vncCfg(vmxPath);
  if (!c.enabled) throw new Error('VNC is not enabled for this VM. Call vnc_enable first (VM must be powered off), then start it with vm_power (gui=false).');
  if (!c.port) throw new Error('VNC is enabled but RemoteDisplay.vnc.port is missing. Re-run vnc_enable.');
  return c;
}
function guestCreds(a) {
  return {
    user: a.guest_user || process.env.VMWARE_GUEST_USER || undefined,
    password: a.guest_password || process.env.VMWARE_GUEST_PASSWORD || undefined
  };
}
async function ensureGuestTools(p) {
  const r = await vmrun.checkToolsState(p);
  const raw = ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
  const s = raw.toLowerCase();
  const state = (r.stdout || '').trim() || 'unknown';
  if (r.ok && /^(running|installed)/i.test(s)) return { state, ok: true };
  if (/not\s*installed|notinstalled/i.test(s)) {
    throw new Error('VMware Tools is NOT installed/running in this guest (state: ' + state + '). Guest operations need VMware Tools; use the console_* tools for pre-boot/login/GUI input.');
  }
  throw new Error('VMware Tools is not available/ready (checkToolsState: ' + state + '). Guest operations need VMware Tools running in a logged-in guest. Use console_* tools for boot/login/GUI input, or wait for the guest to boot and retry. Detail: ' + raw.slice(0, 200));
}

function portOpen(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port: Number(port), host: host || '127.0.0.1' });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    setTimeout(() => finish(false), 700);
  });
}
async function pickPort(preferred) {
  if (preferred) {
    const p = Number(preferred);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('port must be an integer between 1024 and 65535');
    return p;
  }
  for (let p = 5901; p <= 6001; p++) {
    if (!(await portOpen(p, '127.0.0.1'))) return p;
  }
  throw new Error('no free VNC port found in 5901-6001');
}
function sanitize(a) {
  const o = {};
  for (const k of Object.keys(a || {})) o[k] = /pass/i.test(k) ? '***' : a[k];
  return o;
}
function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function imageResult(png, meta) {
  return { content: [
    { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    { type: 'text', text: JSON.stringify(meta, null, 2) }
  ] };
}
function formatVmrun(r) {
  const out = { ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, elapsedMs: r.elapsedMs };
  if (r.stdout) out.stdout = r.stdout;
  if (r.stderr) out.stderr = r.stderr;
  if (r.timedOut) out.hint = 'vmrun timed out. Guest operations (guest_*) require VMware Tools installed and a logged-in guest; VM console operations do not.';
  return out;
}
function scaleFrame(frame, w, h, maxWidth) {
  if (!maxWidth || w <= maxWidth) return { frame, width: w, height: h, scale: 1 };
  const nw = Math.max(1, Math.floor(maxWidth));
  const nh = Math.max(1, Math.round(h * nw / w));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / nw));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = frame[si]; out[di + 1] = frame[si + 1]; out[di + 2] = frame[si + 2]; out[di + 3] = 255;
    }
  }
  return { frame: out, width: nw, height: nh, scale: nw / w };
}

const BASE_TOOLS = [
  {
    name: 'vm_list',
    description: 'List running VMware VMs (via vmrun list), with display name and VNC settings. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'vm_info',
    description: 'Show one VM: display name, guestOS, power state, VNC settings. Read-only.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string', description: 'Absolute path to the .vmx file' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'vm_power',
    description: 'Power operations: start/stop/reset/suspend/pause/unpause. For console automation start with gui=false (headless) and VNC enabled; a GUI start forces RemoteDisplay.vnc.enabled=FALSE.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        action: { type: 'string', enum: ['start', 'stop', 'reset', 'suspend', 'pause', 'unpause'] },
        mode: { type: 'string', enum: ['soft', 'hard'], description: 'soft = guest shutdown (Tools), hard = power off' },
        gui: { type: 'boolean', description: 'Only for action=start. false (default) keeps the console available to VNC.' }
      },
      required: ['vmx', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'vm_snapshot',
    description: 'Snapshots: list / create / revert / delete. create and revert need the VM to be (or will be brought) into a consistent state.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        action: { type: 'string', enum: ['list', 'create', 'revert', 'delete'] },
        name: { type: 'string', description: 'Snapshot name (required for create/revert/delete)' },
        show_tree: { type: 'boolean' },
        children: { type: 'boolean', description: 'delete children too (action=delete)' }
      },
      required: ['vmx', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'vm_clone',
    description: 'Clone a VM (full or linked). Target .vmx path must not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        dest: { type: 'string', description: 'Destination .vmx path' },
        type: { type: 'string', enum: ['full', 'linked'], description: 'Default full' },
        snapshot: { type: 'string', description: 'Snapshot name to clone from' },
        name: { type: 'string', description: 'displayName for the clone' }
      },
      required: ['vmx', 'dest'],
      additionalProperties: false
    }
  },
  {
    name: 'vm_delete',
    description: 'Delete a VM (vmrun deleteVM). Refuses when the VM is running unless force=true.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, force: { type: 'boolean' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'vm_tools_state',
    description: 'Check VMware Tools state in the guest (installed / running / notInstalled). Requires the VM running.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'vm_ip',
    description: 'Get the guest IP address (requires VMware Tools). wait=true waits until an IP is available.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, wait: { type: 'boolean' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'vm_install_tools',
    description: 'Mount the VMware Tools ISO and start installation (vmrun installTools).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'vnc_enable',
    description: 'Enable the built-in VNC console for a powered-off VM by editing RemoteDisplay.vnc.* in the .vmx (backup .vmx.bak kept). After enabling, start the VM with vm_power action=start gui=false — starting from the Player GUI overrides VNC to FALSE.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        port: { type: 'number', description: '5901-6001 recommended; auto-picked when omitted' },
        password: { type: 'string', description: 'Optional, max 8 characters (VNC auth, sent unencrypted)' },
        bind: { type: 'string', description: 'Listen IP, default 127.0.0.1 (keep loopback for safety)' }
      },
      required: ['vmx'],
      additionalProperties: false
    }
  },
  {
    name: 'vnc_disable',
    description: 'Disable the built-in VNC console (VM must be powered off).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'vnc_status',
    description: 'Report VNC config, whether the port is listening, and whether the VM is running.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'console_info',
    description: 'Connect to the VM VNC console and return screen size/name/security. Opens (and keeps) a session.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'console_screenshot',
    description: 'Capture the VM console as a PNG image (works before the OS boots: BIOS, login screen, installers). Coordinates for console_mouse are native VM pixels; if max_width is used, the returned scale must be passed back to console_mouse.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        max_width: { type: 'number', description: 'Downscale for smaller images; 0 (default) = native resolution' },
        save_path: { type: 'string', description: 'Optional absolute path to also write the PNG file' },
        timeout_ms: { type: 'number', description: 'Capture budget, default 4000' }
      },
      required: ['vmx'],
      additionalProperties: false
    }
  },
  {
    name: 'console_mouse',
    description: 'Inject mouse into the VM console: move / click / dblclick / rightclick / down / up / scroll at VM pixel coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        action: { type: 'string', enum: ['move', 'click', 'dblclick', 'rightclick', 'down', 'up', 'scroll'] },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'default left' },
        amount: { type: 'number', description: 'scroll amount, default 3' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'scroll direction, default down' },
        delay_ms: { type: 'number' },
        scale: { type: 'number', description: 'If x/y came from a downscaled screenshot, pass its scale (image_width/native_width)' }
      },
      required: ['vmx', 'action', 'x', 'y'],
      additionalProperties: false
    }
  },
  {
    name: 'console_type',
    description: 'Type text into the VM console (physical key events, works on BIOS/login; no guest agent needed).',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' },
        text: { type: 'string' },
        enter: { type: 'boolean', description: 'Press Enter afterwards' },
        delay_ms: { type: 'number', description: 'Delay between keys, default 12' }
      },
      required: ['vmx', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'console_key',
    description: 'Press key combinations in the VM console, e.g. "ctrl+alt+delete", "enter", "f2" or a list ["esc","f10"].',
    inputSchema: {
      type: 'object',
      properties: { vmx: { type: 'string' }, keys: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      required: ['vmx', 'keys'],
      additionalProperties: false
    }
  },
  {
    name: 'console_close',
    description: 'Close the VNC session for a VM (does not power it off).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'guest_run',
    description: 'Run a program inside the guest via vmrun/VIX (requires VMware Tools + guest credentials). Returns exit code and output.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' }, program: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
        interactive: { type: 'boolean' }, no_wait: { type: 'boolean' },
        guest_user: { type: 'string' }, guest_password: { type: 'string' }, timeout_ms: { type: 'number' }
      },
      required: ['vmx', 'program'],
      additionalProperties: false
    }
  },
  {
    name: 'guest_script',
    description: 'Run a script inside the guest (vmrun runScriptInGuest; interpreter e.g. c:\\windows\\system32\\cmd.exe or /bin/sh). Requires VMware Tools + credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        vmx: { type: 'string' }, interpreter: { type: 'string' }, script: { type: 'string' },
        interactive: { type: 'boolean' }, no_wait: { type: 'boolean' },
        guest_user: { type: 'string' }, guest_password: { type: 'string' }, timeout_ms: { type: 'number' }
      },
      required: ['vmx', 'interpreter', 'script'],
      additionalProperties: false
    }
  },
  {
    name: 'guest_processes',
    description: 'List processes inside the guest (requires VMware Tools + credentials).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['vmx'], additionalProperties: false }
  },
  {
    name: 'guest_kill',
    description: 'Kill a guest process by PID (requires VMware Tools + credentials).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, pid: { type: 'number' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['vmx', 'pid'], additionalProperties: false }
  },
  {
    name: 'guest_copy_to',
    description: 'Copy a file from host into the guest (requires VMware Tools + credentials).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, host_path: { type: 'string' }, guest_path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['vmx', 'host_path', 'guest_path'], additionalProperties: false }
  },
  {
    name: 'guest_copy_from',
    description: 'Copy a file from the guest to the host (requires VMware Tools + credentials).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, guest_path: { type: 'string' }, host_path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['vmx', 'guest_path', 'host_path'], additionalProperties: false }
  },
  {
    name: 'guest_mkdir',
    description: 'Create a directory inside the guest (requires VMware Tools + credentials).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, guest_path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['vmx', 'guest_path'], additionalProperties: false }
  },
  {
    name: 'guest_ls',
    description: 'List a guest directory (requires VMware Tools + credentials).',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, guest_path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['vmx', 'guest_path'], additionalProperties: false }
  },
  {
    name: 'guest_type_keystrokes',
    description: 'Type keystrokes into the guest via vmrun (requires VMware Tools; guest must already be logged in and focused). For pre-boot/BIOS input use console_type instead.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, text: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['vmx', 'text'], additionalProperties: false }
  },
  {
    name: 'guest_screenshot',
    description: 'Screenshot via VIX captureScreen (requires VMware Tools). For console-level capture without Tools use console_screenshot. Returns the PNG when available.',
    inputSchema: { type: 'object', properties: { vmx: { type: 'string' }, host_path: { type: 'string', description: 'Where to write the PNG on the host' } }, required: ['vmx', 'host_path'], additionalProperties: false }
  }
];

async function callTool(name, a) {
  a = a || {};
  if (name.indexOf('esxi_') === 0) return callEsxiTool(name, a);
  if (name.indexOf('guest_') === 0) {
    const p0 = resolveVmx(a.vmx);
    await ensureGuestTools(p0);
  }
  switch (name) {
    case 'vm_list': {
      const l = await vmrun.list();
      if (!l.ok) return textResult({ ok: false, error: l.error || 'vmrun list failed' });
      const running = l.running.map((p) => {
        let display = path.basename(p, '.vmx'), vnc = null;
        try { display = vmx.displayName(p); vnc = vncCfg(p); } catch (e) {}
        return { vmx: p, display_name: display, vnc_enabled: !!(vnc && vnc.enabled), vnc_port: vnc ? vnc.port : null };
      });
      return textResult({ ok: true, total: l.total, running });
    }
    case 'vm_info': {
      const p = resolveVmx(a.vmx);
      const running = await vmrun.isRunning(p);
      const vnc = vncCfg(p);
      let toolsState = null;
      if (running) {
        try { const tr = await vmrun.checkToolsState(p); toolsState = { ok: tr.ok, state: (tr.stdout || tr.stderr || '').trim() }; } catch (e) { toolsState = { ok: false, state: String(e.message) }; }
      }
      return textResult({ ok: true, vmx: p, display_name: vmx.displayName(p), guest_os: vmx.guestOS(p), running, tools: toolsState, vnc: { enabled: vnc.enabled, port: vnc.port, password_set: !!vnc.password, bind_ip: vnc.ip || null } });
    }
    case 'vm_power': {
      const p = resolveVmx(a.vmx);
      const action = a.action;
      if (!['start', 'stop', 'reset', 'suspend', 'pause', 'unpause'].includes(action)) throw new Error('invalid action: ' + action);
      let r;
      if (action === 'start') r = await vmrun.power.start(p, { gui: !!a.gui });
      else if (action === 'stop') { await consoleMgr.close(p); r = await vmrun.power.stop(p, { mode: a.mode }); }
      else if (action === 'reset') { await consoleMgr.close(p); r = await vmrun.power.reset(p, { mode: a.mode }); }
      else if (action === 'suspend') { await consoleMgr.close(p); r = await vmrun.power.suspend(p, { mode: a.mode }); }
      else if (action === 'pause') r = await vmrun.power.pause(p);
      else r = await vmrun.power.unpause(p);
      const out = formatVmrun(r);
      if (action === 'start' && r.ok) {
        const cfg = vncCfg(p);
        if (cfg.enabled && cfg.port) {
          const deadline = Date.now() + 30000;
          let ready = false;
          while (Date.now() < deadline) { if (await portOpen(cfg.port, '127.0.0.1')) { ready = true; break; } await new Promise((res) => setTimeout(res, 500)); }
          out.vnc_ready = ready;
          out.vnc_port = cfg.port;
          if (!ready) out.hint = 'VNC port not listening yet. If the VM was started by the Player GUI it overrides vnc.enabled to FALSE; start it with vm_power (gui=false) instead.';
        }
        if (cfg.enabled && a.gui) out.warning = 'gui=true: VMware Player forces RemoteDisplay.vnc.enabled=FALSE at startup, so the VNC console will not be available.';
      }
      return textResult(out);
    }
    case 'vm_snapshot': {
      const p = resolveVmx(a.vmx);
      let r;
      if (a.action === 'list') r = await vmrun.snapshot.list(p, { showTree: !!a.show_tree });
      else if (a.action === 'create') { if (!a.name) throw new Error('name is required'); r = await vmrun.snapshot.create(p, a.name); }
      else if (a.action === 'revert') { if (!a.name) throw new Error('name is required'); await consoleMgr.close(p); r = await vmrun.snapshot.revert(p, a.name); }
      else if (a.action === 'delete') { if (!a.name) throw new Error('name is required'); r = await vmrun.snapshot.delete(p, a.name, !!a.children); }
      else throw new Error('invalid action: ' + a.action);
      const out = formatVmrun(r);
      if (a.action === 'list' && r.ok) out.snapshots = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return textResult(out);
    }
    case 'vm_clone': {
      const p = resolveVmx(a.vmx);
      const dest = path.resolve(String(a.dest || ''));
      if (!/\.vmx$/i.test(dest)) throw new Error('dest must be a .vmx path');
      if (fs.existsSync(dest)) throw new Error('destination already exists: ' + dest);
      const r = await vmrun.clone(p, dest, { type: a.type || 'full', snapshot: a.snapshot, name: a.name });
      const out = formatVmrun(r);
      out.destination_exists = fs.existsSync(dest);
      return textResult(out);
    }
    case 'vm_delete': {
      const p = resolveVmx(a.vmx);
      if (await vmrun.isRunning(p)) {
        if (!a.force) throw new Error('VM is running; power it off first or pass force=true');
        await vmrun.power.stop(p, { mode: 'hard' });
      }
      await consoleMgr.close(p);
      return textResult(formatVmrun(await vmrun.deleteVM(p)));
    }
    case 'vm_tools_state': {
      const p = resolveVmx(a.vmx);
      return textResult(formatVmrun(await vmrun.checkToolsState(p)));
    }
    case 'vm_ip': {
      const p = resolveVmx(a.vmx);
      const r = await vmrun.getGuestIPAddress(p, !!a.wait);
      const out = formatVmrun(r);
      if (r.ok) out.ip = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || null;
      return textResult(out);
    }
    case 'vm_install_tools': {
      const p = resolveVmx(a.vmx);
      return textResult(formatVmrun(await vmrun.installTools(p)));
    }
    case 'vnc_enable': {
      const p = resolveVmx(a.vmx);
      if (await vmrun.isRunning(p)) throw new Error('VM is running. Power it off first: vnc settings are read at startup.');
      if (a.password && String(a.password).length > 8) throw new Error('VNC password max 8 characters (VMware limitation)');
      const bind = a.bind || '127.0.0.1';
      if (!/^(127\.|localhost$|::1$)/.test(bind)) throw new Error('bind must be a loopback address for safety (e.g. 127.0.0.1)');
      const existing = vncCfg(p);
      const port = await pickPort(a.port || (existing.enabled && existing.port ? existing.port : undefined));
      const cfg = { enabled: true, port, password: a.password !== undefined ? String(a.password) : existing.password, ip: bind };
      vmx.setVncConfig(p, cfg);
      const now = vncCfg(p);
      return textResult({ ok: true, vmx: p, vnc: { enabled: now.enabled, port: now.port, password_set: !!now.password, bind_ip: now.ip }, next_step: 'Start it with vm_power {vmx, action:"start", gui:false}. Do NOT start it from the Player GUI: the GUI passes RemoteDisplay.vnc.enabled=FALSE and overrides this setting.' });
    }
    case 'vnc_disable': {
      const p = resolveVmx(a.vmx);
      if (await vmrun.isRunning(p)) throw new Error('VM is running; power it off first');
      vmx.setVncConfig(p, { enabled: false });
      const cfg = vncCfg(p);
      await consoleMgr.close(p);
      return textResult({ ok: true, vmx: p, vnc_enabled: cfg.enabled });
    }
    case 'vnc_status': {
      const p = resolveVmx(a.vmx);
      const cfg = vncCfg(p);
      const running = await vmrun.isRunning(p);
      const listening = cfg.enabled && cfg.port ? await portOpen(cfg.port, cfg.ip || '127.0.0.1') : false;
      const out = { ok: true, vmx: p, running, vnc: { enabled: cfg.enabled, port: cfg.port, password_set: !!cfg.password, bind_ip: cfg.ip || null }, listening };
      if (cfg.enabled && running && !listening) out.hint = 'VNC configured but port not listening. If the VM was started by the Player GUI, VNC was overridden to FALSE at startup; stop it and start with vm_power gui=false.';
      return textResult(out);
    }
    case 'console_info': {
      const p = resolveVmx(a.vmx);
      const cfg = requireVnc(p);
      await consoleMgr.connect(p, { host: cfg.ip || '127.0.0.1', port: cfg.port, password: cfg.password });
      return textResult(consoleMgr.info(p));
    }
    case 'console_screenshot': {
      const p = resolveVmx(a.vmx);
      const cfg = requireVnc(p);
      const shot = await consoleMgr.screenshot(p, { host: cfg.ip || '127.0.0.1', port: cfg.port, password: cfg.password }, { timeoutMs: a.timeout_ms || 4000, maxWidth: a.max_width || 0 });
      const meta = {
        ok: true, vmx: p, width: shot.width, height: shot.height, native_width: shot.native_width, native_height: shot.native_height,
        scale: Number(shot.scale.toFixed(6)), security: shot.security, name: shot.name, coverage: shot.coverage
      };
      if (a.save_path) {
        const abs = path.resolve(String(a.save_path));
        fs.writeFileSync(abs, shot.png);
        meta.saved_to = abs;
        meta.bytes = shot.png.length;
      }
      if (meta.scale !== 1) meta.coordinate_hint = 'Pass scale=' + meta.scale + ' to console_mouse when using image pixel coordinates.';
      return imageResult(shot.png, meta);
    }
    case 'console_mouse': {
      const p = resolveVmx(a.vmx);
      const cfg = requireVnc(p);
      const scale = a.scale && a.scale > 0 ? Number(a.scale) : 1;
      const x = Number(a.x) / scale, y = Number(a.y) / scale;
      const r = await consoleMgr.mouse(p, { host: cfg.ip || '127.0.0.1', port: cfg.port, password: cfg.password }, {
        action: a.action, x, y, button: a.button, amount: a.amount, direction: a.direction, delay_ms: a.delay_ms
      });
      r.x_native = Math.round(x); r.y_native = Math.round(y);
      return textResult(r);
    }
    case 'console_type': {
      const p = resolveVmx(a.vmx);
      const cfg = requireVnc(p);
      return textResult(await consoleMgr.type(p, { host: cfg.ip || '127.0.0.1', port: cfg.port, password: cfg.password }, { text: a.text, enter: a.enter, delay_ms: a.delay_ms }));
    }
    case 'console_key': {
      const p = resolveVmx(a.vmx);
      const cfg = requireVnc(p);
      return textResult(await consoleMgr.key(p, { host: cfg.ip || '127.0.0.1', port: cfg.port, password: cfg.password }, { keys: a.keys }));
    }
    case 'console_close': {
      const p = resolveVmx(a.vmx);
      return textResult(await consoleMgr.close(p));
    }
    case 'guest_run': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      const r = await vmrun.runProgramInGuest(p, String(a.program), a.args || [], {
        user: cr.user, password: cr.password, interactive: !!a.interactive, noWait: !!a.no_wait, timeoutMs: a.timeout_ms || 120000
      });
      return textResult(formatVmrun(r));
    }
    case 'guest_script': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      const r = await vmrun.runScriptInGuest(p, String(a.interpreter), String(a.script), {
        user: cr.user, password: cr.password, interactive: !!a.interactive, noWait: !!a.no_wait, timeoutMs: a.timeout_ms || 120000
      });
      return textResult(formatVmrun(r));
    }
    case 'guest_processes': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      const r = await vmrun.listProcessesInGuest(p, { user: cr.user, password: cr.password });
      const out = formatVmrun(r);
      if (r.ok) out.processes = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return textResult(out);
    }
    case 'guest_kill': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      return textResult(formatVmrun(await vmrun.killProcessInGuest(p, Number(a.pid), { user: cr.user, password: cr.password })));
    }
    case 'guest_copy_to': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      const host = path.resolve(String(a.host_path));
      if (!fs.existsSync(host)) throw new Error('host_path not found: ' + host);
      return textResult(formatVmrun(await vmrun.copyFileFromHostToGuest(p, host, String(a.guest_path), { user: cr.user, password: cr.password, timeoutMs: a.timeout_ms || 180000 })));
    }
    case 'guest_copy_from': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      const host = path.resolve(String(a.host_path));
      fs.mkdirSync(path.dirname(host), { recursive: true });
      const r = await vmrun.copyFileFromGuestToHost(p, String(a.guest_path), host, { user: cr.user, password: cr.password, timeoutMs: a.timeout_ms || 180000 });
      const out = formatVmrun(r);
      out.host_exists = fs.existsSync(host);
      if (out.host_exists) out.host_bytes = fs.statSync(host).size;
      return textResult(out);
    }
    case 'guest_mkdir': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      return textResult(formatVmrun(await vmrun.createDirectoryInGuest(p, String(a.guest_path), { user: cr.user, password: cr.password })));
    }
    case 'guest_ls': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      const r = await vmrun.listDirectoryInGuest(p, String(a.guest_path), { user: cr.user, password: cr.password });
      const out = formatVmrun(r);
      if (r.ok) out.entries = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return textResult(out);
    }
    case 'guest_type_keystrokes': {
      const p = resolveVmx(a.vmx);
      const cr = guestCreds(a);
      return textResult(formatVmrun(await vmrun.typeKeystrokesInGuest(p, String(a.text), { user: cr.user, password: cr.password })));
    }
    case 'guest_screenshot': {
      const p = resolveVmx(a.vmx);
      const host = path.resolve(String(a.host_path));
      fs.mkdirSync(path.dirname(host), { recursive: true });
      const r = await vmrun.captureScreen(p, host);
      const out = formatVmrun(r);
      out.host_path = host;
      out.host_exists = fs.existsSync(host);
      if (out.host_exists) {
        const buf = fs.readFileSync(host);
        out.bytes = buf.length;
        if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
          return imageResult(buf, Object.assign(out, { ok: true, format: 'png' }));
        }
      }
      return textResult(out);
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

const TOOLS = BASE_TOOLS.concat(ESXI_TOOLS);

module.exports = { TOOLS, BASE_TOOLS, ESXI_TOOLS, callTool, consoleMgr, resolveVmx, vncCfg };