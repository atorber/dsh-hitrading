#!/usr/bin/env node
// 本地冒烟：不依赖 Harness，直接起一个临时端口的独立服务，核对健康检查与关键只读操作。
//
//   node scripts/smoke.mjs
//
// 与 CI 里「打包件冒烟」同口径，方便提交前自查（CI 仍需跑，因为它是解包后的产物）。
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.SMOKE_PORT || '18088';
const DB = `/tmp/hitrading-smoke-${process.pid}.db`;

const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  cleanup();
  process.exit(1);
};

let child = null;
function cleanup() {
  if (child && child.exitCode === null) child.kill();
  for (const f of [DB, DB + '-wal', DB + '-shm', DB + '-bak']) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

async function get(pathname, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// 1. 语法检查（与 CI 同口径）
const files = ['index.js', 'client.js', 'server.js']
  .concat(readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`))
  .concat(readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`));
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' }); }
  catch { fail(`node --check 失败：${f}`); }
}
console.log(`  ✓ 语法检查通过（${files.length} 个文件）`);

// 2. 起服务
child = spawn(process.execPath, [join(ROOT, 'server.js')], {
  env: { ...process.env, HITRADING_PORT: PORT, HITRADING_DB: DB, HITRADING_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.on('exit', (code) => {
  if (code !== 0 && child && !child.killed) fail(`server.js 提前退出（code ${code}）`);
});

// 3. 等端口就绪
let up = false;
for (let i = 0; i < 40; i += 1) {
  try {
    const r = await get('/health', 1500);
    if (r.status === 200) { up = true; break; }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!up) fail(`服务在 10 秒内未就绪（端口 ${PORT}）`);

// 4. /health 必须带版本号
const health = await get('/health');
const hv = health.body?.value || {};
if (health.status !== 200 || hv.ok === false) fail('/health 返回异常');
if (!hv.version) fail('/health 缺少 version 字段');
if (hv.name !== '@atorber/hitrading') fail(`/health 的 name 异常：${hv.name}`);
console.log(`  ✓ /health ok（${hv.name}@${hv.version}）`);

// 5. version op
const ver = await get('/api?op=version');
if (ver.status !== 200 || !ver.body?.value?.version) fail('/api?op=version 返回异常');
if (ver.body.value.version !== hv.version) fail('version op 与 /health 的版本不一致');
console.log(`  ✓ /api?op=version ok（${ver.body.value.version}）`);

// 6. 只读行情类操作（外网失败不算冒烟失败：接口可能限流，只校验结构）
const energy = await get('/api?op=energy&days=20', 20000);
if (energy.status !== 200) {
  console.log(`  ·  energy 暂时不可用（HTTP ${energy.status}），跳过结构校验`);
} else if (energy.body?.ok === false) {
  console.log(`  ·  energy 返回错误（${energy.body.error}），跳过结构校验`);
} else {
  if (!Array.isArray(energy.body?.value?.series)) fail('energy 返回缺少 series 数组');
  console.log(`  ✓ energy ok（${energy.body.value.series.length} 个交易日）`);
}

// 7. 未知 op 必须报错而不是 200
const bogus = await get('/api?op=__nope__');
if (bogus.status === 200) fail('未知 op 返回了 200，应报错');
console.log('  ✓ 未知 op 正确报错');

cleanup();
console.log('smoke ok');
