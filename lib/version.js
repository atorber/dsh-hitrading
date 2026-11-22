// 版本号单一真相源：直接读取 package.json 的 version，避免多处手写导致漂移。
// 插件（index.js）、独立服务（server.js）、面板（client.js）都从这里取。
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 包名，如 @atorber/hitrading */
export const PKG_NAME = pkg.name;
/** 语义化版本号，如 1.1.0 */
export const VERSION = pkg.version;
/** 仓库地址（市场收录与「关于」展示用） */
export const REPO_URL = 'https://github.com/atorber/dsh-hitrading';
/** 官网文档地址 */
export const DOCS_URL = 'https://atorber.github.io/dsh-hitrading/';

/** 版本相关信息，供 `version` op 与 `/health` 复用。 */
export function versionInfo(extra = {}) {
  return {
    name: PKG_NAME,
    version: VERSION,
    repo: REPO_URL,
    docs: DOCS_URL,
    ...extra,
  };
}
