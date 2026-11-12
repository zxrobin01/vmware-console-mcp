#!/usr/bin/env node
'use strict';
// vmware-console-mcp: stdio MCP server for VMware Player/Workstation automation.
// Lifecycle/files/guest ops via vmrun (VIX); console screen/keyboard/mouse via
// the VM's built-in VNC server (RemoteDisplay.vnc.*) and RFB.
const readline = require('readline');
const { TOOLS, callTool } = require('./tools');

const VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2024-10-07', '2025-03-26', '2025-06-18'];
const DEBUG = !!process.env.VMWARE_MCP_DEBUG;

function debug() {
  if (!DEBUG) return;
  const parts = [];
  for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
  process.stderr.write('[vmware-console-mcp] ' + parts.join(' ') + '\n');
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') { debug('ignoring non-jsonrpc message'); return; }
  const method = msg.method;
  if (method === 'initialize') {
    const requested = msg.params && msg.params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
    reply(msg.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'vmware-console-mcp', version: VERSION },
      instructions: 'VMware Player/Workstation automation. Lifecycle/files/guest ops via vmrun; console screenshots and mouse/keyboard via the VM built-in VNC (run vnc_enable while powered off, then vm_power start with gui=false).'
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { reply(msg.id, {}); return; }
  if (method === 'tools/list') { reply(msg.id, { tools: TOOLS }); return; }
  if (method === 'resources/list') { reply(msg.id, { resources: [] }); return; }
  if (method === 'prompts/list') { reply(msg.id, { prompts: [] }); return; }
  if (method === 'tools/call') {
    const params = msg.params || {};
    const name = params.name;
    const args = params.arguments || {};
    if (!name) { replyError(msg.id, -32602, 'tools/call requires params.name'); return; }
    if (!TOOLS.some((t) => t.name === name)) { replyError(msg.id, -32602, 'unknown tool: ' + name); return; }
    try {
      debug('call', name);
      const result = await callTool(name, args);
      if (!result) throw new Error('tool returned no result');
      reply(msg.id, result);
    } catch (e) {
      reply(msg.id, { content: [{ type: 'text', text: 'Error: ' + (e && e.message ? e.message : String(e)) }], isError: true });
    }
    return;
  }
  if (msg.id !== undefined) replyError(msg.id, -32601, 'Method not found: ' + method);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { replyError(null, -32700, 'Parse error'); return; }
  chain = chain.then(() => handleMessage(msg)).catch((e) => debug('handler error', e && e.stack ? e.stack : e));
});
rl.on('close', () => { debug('stdin closed, exiting'); setTimeout(() => process.exit(0), 50); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (e) => { process.stderr.write('[vmware-console-mcp] fatal: ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
debug('started, tools=' + TOOLS.length);
