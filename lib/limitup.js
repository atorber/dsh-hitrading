// 涨停板：按交易日展示全市场涨停股票，并按连板数分组（首板 / 二板 / 三板 …）。
// 数据源：东方财富涨停看板 ZTPool（push2ex/getTopicZTPool），历史日期同样可用。
// 交易日历与涨停池请求与「强势股」共用同一份内存缓存（见 lib/powerful.js），避免重复请求被限流。
import { getTradeDates, getZtPoolRaw, getZtPoolTc, WINDOW_DAYS } from './powerful.js';

/** 连板数 → 中文标签。1=首板，2=二板 … 10=十板，>10 用「N连板」。 */
const CN = ['', '首', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export function boardLabel(lbc) {
  const n = Number(lbc);
  if (!Number.isFinite(n) || n < 1) return '未知';
  if (n <= 10) return `${CN[n]}板`;
  return `${n}连板`;
}

/**
 * 涨停板主入口。
 * @param {{date?: string}} opts date：YYYY-MM-DD，缺省为最新交易日
 * @param {object} tables 保留参数（与 runOp 调用签名一致；本模块暂不写库）
 */
export async function getLimitUp({ date } = {}, tables) {
  const windowDates = await getTradeDates();                 // 升序
  const latest = windowDates[windowDates.length - 1];
  const target = date || latest;
  if (!windowDates.includes(target)) {
    throw new Error(`仅支持最近 ${WINDOW_DAYS} 个交易日（${windowDates[0]} ~ ${latest}）`);
  }

  // 目标日明细先取（其余各日走轻量 pagesize=1 并发），避免同一天并发两次请求穿透缓存。
  const items = await getZtPoolRaw(target);
  const tcs = await Promise.all(windowDates.map((d) => (d === target
    ? Promise.resolve(items.length)
    : getZtPoolTc(d))));

  const dates = [...windowDates].reverse().map((d, i) => ({
    date: d,
    count: tcs[windowDates.length - 1 - i],
    isLatest: d === latest,
  }));

  // 连板分组：升序（首板 → 最高板）
  const byLbc = new Map();
  for (const it of items) {
    const key = it.lbc || 1;
    if (!byLbc.has(key)) byLbc.set(key, []);
    byLbc.get(key).push(it);
  }
  const groups = [...byLbc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lbc, rows]) => ({ lbc, label: boardLabel(lbc), count: rows.length }));

  const lbcs = items.map((r) => r.lbc || 1);
  const gt1 = items.filter((r) => (r.lbc || 1) > 1).length;
  const fundWan = items.map((r) => r.fundWan).filter((v) => v != null);
  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    date: target,
    dates,
    items,
    groups,
    stats: {
      count: items.length,
      firstCount: items.length - gt1,      // 首板家数
      againCount: gt1,                     // 连板（≥2 板）家数
      maxLbc: lbcs.length ? Math.max(...lbcs) : null,
      maxBoard: lbcs.length ? boardLabel(Math.max(...lbcs)) : '-',
      brokenCount: items.filter((r) => (r.zbc || 0) > 0).length,  // 曾炸板家数
      avgFundWan: fundWan.length ? Math.round(fundWan.reduce((a, b) => a + b, 0) / fundWan.length) : null,
      totalFundYi: fundWan.length ? round2(fundWan.reduce((a, b) => a + b, 0) / 1e4) : null,
    },
    note: target === latest
      ? '最新交易日为盘中实时涨停池（盘中可能开板/炸板，收盘后定稿）'
      : `${target} 的涨停池为收盘定稿数据`,
    source: 'eastmoney',
    fetchedAt: new Date().toISOString(),
  };
}
