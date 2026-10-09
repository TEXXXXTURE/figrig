// 端到端校验：真实 relay 下桩插件经 WS 接入，CLI 以真实命令验证幂等、故障恢复与组件复放。
// 桩节点驱动；真机 Figma 插件行为属外部验证项（visual: not-run）。

import { execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { createStubFigma } from './stub-figma.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL = 'e2e';
const PORT = Number(process.env.FIGRIG_RELAY_PORT) || 3066;
const RELAY_URL = `ws://127.0.0.1:${PORT}?channel=${CHANNEL}`;
const CLI_ENV = { ...process.env, FIGRIG_RELAY_PORT: String(PORT), FIGRIG_TIMEOUT_MS: '1500' };

function delay(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

// 连接 relay，失败重试直至 relay 就绪。
async function connect(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    const socket = await new Promise((settle) => {
      const candidate = new WebSocket(url);
      candidate.once('open', () => settle(candidate));
      candidate.once('error', () => {
        try {
          candidate.close();
        } catch {
          // 忽略关闭失败。
        }
        settle(null);
      });
    });
    if (socket) return socket;
    await delay(100);
  }
  throw new Error(`relay unreachable: ${url}`);
}

async function runCli(args, { allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['cli.mjs', ...args], { cwd: ROOT, env: CLI_ENV });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (!allowFail) throw error;
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// 以桩 figma 加载 plugin/main.js，回包经 WS 发往 relay；getSilent 为真时丢弃 write-result。
function startStub(harness, socket, getSilent) {
  harness.figma.ui.postMessage = (message) => {
    if (getSilent() && message.type === 'write-result') return;
    socket.send(JSON.stringify(message));
  };
  const context = createContext({ figma: harness.figma, __html__: '', console });
  runInContext(readFileSync(resolve(ROOT, 'plugin', 'main.js'), 'utf8'), context, { filename: 'plugin/main.js' });
  socket.on('message', (data) => {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message || message.type === 'figrig-id') return;
    harness.figma.ui.onmessage(message);
  });
  socket.send(JSON.stringify({ type: 'figrig-id', id: 'stub' }));
}

async function main() {
  rmSync(resolve(ROOT, '.figrig-run', 'tasks'), { recursive: true, force: true });
  rmSync(resolve(ROOT, '.figrig', 'components.json'), { force: true });

  const relay = spawn(process.execPath, ['relay.mjs'], {
    cwd: ROOT,
    env: { ...process.env, FIGRIG_RELAY_PORT: String(PORT) },
    stdio: 'ignore',
  });

  let silent = false;
  const harness = createStubFigma();
  const root = harness.add(new harness.StubNode('FRAME', 'Root'));
  root.width = 400;
  root.height = 300;
  const button = harness.add(new harness.StubNode('FRAME', 'Button'));
  button.width = 120;
  button.height = 40;
  button.layoutMode = 'VERTICAL';
  button.itemSpacing = 4;
  button.paddingLeft = 8;
  button.paddingRight = 8;
  button.paddingTop = 8;
  button.paddingBottom = 8;
  const label = harness.add(new harness.StubNode('TEXT', 'Label'));
  label.characters = 'Go';
  label.width = 80;
  label.height = 20;
  label.fontSize = 13;
  button.appendChild(label);
  root.appendChild(button);

  const socket = await connect(RELAY_URL);
  startStub(harness, socket, () => silent);

  const countPanels = () => [...harness.registry.values()].filter((node) => node.name === 'Panel').length;
  const params1 = JSON.stringify({ name: 'Panel', width: 200, height: 100, x: 10, y: 20 });
  const writeArgs = (requestId) => ([
    'write', '--channel', CHANNEL, '--op', 'create-frame', '--parentId', root.id,
    '--params', params1, '--expect', 'name=Panel', '--requestId', requestId,
  ]);

  console.log('===== e2e 1. write 首次执行 =====');
  const r1 = randomUUID();
  const first = await runCli(writeArgs(r1));
  const firstOut = JSON.parse(first.stdout.trim());
  assert.equal(firstOut.status, 'applied');
  assert.equal(firstOut.reused, false);
  assert.equal(countPanels(), 1);
  console.log(first.stdout.trim());

  console.log('===== e2e 2. 同 requestId 重投 -> reused =====');
  const second = await runCli(writeArgs(r1));
  const secondOut = JSON.parse(second.stdout.trim());
  assert.equal(secondOut.reused, true);
  assert.equal(secondOut.nodeId, firstOut.nodeId);
  assert.equal(countPanels(), 1, '重投未二次执行');
  console.log(second.stdout.trim());

  console.log('===== e2e 3. 回执超时 -> unresolved =====');
  silent = true;
  const r2 = randomUUID();
  const timedOut = await runCli([
    'write', '--channel', CHANNEL, '--op', 'create-frame', '--parentId', root.id,
    '--params', JSON.stringify({ name: 'Silent', width: 80, height: 40 }), '--requestId', r2,
  ], { allowFail: true });
  silent = false;
  assert.notEqual(timedOut.code, 0);
  assert.match(timedOut.stderr, /recover/);
  assert.match(timedOut.stderr, new RegExp(r2));
  console.log(timedOut.stderr.trim());

  console.log('===== e2e 4. recover -> verified-present =====');
  const recovered = await runCli(['recover', '--channel', CHANNEL, '--requestId', r2]);
  const report = JSON.parse(recovered.stdout.trim());
  assert.equal(report.outcomes[0].status, 'done');
  assert.equal(report.outcomes[0].resolution, 'verified-present');
  assert.equal(report.pending, 0);
  console.log(recovered.stdout.trim());

  console.log('===== e2e 5. component-add =====');
  const added = await runCli(['component-add', '--channel', CHANNEL, '--name', 'Button', '--nodeId', button.id, '--confirm']);
  const addedOut = JSON.parse(added.stdout.trim());
  assert.equal(addedOut.status, 'registered');
  assert.ok(addedOut.steps >= 3);
  console.log(added.stdout.trim());

  console.log('===== e2e 6. component-use 在新父节点复放 =====');
  const target = harness.add(new harness.StubNode('FRAME', 'Target'));
  target.width = 300;
  target.height = 200;
  const used = await runCli(['component-use', '--channel', CHANNEL, '--name', 'Button', '--parentId', target.id]);
  const usedOut = JSON.parse(used.stdout.trim());
  assert.equal(usedOut.status, 'applied');
  assert.ok(usedOut.steps.length >= 3);
  const targetInstance = harness.registry.get(target.id);
  const clone = targetInstance.children.find((child) => child.name === 'Button');
  assert.ok(clone, '复放的 Button 存在');
  assert.equal(clone.width, 120);
  assert.equal(clone.layoutMode, 'VERTICAL');
  assert.equal(clone.paddingLeft, 8);
  assert.ok(clone.children.some((child) => child.name === 'Label'), '复放的 Label 存在');
  console.log(used.stdout.trim());

  await new Promise((settle) => {
    socket.once('close', settle);
    socket.close();
  });
  relay.kill();
  console.log('\nE2E PASSED (visual: not-run)');
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
