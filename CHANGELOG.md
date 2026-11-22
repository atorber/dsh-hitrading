# 更新日志

本项目的版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：不兼容改动升 major，向下兼容的功能升 minor，向下兼容的修复升 patch。

升级方式统一走脚本，不要在别处手改 `package.json` 的 `version`：

```bash
# 1) 先把本次改动写进下面的 [Unreleased] 段落
# 2) 升级版本（会把 Unreleased 定版为带日期的版本段落）
npm run bump -- minor     # 或 patch / major / 1.2.3
# 3) 提交并打 tag（脚本执行完会把这些命令打出来）
git add package.json CHANGELOG.md
git commit -m "chore(release): v1.2.0"
git tag -a v1.2.0 -m "v1.2.0"
git push origin main --follow-tags
```

打上 `v*.*.*` 标签后，`.github/workflows/release.yml` 会校验 tag 与 `package.json` 的版本一致，再打包并发布 GitHub Release。

## [Unreleased]

### 新增

- `version` 操作：`GET /api?op=version` 返回包名、版本、仓库与文档地址；面板顶部右侧常驻版本徽标。
- `.github/workflows/npm-publish.yml`：打 `v*.*.*` 标签时自动发布到 npm（需仓库 Secret `NPM_TOKEN`，`npm publish --provenance`，已发布版本幂等跳过）。

## [1.1.0] - 2026-11-22

自 v1.0.0 起的 35 次提交合并发布。控制台从 11 个 Tab 扩到 15 个，工具从 11 个增加到 13 个。

### 新增

- **涨停板 Tab**：按连板梯队（首板/二板/三板…）展示当日涨停股，含封板时间、封单资金、炸板次数与行业。
- **模拟仓**（原「持仓」Tab 改造）：带初始现金 171 万的本地记账账户，支持买入/卖出（按实时现价成交，可手输限价）、加权平均成本、成交流水与重置；持仓行末提供「加仓 / 卖出」快捷按钮。
- **当日盈亏**：模拟仓新增「当日盈亏（较昨收）」列与汇总指标，与「累计盈亏（相对成本）」分列展示。
- **领域分类**：自选股可设置大金融/消费/周期/科技（单选，默认空），支持按领域筛选与快速过滤。
- **龙虎榜**独立 Tab：按代码聚合去重、原因合并，配发散条形图与上榜汇总。
- **快讯 / 公告 / 微博**提升为顶部独立 Tab，支持「只看自选」过滤。
- **提取股票**：解析微博正文里的 A股标的并写入自选，Host 侧后台任务（离开页面不中断），支持专用模型选择。
- **量能模块升级**：情绪仪表、每日涨跌家数对比、三档操作参考（谨慎 / 过渡 / 参与）。
- 自选页新增「如何构建自己的股票池」方法论说明卡。
- 官网文档站（Astro + Starlight，含真实 GUI 截图与架构图）。
- CI / Release GitHub Actions：双 Node 版本语法、清单、打包与冒烟校验。

### 修复

- 量能回退源改用腾讯真实成交额（`newfqkline` 日 K 第 9 列），历史区间逐日精确，`delta` 不再受价格水平漂移影响。
- 东财限流期间量能/广度/交易日历/强势股列表自动回退腾讯源，功能不中断。
- 强势股「+ 自选」按钮补全 busy 态与结果标记，避免误判为无响应。
- 腾讯回退源量柱颜色失效（补齐涨跌幅计算）。
- 官网首页 6 张功能卡片等高对齐；补全 pagefind arm64 optional 依赖。

### 变更

- 「行情自选」更名为「自选」；顶部菜单顺序调整为 自选 / 量能 / 强势股 / 涨停板 / 龙虎榜 / 快讯 / 公告 / 微博 / 模拟仓 / 选股 / 回测 / 预警。
- 取消「资讯」聚合页，其三个视图提升为顶级 Tab。
- 仓库从 `hitrading` 更名为 `dsh-hitrading`（包名 `@atorber/hitrading` 与插件 id 保持不变）。
- 数据源请求优化：失败熔断、股票池持久化到 SQLite、轮询降频。
- `peerDependencies` 的 `@deepseek-ai/dsh-tools` 范围从 `^0.2.2-rc.1` 改为 `>=0.2.2-rc.1 <1.0.0-0`，避免预发布版本被静默排除。

## [1.0.0] - 2026-11-09

首个公开版本：11 个 Agent 工具 + 11-Tab 控制台 + 独立本地 HTTP 服务（默认 8099），SQLite 持久化自选/持仓/预警，纯分析不下单。

[Unreleased]: https://github.com/atorber/dsh-hitrading/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/atorber/dsh-hitrading/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/atorber/dsh-hitrading/releases/tag/v1.0.0
