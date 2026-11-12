'use strict';
const fs = require('fs');
const path = require('path');

function readRaw(vmxPath) {
  return fs.readFileSync(vmxPath, 'latin1');
}

function parse(content) {
  const map = new Map();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const m = /^([^=]+?)\s*=\s*"(.*)"\s*$/.exec(t) || /^([^=]+?)\s*=\s*(.*)$/.exec(t);
    if (m) map.set(m[1].trim(), m[2]);
  }
  return map;
}

function read(vmxPath) {
  const content = readRaw(vmxPath);
  return { content, map: parse(content), crlf: /\r\n/.test(content) };
}

function getVncConfig(vmxPath) {
  if (!fs.existsSync(vmxPath)) throw new Error('VMX not found: ' + vmxPath);
  const { map } = read(vmxPath);
  const enabled = String(map.get('RemoteDisplay.vnc.enabled') || '').toUpperCase() === 'TRUE';
  const port = Number(map.get('RemoteDisplay.vnc.port') || 0);
  const password = map.get('RemoteDisplay.vnc.password') || '';
  const ip = map.get('RemoteDisplay.vnc.ip') || '';
  return { enabled, port, password, ip };
}

function setVncConfig(vmxPath, cfg) {
  if (!fs.existsSync(vmxPath)) throw new Error('VMX not found: ' + vmxPath);
  const { content, crlf } = read(vmxPath);
  const eol = crlf ? '\r\n' : '\n';
  let lines = content.split(/\r?\n/);
  const updates = new Map();
  if (cfg.enabled !== undefined) updates.set('RemoteDisplay.vnc.enabled', cfg.enabled ? 'TRUE' : 'FALSE');
  if (cfg.port !== undefined) updates.set('RemoteDisplay.vnc.port', String(cfg.port));
  if (cfg.password !== undefined) updates.set('RemoteDisplay.vnc.password', String(cfg.password));
  if (cfg.ip !== undefined) updates.set('RemoteDisplay.vnc.ip', String(cfg.ip));
  for (const [k, v] of updates) {
    const re = new RegExp('^\\s*' + k.replace(/\./g, '\\.') + '\\s*=');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { lines[i] = k + ' = "' + v + '"'; found = true; }
    }
    if (!found) lines.push(k + ' = "' + v + '"');
  }
  const backup = vmxPath + '.bak';
  if (!fs.existsSync(backup)) fs.copyFileSync(vmxPath, backup);
  fs.writeFileSync(vmxPath, lines.join(eol), 'latin1');
  return { ok: true, backup };
}

function displayName(vmxPath) {
  try { return read(vmxPath).map.get('displayName') || path.basename(vmxPath, '.vmx'); }
  catch (e) { return path.basename(vmxPath, '.vmx'); }
}

function guestOS(vmxPath) {
  try { return read(vmxPath).map.get('guestOS') || null; } catch (e) { return null; }
}

module.exports = { read, parse, getVncConfig, setVncConfig, displayName, guestOS };
