#!/usr/bin/env node
// 插件清单自检：CI 与本地共用，也是 dshmarket 收录要求的核对清单。
//
//   node scripts/check-manifest.mjs
//
// 检查项：
//   1. package.json 必填字段与 exports
//   2. dsh.bundle.patch 存在且文件真实存在（收录硬要求：只有 dsh.client 会被拒）
//   3. cordis.patch.yml 引用了包名
//   4. locale zh/en 的 meta 完整
//   5. icon（市场用栅格图）与 screenshots.json 的存在性与格式
//   6. 仓库地址与 keyword（收录要求仓库地址可回读、有 dsh 相关 keyword）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const problems = [];
const notes = [];

const pkg = readJson('package.json');

// 1. 必填字段
for (const k of ['name', 'version', 'description', 'license', 'exports', 'files']) {
  if (!pkg[k]) problems.push(`package.json 缺少 ${k}`);
}
for (const sub of ['.', './client', './icon']) {
  if (!pkg.exports?.[sub]) problems.push(`package.json 的 exports 缺少 "${sub}"`);
}
if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) problems.push(`version 不是 x.y.z：${pkg.version}`);

// 2. dsh.bundle.patch（市场收录硬要求）
if (!pkg.dsh?.bundle?.patch) {
  problems.push('package.json 缺少 dsh.bundle.patch（只有 dsh.client 会被市场拒绝）');
} else if (!existsSync(join(ROOT, pkg.dsh.bundle.patch))) {
  problems.push(`dsh.bundle.patch 指向的文件不存在：${pkg.dsh.bundle.patch}`);
}
if (!pkg.dsh?.client) notes.push('未声明 dsh.client，将只提供 Host 侧工具、没有面板');

// 3. cordis.patch.yml 引用包名
if (existsSync(join(ROOT, 'cordis.patch.yml'))) {
  const patch = read('cordis.patch.yml');
  if (!patch.includes(pkg.name)) problems.push('cordis.patch.yml 未引用包名 ' + pkg.name);
  if (!/'?insert'?:/.test(patch)) problems.push('cordis.patch.yml 缺少 insert 段');
} else {
  problems.push('缺少 cordis.patch.yml');
}

// 4. locale
for (const lang of ['zh', 'en']) {
  const p = `locale/${lang}.json`;
  if (!existsSync(join(ROOT, p))) {
    problems.push(`缺少 ${p}`);
    continue;
  }
  const loc = readJson(p);
  if (!loc.meta?.title || !loc.meta?.description) problems.push(`${p} 的 meta.title / meta.description 不完整`);
}

// 5. 市场材料
const iconPath = 'assets/icon-180.png';
if (existsSync(join(ROOT, iconPath))) {
  const buf = readFileSync(join(ROOT, iconPath));
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) problems.push(`${iconPath} 不是 PNG（市场要求栅格图，禁用 SVG）`);
} else {
  notes.push(`缺少 ${iconPath}，市场会回退到仓库 owner 头像`);
}

if (existsSync(join(ROOT, 'screenshots.json'))) {
  const shots = readJson('screenshots.json');
  const list = Array.isArray(shots) ? shots : shots.screenshots;
  if (!Array.isArray(list) || list.length === 0) {
    problems.push('screenshots.json 需要非空数组（或 {"screenshots": [...]}）');
  } else {
    if (list.length > 8) problems.push(`screenshots.json 最多 8 张，当前 ${list.length}`);
    for (const s of list) {
      if (typeof s !== 'string') { problems.push('screenshots.json 里存在非字符串路径'); continue; }
      if (s.startsWith('/')) problems.push(`截图路径不能以 / 开头：${s}`);
      if (s.split('/').includes('..')) problems.push(`截图路径不能包含 ..：${s}`);
      if (/\.svg$/i.test(s)) problems.push(`截图不支持 SVG：${s}`);
      if (!existsSync(join(ROOT, s))) problems.push(`截图文件不存在：${s}`);
    }
  }
}

// 6. 仓库地址与 keyword
if (!pkg.repository?.url) problems.push('package.json 缺少 repository.url（市场据此回读映射）');
if (!(pkg.keywords || []).some((k) => /^(dsh|cordis)/.test(k))) {
  notes.push('keywords 里没有 dsh/cordis 相关词，检索时不容易被发现');
}

// 输出
for (const n of notes) console.log(`  提示  ${n}`);
if (problems.length) {
  console.error('清单检查失败：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`manifest ok: ${pkg.name}@${pkg.version}（${pkg.dsh?.bundle?.patch}）`);
