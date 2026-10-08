#!/usr/bin/env node
// cli：命令行入口。命令 connect（作为 channel 成员挂起）、bind（解析 Figma 链接并写入绑定）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket } from 'ws';

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 3055;
const DEFAULT_CHANNEL = 'default';
const BINDING_DIR = resolve(process.cwd(), '.figrig');
const BINDING_FILE = join(BINDING_DIR, 'binding.json');
const PATH_SEGMENTS = new Set(['file', 'design', 'proto', 'board', 'deck']);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readBinding() {
  if (!existsSync(BINDING_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BINDING_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeBinding(binding) {
  mkdirSync(BINDING_DIR, { recursive: true });
  writeFileSync(BINDING_FILE, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
}

// binding 存在且 fileKey 不同则报错。
function assertFileKey(fileKey) {
  if (!fileKey) return;
  const binding = readBinding();
  if (!binding) return;
  if (binding.fileKey !== fileKey) {
    fail(`fileKey mismatch: binding=${binding.fileKey} given=${fileKey}`);
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          options[body] = next;
          i += 1;
        } else {
          options[body] = 'true';
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function normalizeNodeId(raw) {
  if (!raw) return null;
  const decoded = decodeURIComponent(raw).trim();
  const value = decoded.replace(/-/g, ':');
  if (!/^\d+:\d+$/.test(value)) return null;
  return value;
}

function parseFigmaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`invalid url: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) {
    fail(`not a figma url: ${parsed.hostname}`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !PATH_SEGMENTS.has(segments[0])) {
    fail(`no file key in path: ${parsed.pathname}`);
  }
  const fileKey = segments[1];
  const rawNode = parsed.searchParams.get('node-id');
  const nodeId = normalizeNodeId(rawNode);
  if (rawNode && !nodeId) fail(`invalid node-id: ${rawNode}`);
  return { fileKey, nodeId, url: parsed.toString() };
}

function openSocket(channel, id) {
  const socket = new WebSocket(`ws://${RELAY_HOST}:${RELAY_PORT}?channel=${encodeURIComponent(channel)}`);
  return socket;
}

function commandConnect(options) {
  const channel = (options.channel || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  const fileKey = options.fileKey || null;
  assertFileKey(fileKey);

  const binding = readBinding();
  const id = options.id || 'cli';
  const socket = openSocket(channel, id);

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'figrig-id', id }));
    console.log(JSON.stringify({
      status: 'connected',
      channel,
      id,
      url: `ws://${RELAY_HOST}:${RELAY_PORT}`,
      binding: binding ? { fileKey: binding.fileKey, nodeId: binding.nodeId } : null,
    }));
  });

  socket.on('message', (data) => {
    const text = data.toString();
    console.log(JSON.stringify({ status: 'message', channel, raw: text }));
  });

  socket.on('close', () => {
    console.log(JSON.stringify({ status: 'closed', channel }));
    process.exit(0);
  });

  socket.on('error', (error) => {
    fail(`socket error: ${error.message}`);
  });

  process.on('SIGINT', () => {
    socket.close();
  });
}

function commandBind(positional) {
  const url = positional[0];
  if (!url) fail('usage: node cli.mjs bind <figma-url>');
  const parsed = parseFigmaUrl(url);
  const binding = {
    fileKey: parsed.fileKey,
    nodeId: parsed.nodeId,
    url: parsed.url,
    boundAt: new Date().toISOString(),
  };
  writeBinding(binding);
  console.log(JSON.stringify({ status: 'bound', path: BINDING_FILE, binding }));
}

function usage() {
  console.log('usage: node cli.mjs <command> [args]');
  console.log('  connect [--channel <name>] [--id <name>] [--fileKey <key>]');
  console.log('  bind <figma-url>');
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { positional, options } = parseArgs(argv.slice(1));
  if (!command || command === 'help' || command === '--help') {
    usage();
    process.exit(command ? 0 : 1);
  }
  if (command === 'connect') {
    commandConnect(options);
    return;
  }
  if (command === 'bind') {
    commandBind(positional);
    return;
  }
  fail(`unknown command: ${command}`);
}

main();
