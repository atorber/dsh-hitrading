#!/usr/bin/env node
// 版本号管理：唯一的升级入口。
//
//   node scripts/bump.mjs patch|minor|major   # 按语义化版本升级
//   node scripts/bump.mjs 1.2.3               # 指定具体版本
//   node scripts/bump.mjs --check             # 只校验，不写文件（CI / release 用）
//
// 会同步三处：package.json 的 version、CHANGELOG.md 的版本段落、CHANGELOG 底部的 compare 链接。
// 不改 git tag —— 打完版本后由人执行下面的提示命令提交并打 tag。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
const REPO = 'https://github.com/atorber/dsh-hitrading';

const semver = /^(\d+)\.(\d+)\.(\d+)$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function compare(a, b) {
  const [x, y, z] = a.split('.').map(Number);
  const [i, j, k] = b.split('.').map(Number);
  if (x !== i) return x - i;
  if (y !== j) return y - j;
  return z - k;
}

/** 校验：package.json 的 version 必须在 CHANGELOG 里有对应段落；release 时 tag 必须一致。 */
function check({ quiet = false } = {}) {
  const pkg = readJson(PKG_PATH);
  const version = pkg.version;
  const problems = [];

  if (!semver.test(version)) problems.push(`package.json 的 version 不是 x.y.z 形式：${version}`);

  let md = '';
  try {
    md = readFileSync(CHANGELOG_PATH, 'utf8');
  } catch {
    problems.push('CHANGELOG.md 不存在');
  }

  if (md && !new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(md)) {
    problems.push(`CHANGELOG.md 缺少 ## [${version}] 段落（先在 Unreleased 记录变更，再执行 node scripts/bump.mjs ${version}）`);
  }

  // 发布流水线里：tag 必须与 version 一致，否则会出现 tag v1.2.0 却发布 1.1.0 的包
  const ref = process.env.GITHUB_REF_NAME || '';
  if (/^v\d+\.\d+\.\d+$/.test(ref) && ref.slice(1) !== version) {
    problems.push(`git tag ${ref} 与 package.json version ${version} 不一致`);
  }

  // 版本号只能单调递增：不允许比 CHANGELOG 里已发布的最高版本更旧
  if (md) {
    const released = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
    const highest = released.sort(compare).pop();
    if (highest && semver.test(version) && compare(version, highest) < 0) {
      problems.push(`package.json version ${version} 低于 CHANGELOG 已发布最高版本 ${highest}`);
    }
  }

  if (problems.length) {
    if (!quiet) console.error('版本校验失败：\n  - ' + problems.join('\n  - '));
    process.exitCode = 1;
    return { ok: false, problems, version };
  }
  if (!quiet) console.log(`version ok: ${pkg.name}@${version}`);
  return { ok: true, problems: [], version };
}

function bump(target) {
  const pkg = readJson(PKG_PATH);
  const current = pkg.version;
  if (!semver.test(current)) throw new Error(`当前版本号非法：${current}`);

  let next;
  if (target === 'patch' || target === 'minor' || target === 'major') {
    const [maj, min, pat] = current.split('.').map(Number);
    next = target === 'patch' ? `${maj}.${min}.${pat + 1}` : target === 'minor' ? `${maj}.${min + 1}.0` : `${maj + 1}.0.0`;
  } else if (semver.test(target || '')) {
    next = target;
  } else {
    throw new Error(`无法识别的目标版本：${target}（用 patch / minor / major 或 x.y.z）`);
  }

  if (compare(next, current) <= 0) throw new Error(`新版本 ${next} 必须大于当前版本 ${current}`);

  // CHANGELOG：把 Unreleased 段落定版，并插入新的 Unreleased 占位
  let md = readFileSync(CHANGELOG_PATH, 'utf8');
  const unreleased = /^## \[Unreleased\]\s*$/m;
  if (!unreleased.test(md)) throw new Error('CHANGELOG.md 缺少 "## [Unreleased]" 段落');

  const hasEmpty = /^## \[Unreleased\]\s*\n+(?=## \[)/m.test(md);
  if (hasEmpty) {
    console.warn('提示：Unreleased 段落是空的，仍会生成一个空的版本段落。');
  }

  md = md.replace(unreleased, `## [Unreleased]\n\n## [${next}] - ${today()}\n`);
  md = md.replace(/^## \[Unreleased\]: .*$/m, `[Unreleased]: ${REPO}/compare/v${next}...HEAD`);
  md = md.replace(new RegExp(`^## \\[${next}\\]: .*$`, 'm'), '');
  const linkBlock =
    `[Unreleased]: ${REPO}/compare/v${next}...HEAD\n` +
    `[${next}]: ${REPO}/compare/v${current}...v${next}`;
  md = md.replace(/^\[Unreleased\]: .*$/m, linkBlock);
  md = md.replace(/\n{3,}/g, '\n\n');

  pkg.version = next;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(CHANGELOG_PATH, md);

  console.log(`已升级 ${pkg.name}：${current} → ${next}`);
  console.log('\n下一步（逐条执行）：');
  console.log(`  git add package.json CHANGELOG.md`);
  console.log(`  git commit -m "chore(release): v${next}"`);
  console.log(`  git tag -a v${next} -m "v${next}"`);
  console.log(`  git push origin main --follow-tags`);
  return next;
}

const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log('用法：node scripts/bump.mjs patch|minor|major|x.y.z  或  --check');
  process.exit(arg ? 0 : 1);
}
if (arg === '--check') {
  check();
} else {
  try {
    bump(arg);
    check();
  } catch (e) {
    console.error('升级失败：' + e.message);
    process.exitCode = 1;
  }
}
