'use strict';
// ESXi / vCenter tools (multi-host via aliases). Backend: govc.
const fs = require('fs');
const path = require('path');
const esxi = require('./esxi');
const { ConsoleManager } = require('./console');

const consoleMgr = new ConsoleManager();
const ROOT = path.join(__dirname, '..');

function log() {
  if (!process.env.VMWARE_MCP_DEBUG) return;
  const a = [];
  for (let i = 0; i < arguments.length; i++) a.push(String(arguments[i]));
  process.stderr.write('[vmware-console-mcp:esxi] ' + a.join(' ') + '\n');
}
function textResult(o) { return { content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] }; }
function imageResult(png, meta) {
  return { content: [
    { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    { type: 'text', text: JSON.stringify(meta, null, 2) }
  ] };
}
function fmt(r) {
  const o = { ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, elapsedMs: r.elapsedMs };
  if (r.command) o.command = r.command;
  if (r.stdout) o.stdout = r.stdout;
  if (r.stderr) o.stderr = r.stderr;
  return o;
}
function guestCreds(a) {
  return {
    user: a.guest_user || process.env.ESXI_GUEST_USER || undefined,
    password: a.guest_password || process.env.ESXI_GUEST_PASSWORD || undefined
  };
}
function parseVncLine(stdout) {
  const line = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  if (/disabled/i.test(line)) return { enabled: false, raw: line };
  const m = /vnc:\/\/(?::([^@]*)@)?([^:\s]+):(\d+)/.exec(line);
  if (!m) return { enabled: null, raw: line };
  return { enabled: true, password: m[1] || '', host: m[2], port: Number(m[3]), raw: line };
}
function summarizeVM(item) {
  const g = (k) => item && item[k];
  const cfg = g('Config') || g('config') || {};
  const rt = g('Runtime') || g('runtime') || {};
  const sum = g('Summary') || g('summary') || {};
  const guest = g('Guest') || g('guest') || {};
  return {
    name: g('Name') || g('name') || null,
    power: rt.PowerState || rt.powerState || sum.PowerState || sum.powerState || null,
    guest: cfg.GuestFullName || cfg.guestFullName || cfg.GuestId || cfg.guestId || null,
    uuid: cfg.Uuid || cfg.uuid || null,
    ip: guest.IpAddress || guest.ipAddress || null,
    tools: (sum.Guest || sum.guest || {}).ToolsStatus || (sum.Guest || sum.guest || {}).toolsStatus || null,
    tools_running: (sum.Guest || sum.guest || {}).toolsRunningStatus || null,
    moId: item.MoRef || item.moRef || null
  };
}
// USB HID key codes for PutUsbScanCodes (govc vm.keystrokes -c)
const HID = {
  enter: 0x28, return: 0x28, esc: 0x29, escape: 0x29, backspace: 0x2a, bs: 0x2a, tab: 0x2b, space: 0x2c,
  minus: 0x2d, equal: 0x2e, leftbrace: 0x2f, rightbrace: 0x30, backslash: 0x31, semicolon: 0x33,
  apostrophe: 0x34, grave: 0x35, comma: 0x36, period: 0x37, dot: 0x37, slash: 0x38, capslock: 0x39,
  f1: 0x3a, f2: 0x3b, f3: 0x3c, f4: 0x3d, f5: 0x3e, f6: 0x3f, f7: 0x40, f8: 0x41, f9: 0x42,
  f10: 0x43, f11: 0x44, f12: 0x45, printscreen: 0x46, prtsc: 0x46, scrolllock: 0x47, pause: 0x48,
  insert: 0x49, ins: 0x49, home: 0x4a, pageup: 0x4b, pgup: 0x4b, delete: 0x4c, del: 0x4c, end: 0x4d,
  pagedown: 0x4e, pgdn: 0x4e, right: 0x4f, left: 0x50, down: 0x51, up: 0x52, numlock: 0x53
};
const HID_MODIFIERS = {
  ctrl: '-lc', control: '-lc', lctrl: '-lc', rctrl: '-rc',
  shift: '-ls', lshift: '-ls', rshift: '-rs',
  alt: '-la', lalt: '-la', ralt: '-ra',
  win: '-lg', meta: '-lg', super: '-lg', gui: '-lg', cmd: '-lg'
};
function hidFor(name) {
  const n = String(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(HID, n)) return HID[n];
  if (n.length === 1) {
    const ch = n;
    if (/[a-z]/.test(ch)) return 0x04 + (ch.charCodeAt(0) - 97);
    if (/[1-9]/.test(ch)) return 0x1e + (Number(ch) - 1);
    if (ch === '0') return 0x27;
  }
  throw new Error('unsupported key for ESXi keystrokes: ' + name);
}
function keystrokeCalls(keys) {
  const list = Array.isArray(keys) ? keys : [String(keys || '')];
  const calls = [];
  for (const raw of list) {
    const item = String(raw);
    if (item.indexOf('+') >= 0) {
      const parts = item.split('+').map((s) => s.trim()).filter(Boolean);
      const mods = {};
      let code = null;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i].toLowerCase();
        if (HID_MODIFIERS[p] && i < parts.length - 1) mods[HID_MODIFIERS[p]] = true;
        else { code = hidFor(parts[i]); break; }
      }
      if (code === null) throw new Error('key combination has no terminal key: ' + item);
      calls.push({ codes: '0x' + code.toString(16).padStart(2, '0'), modifiers: mods });
    } else if (/^[a-z0-9]$/i.test(item)) {
      calls.push({ codes: '0x' + hidFor(item).toString(16).padStart(2, '0') });
    } else if (Object.prototype.hasOwnProperty.call(HID, item.toLowerCase())) {
      calls.push({ codes: '0x' + hidFor(item).toString(16).padStart(2, '0') });
    } else if (item.length > 1) {
      // treat as literal text
      calls.push({ text: item });
    } else {
      throw new Error('cannot map key: ' + item);
    }
  }
  return calls;
}

const ESXI_TOOLS = [
  {
    name: 'esxi_hosts',
    description: 'List configured ESXi/vCenter hosts (aliases; passwords masked). Config file path shown.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'esxi_add_host',
    description: 'Register an ESXi/vCenter host. Validates connectivity with govc about unless test=false. Password can be given directly (stored in config file, 0600 best-effort) or via password_env (recommended).',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, host: { type: 'string', description: 'IP or hostname (https assumed)' },
        user: { type: 'string' }, password: { type: 'string' }, password_env: { type: 'string' },
        datacenter: { type: 'string', description: 'Optional datacenter name (vCenter only)' },
        insecure: { type: 'boolean', description: 'Skip TLS verification, default true for self-signed ESXi' },
        note: { type: 'string' }, test: { type: 'boolean', description: 'Test connection before saving, default true' }
      },
      required: ['alias', 'host', 'user'], additionalProperties: false
    }
  },
  {
    name: 'esxi_remove_host',
    description: 'Remove an ESXi/vCenter host from the registry.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false }
  },
  {
    name: 'esxi_test_host',
    description: 'Test connectivity to one host (govc about + host summary).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false }
  },
  {
    name: 'esxi_host_info',
    description: 'Host summary (version/build, CPU, memory, datastores) via govc host.info -json.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false }
  },
  {
    name: 'esxi_vm_list',
    description: 'List VMs on one host (alias) or on ALL configured hosts when alias is omitted (queried in parallel).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'esxi_vm_info',
    description: 'Detailed VM info (govc vm.info -json) for one VM on a host.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string', description: 'VM name or inventory path' } }, required: ['alias', 'vm'], additionalProperties: false }
  },
  {
    name: 'esxi_vm_power',
    description: 'Power operations on an ESXi VM: start / stop (soft=guest shutdown, hard=power off) / reset / reboot (guest) / suspend.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, vm: { type: 'string' },
        action: { type: 'string', enum: ['start', 'stop', 'reset', 'reboot', 'suspend'] },
        mode: { type: 'string', enum: ['soft', 'hard'], description: 'for stop, default soft' }
      },
      required: ['alias', 'vm', 'action'], additionalProperties: false
    }
  },
  {
    name: 'esxi_vm_create',
    description: 'Create a VM on ESXi (govc vm.create).',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, name: { type: 'string' },
        memory_mb: { type: 'number' }, cpus: { type: 'number' },
        guest_id: { type: 'string', description: 'VMware guest id, e.g. windows9-64Guest / otherGuest' },
        datastore: { type: 'string' }, network: { type: 'string' },
        disk_size: { type: 'string', description: 'e.g. 20G' },
        power_on: { type: 'boolean' }
      },
      required: ['alias', 'name'], additionalProperties: false
    }
  },
  {
    name: 'esxi_vm_clone',
    description: 'Clone a VM or template on ESXi (govc vm.clone).',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, source: { type: 'string' }, dest: { type: 'string' },
        datastore: { type: 'string' }, snapshot: { type: 'string' }, pool: { type: 'string' }
      },
      required: ['alias', 'source', 'dest'], additionalProperties: false
    }
  },
  {
    name: 'esxi_vm_destroy',
    description: 'Delete a VM from ESXi (govc vm.destroy). Powers it off first when force=true.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, force: { type: 'boolean' } }, required: ['alias', 'vm'], additionalProperties: false }
  },
  {
    name: 'esxi_vm_register',
    description: 'Register an existing .vmx on a datastore (govc vm.register).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vmx_path: { type: 'string' }, name: { type: 'string' } }, required: ['alias', 'vmx_path'], additionalProperties: false }
  },
  {
    name: 'esxi_snapshot',
    description: 'Snapshot operations on an ESXi VM: list / create / revert / remove.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, vm: { type: 'string' },
        action: { type: 'string', enum: ['list', 'create', 'revert', 'remove'] },
        name: { type: 'string' }
      },
      required: ['alias', 'vm', 'action'], additionalProperties: false
    }
  },
  {
    name: 'esxi_datastore_ls',
    description: 'List a datastore path (govc datastore.ls -l).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, path: { type: 'string', description: 'e.g. [datastore1] or [datastore1] folder/' } }, required: ['alias'], additionalProperties: false }
  },
  {
    name: 'esxi_datastore_upload',
    description: 'Upload a local file to an ESXi datastore (govc datastore.upload).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, local_path: { type: 'string' }, remote_path: { type: 'string' } }, required: ['alias', 'local_path', 'remote_path'], additionalProperties: false }
  },
  {
    name: 'esxi_datastore_download',
    description: 'Download a file from an ESXi datastore (govc datastore.download).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, remote_path: { type: 'string' }, local_path: { type: 'string' } }, required: ['alias', 'remote_path', 'local_path'], additionalProperties: false }
  },
  {
    name: 'esxi_datastore_mkdir',
    description: 'Create a directory in an ESXi datastore (govc datastore.mkdir). Path form: "[datastore1] folder/sub".',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, path: { type: 'string' } }, required: ['alias', 'path'], additionalProperties: false }
  },
  {
    name: 'esxi_datastore_rm',
    description: 'Remove a file or directory from an ESXi datastore (govc datastore.rm; recursive by default).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, path: { type: 'string' } }, required: ['alias', 'path'], additionalProperties: false }
  },
  {
    name: 'esxi_guest_run',
    description: 'Run a program in the guest via VMware Tools (govc guest.run). Needs guest credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, vm: { type: 'string' }, program: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        guest_user: { type: 'string' }, guest_password: { type: 'string' }, timeout_ms: { type: 'number' }
      },
      required: ['alias', 'vm', 'program'], additionalProperties: false
    }
  },
  {
    name: 'esxi_guest_ps',
    description: 'List guest processes via Tools (govc guest.ps).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['alias', 'vm'], additionalProperties: false }
  },
  {
    name: 'esxi_guest_kill',
    description: 'Kill a guest process by PID via Tools (govc guest.kill).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, pid: { type: 'number' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['alias', 'vm', 'pid'], additionalProperties: false }
  },
  {
    name: 'esxi_guest_ls',
    description: 'List a guest directory via Tools (govc guest.ls).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['alias', 'vm', 'path'], additionalProperties: false }
  },
  {
    name: 'esxi_guest_mkdir',
    description: 'Create a guest directory via Tools (govc guest.mkdir).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['alias', 'vm', 'path'], additionalProperties: false }
  },
  {
    name: 'esxi_guest_upload',
    description: 'Upload a file into the guest via Tools (govc guest.upload).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, local_path: { type: 'string' }, remote_path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['alias', 'vm', 'local_path', 'remote_path'], additionalProperties: false }
  },
  {
    name: 'esxi_guest_download',
    description: 'Download a file from the guest via Tools (govc guest.download).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, remote_path: { type: 'string' }, local_path: { type: 'string' }, guest_user: { type: 'string' }, guest_password: { type: 'string' } }, required: ['alias', 'vm', 'remote_path', 'local_path'], additionalProperties: false }
  },
  {
    name: 'esxi_console_screenshot',
    description: 'Capture an ESXi VM console screenshot as PNG (govc vm.console -capture; works without VMware Tools on standalone ESXi). Falls back to VNC when the HTTP screen endpoint is unavailable.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, vm: { type: 'string' }, save_path: { type: 'string' } }, required: ['alias', 'vm'], additionalProperties: false }
  },
  {
    name: 'esxi_console_key',
    description: 'Send console keystrokes to an ESXi VM via PutUsbScanCodes (works without VMware Tools, even in BIOS). keys: "enter", "f2", "ctrl+alt+delete" or an array.',
    inputSchema: {
      type: 'object',
      properties: { alias: { type: 'string' }, vm: { type: 'string' }, keys: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      required: ['alias', 'vm', 'keys'], additionalProperties: false
    }
  },
  {
    name: 'esxi_console_type',
    description: 'Type text on an ESXi VM console via PutUsbScanCodes (ASCII printable; optional Enter).',
    inputSchema: {
      type: 'object',
      properties: { alias: { type: 'string' }, vm: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean' } },
      required: ['alias', 'vm', 'text'], additionalProperties: false
    }
  },
  {
    name: 'esxi_console_mouse',
    description: 'Mouse operations on an ESXi VM console through its built-in VNC (console_mouse semantics). Requires esxi_vnc -enable and the ESXi firewall to allow the VNC port.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, vm: { type: 'string' },
        action: { type: 'string', enum: ['move', 'click', 'dblclick', 'rightclick', 'down', 'up', 'scroll'] },
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        amount: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] },
        delay_ms: { type: 'number' },
        vnc_host: { type: 'string', description: 'Override VNC host (e.g. 127.0.0.1 when using an SSH tunnel)' },
        vnc_port: { type: 'number', description: 'Override VNC port (e.g. local tunnel port)' }
      },
      required: ['alias', 'vm', 'action', 'x', 'y'], additionalProperties: false
    }
  },
  {
    name: 'esxi_vnc',
    description: 'Query/enable/disable the built-in VNC server of an ESXi VM (govc vm.vnc, extraConfig RemoteDisplay.vnc.*). Port/password auto-assigned when omitted. VM should be powered off before enabling.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string' }, vm: { type: 'string' },
        action: { type: 'string', enum: ['status', 'enable', 'disable'] },
        port: { type: 'number' }, password: { type: 'string' }
      },
      required: ['alias', 'vm', 'action'], additionalProperties: false
    }
  },
  {
    name: 'esxi_firewall',
    description: 'Inspect or enable ESXi firewall rulesets (govc host.esxcli network firewall ruleset ...). Use action=list to find a VNC ruleset; enable requires an existing ruleset id.',
    inputSchema: {
      type: 'object',
      properties: { alias: { type: 'string' }, action: { type: 'string', enum: ['list', 'enable'] }, ruleset: { type: 'string' } },
      required: ['alias', 'action'], additionalProperties: false
    }
  }
];

async function callEsxiTool(name, a) {
  a = a || {};
  switch (name) {
    case 'esxi_hosts':
      return textResult({ ok: true, config_path: esxi.CONFIG_PATH, govc: esxi.govcPath(), hosts: esxi.listHosts() });
    case 'esxi_add_host': {
      const h = {
        alias: a.alias, host: a.host, user: a.user, password: a.password, password_env: a.password_env,
        datacenter: a.datacenter, insecure: a.insecure, note: a.note
      };
      if (a.test === false) {
        const saved = esxi.addHost(h);
        return textResult({ ok: true, saved, validated: false });
      }
      // validate with a temporary entry (about only needs URL/credentials)
      const saved = esxi.addHost(h);
      const r = await esxi.about(a.alias);
      if (!r.ok) {
        esxi.removeHost(a.alias);
        return textResult({ ok: false, error: 'connection test failed; host not saved', detail: (r.stderr || r.stdout || '').slice(0, 600), command: r.command });
      }
      return textResult({ ok: true, saved, validated: true, about: r.stdout.slice(0, 400) });
    }
    case 'esxi_remove_host':
      return textResult({ ok: true, removed: esxi.removeHost(a.alias), alias: a.alias });
    case 'esxi_test_host': {
      const about = await esxi.about(a.alias);
      const out = { ok: about.ok, alias: a.alias, about: about.stdout ? about.stdout.slice(0, 500) : undefined, error: about.ok ? undefined : (about.stderr || about.stdout || '').slice(0, 600) };
      if (about.ok) {
        const hi = await esxi.hostInfo(a.alias);
        out.host_info_ok = hi.ok;
        if (!hi.ok) out.host_info_error = (hi.stderr || hi.stdout || '').slice(0, 400);
      }
      return textResult(out);
    }
    case 'esxi_host_info': {
      const r = await esxi.hostInfo(a.alias);
      if (!r.ok) return textResult(fmt(r));
      try {
        const j = JSON.parse(r.stdout);
        const h = (j.hostSystems && j.hostSystems[0]) || (j.HostSystems && j.HostSystems[0]) || j;
        const cfg = h.config || h.Config || {};
        const prod = cfg.product || cfg.Product || {};
        const hw = (h.summary && h.summary.hardware) || (h.Summary && h.Summary.Hardware) || {};
        return textResult({
          ok: true, alias: a.alias, name: h.name || h.Name || null,
          version: prod.fullName || prod.FullName || null,
          build: prod.build || prod.Build || null,
          vendor: prod.vendor || prod.Vendor || null,
          cpu_packages: hw.numCpuPkgs != null ? hw.numCpuPkgs : (hw.NumCpuPkgs != null ? hw.NumCpuPkgs : null),
          cpu_cores: hw.numCpuCores != null ? hw.numCpuCores : (hw.NumCpuCores != null ? hw.NumCpuCores : null),
          memory_gb: (hw.memorySize || hw.MemorySize) ? Math.round((hw.memorySize || hw.MemorySize) / 1073741824) : null
        });
      } catch (e) {
        return textResult({ ok: true, alias: a.alias, raw: r.stdout.slice(0, 2000) });
      }
    }
    case 'esxi_vm_list': {
      const aliases = a.alias ? [a.alias] : Object.keys(esxi.loadHosts());
      if (!aliases.length) return textResult({ ok: false, error: 'no hosts configured; call esxi_add_host first' });
      const results = await Promise.all(aliases.map(async (alias) => {
        const f = await esxi.findVMs(alias);
        if (!f.ok) return { alias, ok: false, error: f.error || 'govc find failed', vms: [] };
        if (!f.vms.length) return { alias, ok: true, count: 0, vms: [] };
        const info = await esxi.vmInfoMany(alias, f.vms);
        if (!info.ok) return { alias, ok: false, error: info.error, paths: f.vms, vms: [] };
        return { alias, ok: true, count: info.vms.length, vms: info.vms.map(summarizeVM) };
      }));
      return textResult({ ok: true, hosts: results });
    }
    case 'esxi_vm_info': {
      const r = await esxi.vmInfo(a.alias, a.vm);
      if (!r.ok) return textResult(r);
      const list = esxi.pickVMs(r.data);
      if (!list.length) return textResult({ ok: false, error: 'VM not found: ' + a.vm });
      return textResult({ ok: true, alias: a.alias, summary: summarizeVM(list[0]), raw: list[0] });
    }
    case 'esxi_vm_power':
      return textResult(fmt(await esxi.power(a.alias, a.vm, a.action, { mode: a.mode })));
    case 'esxi_vm_create':
      return textResult(fmt(await esxi.createVM(a.alias, a)));
    case 'esxi_vm_clone':
      return textResult(fmt(await esxi.clone(a.alias, a.source, a.dest, a)));
    case 'esxi_vm_destroy': {
      if (a.force) {
        const info = await esxi.vmInfo(a.alias, a.vm);
        const first = info.ok ? esxi.pickVMs(info.data)[0] : null;
        const power = first ? summarizeVM(first).power : null;
        if (power === 'poweredOn') await esxi.power(a.alias, a.vm, 'stop', { mode: 'hard' });
      }
      return textResult(fmt(await esxi.destroy(a.alias, a.vm)));
    }
    case 'esxi_vm_register':
      return textResult(fmt(await esxi.registerVM(a.alias, a.vmx_path, a.name)));
    case 'esxi_snapshot':
      return textResult(fmt(await esxi.snapshot(a.alias, a.vm, a.action, a.name)));
    case 'esxi_datastore_ls':
      return textResult(fmt(await esxi.datastoreLs(a.alias, a.path)));
    case 'esxi_datastore_upload':
      return textResult(fmt(await esxi.datastoreUpload(a.alias, a.local_path, a.remote_path)));
    case 'esxi_datastore_download':
      return textResult(fmt(await esxi.datastoreDownload(a.alias, a.remote_path, a.local_path)));
    case 'esxi_datastore_mkdir':
      return textResult(fmt(await esxi.datastoreMkdir(a.alias, a.path)));
    case 'esxi_datastore_rm':
      return textResult(fmt(await esxi.datastoreRm(a.alias, a.path)));
    case 'esxi_guest_run': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestRun(a.alias, a.vm, { user: cr.user, password: cr.password, program: a.program, args: a.args, timeoutMs: a.timeout_ms })));
    }
    case 'esxi_guest_ps': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestPs(a.alias, a.vm, { user: cr.user, password: cr.password })));
    }
    case 'esxi_guest_kill': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestKill(a.alias, a.vm, { user: cr.user, password: cr.password, pid: a.pid })));
    }
    case 'esxi_guest_ls': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestLs(a.alias, a.vm, { user: cr.user, password: cr.password, path: a.path })));
    }
    case 'esxi_guest_mkdir': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestMkdir(a.alias, a.vm, { user: cr.user, password: cr.password, path: a.path })));
    }
    case 'esxi_guest_upload': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestUpload(a.alias, a.vm, { user: cr.user, password: cr.password, localPath: a.local_path, remotePath: a.remote_path })));
    }
    case 'esxi_guest_download': {
      const cr = guestCreds(a);
      return textResult(fmt(await esxi.guestDownload(a.alias, a.vm, { user: cr.user, password: cr.password, remotePath: a.remote_path, localPath: a.local_path })));
    }
    case 'esxi_console_screenshot': {
      const dir = path.join(ROOT, 'tmp', 'esxi-shots');
      fs.mkdirSync(dir, { recursive: true });
      const out = a.save_path ? path.resolve(String(a.save_path)) : path.join(dir, (a.alias + '-' + a.vm).replace(/[^A-Za-z0-9_.-]+/g, '_') + '-' + Date.now() + '.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await esxi.consoleCapture(a.alias, a.vm, out);
      if (r.ok && fs.existsSync(out)) {
        const png = fs.readFileSync(out);
        if (png.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
          return imageResult(png, { ok: true, alias: a.alias, vm: a.vm, saved_to: out, bytes: png.length, source: 'govc vm.console -capture' });
        }
      }
      // fallback: VNC
      try {
        const vs = parseVncLine((await esxi.vncQuery(a.alias, a.vm)).stdout);
        if (vs.enabled) {
          const key = 'esxi://' + a.alias + '/' + a.vm;
          const shot = await consoleMgr.screenshot(key, { host: vs.host, port: vs.port, password: vs.password }, { timeoutMs: 5000 });
          if (a.save_path) fs.writeFileSync(out, shot.png);
          return imageResult(shot.png, { ok: true, alias: a.alias, vm: a.vm, saved_to: a.save_path ? out : undefined, width: shot.width, height: shot.height, source: 'vnc' });
        }
      } catch (e) { /* fall through */ }
      return textResult(Object.assign(fmt(r), { ok: false, hint: 'govc console capture failed. It relies on the ESXi /screen HTTP endpoint (standalone ESXi). Enable VNC via esxi_vnc as a fallback.' }));
    }
    case 'esxi_console_key': {
      const calls = keystrokeCalls(a.keys);
      const results = [];
      for (const c of calls) {
        const r = await esxi.keystrokes(a.alias, a.vm, c);
        results.push({ ok: r.ok, command: r.command, error: r.ok ? undefined : (r.stderr || r.stdout || '').slice(0, 300) });
        if (!r.ok) break;
      }
      return textResult({ ok: results.every((x) => x.ok), count: results.length, results });
    }
    case 'esxi_console_type': {
      const results = [];
      const r = await esxi.keystrokes(a.alias, a.vm, { text: a.text });
      results.push({ ok: r.ok, error: r.ok ? undefined : (r.stderr || r.stdout || '').slice(0, 300) });
      if (r.ok && a.enter) {
        const r2 = await esxi.keystrokes(a.alias, a.vm, { codes: '0x28' });
        results.push({ ok: r2.ok, error: r2.ok ? undefined : (r2.stderr || r2.stdout || '').slice(0, 300) });
      }
      return textResult({ ok: results.every((x) => x.ok), results });
    }
    case 'esxi_console_mouse': {
      const vs = parseVncLine((await esxi.vncQuery(a.alias, a.vm)).stdout);
      if (!vs.enabled) throw new Error('VNC is not enabled for this ESXi VM. Run esxi_vnc action=enable (VM powered off), open the VNC port in the ESXi firewall, then power it on. Mouse injection on ESXi is only available through VNC.');
      const key = 'esxi://' + a.alias + '/' + a.vm;
      const host = a.vnc_host || vs.host;
      const port = a.vnc_port || vs.port;
      const r = await consoleMgr.mouse(key, { host, port, password: vs.password }, a);
      return textResult(Object.assign(r, { vnc_endpoint: host + ':' + port }));
    }
    case 'esxi_vnc': {
      if (a.action === 'status') {
        const r = await esxi.vncQuery(a.alias, a.vm);
        return textResult({ ok: r.ok, alias: a.alias, vm: a.vm, parsed: parseVncLine(r.stdout), raw: r.stdout.slice(0, 300), error: r.ok ? undefined : (r.stderr || '').slice(0, 300) });
      }
      if (a.action === 'enable') {
        const r = await esxi.vncEnable(a.alias, a.vm, { port: a.port, password: a.password });
        const q = await esxi.vncQuery(a.alias, a.vm);
        return textResult({ ok: r.ok, alias: a.alias, vm: a.vm, parsed: parseVncLine(q.stdout), raw: q.stdout.slice(0, 300), error: r.ok ? undefined : (r.stderr || r.stdout || '').slice(0, 400), next_step: 'Power off then on (VNC settings are read at startup). Open the VNC port on the ESXi firewall (custom ruleset) to reach it remotely; loopback/SSH tunnel otherwise.' });
      }
      if (a.action === 'disable') {
        const r = await esxi.vncDisable(a.alias, a.vm);
        return textResult({ ok: r.ok, alias: a.alias, vm: a.vm, raw: r.stdout.slice(0, 300), error: r.ok ? undefined : (r.stderr || r.stdout || '').slice(0, 400) });
      }
      throw new Error('invalid esxi_vnc action');
    }
    case 'esxi_firewall': {
      if (a.action === 'list') {
        const r = await esxi.firewallRules(a.alias);
        return textResult({ ok: r.ok, alias: a.alias, rulesets: r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : undefined, error: r.ok ? undefined : (r.stderr || r.stdout || '').slice(0, 500) });
      }
      if (a.action === 'enable') {
        if (!a.ruleset) throw new Error('ruleset is required for action=enable');
        return textResult(fmt(await esxi.firewallEnable(a.alias, a.ruleset)));
      }
      throw new Error('invalid esxi_firewall action');
    }
    default:
      throw new Error('unknown esxi tool: ' + name);
  }
}

module.exports = { ESXI_TOOLS, callEsxiTool, _internal: { keystrokeCalls, hidFor, parseVncLine } };