// 强势股：按交易日展示全市场当日涨幅 > 7% 的股票（最近 10 个交易日）。
// 数据源（免费）：
//   - 东方财富 push2 clist：全市场沪深京 A股列表（实时涨幅排序 / 代码表）
//   - 东方财富 push2his kline：个股前复权日K（历史日期的当日涨幅由相邻收盘价计算）
//   - 东方财富涨停看板 ZTPool：按日涨停池（连板数、首封时间、封单、行业板块）
// 历史日期首次访问需扫描全市场日K（约半分钟），结果按日缓存进 SQLite，之后秒出。
import { fetchJson, fetchText } from './http.js';
import { TtlCache } from './cache.js';
import { normalizeSymbols } from './symbol.js';
import { getQuotes } from './quotes.js';

/** 强势阈值：当日涨幅超过该值（%）。 */
export const POWER_PCT = 7;
/** 支持的交易日窗口。 */
export const WINDOW_DAYS = 10;

const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const ZTPOOL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const UT = '7eea3edcaed734bea9cbfc24409ed989';
/** 沪深京 A股：深主板 + 创业板 + 沪主板 + 科创板 + 北交所 */
const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const PAGE = 100;

const universeCache = new TtlCache(); // 代码表：24h
const liveCache = new TtlCache();     // 最新交易日实时强势列表：60s
const datesCache = new TtlCache();    // 交易日历：5min
const ztCache = new TtlCache();       // 涨停池：10min
let scanInflight = null;              // 全市场扫描去重（同进程）

const cacheKey = (date) => `pct${POWER_PCT}:${date}`;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** 北京时间。 */
function bjNow() {
  return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60_000);
}
/** 实时数据是否已是收盘定稿（可缓存为当日最终名单）。 */
function isFinal(latestDate) {
  const bj = bjNow();
  const today = `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`;
  if (latestDate < today) return true;   // 已收市的交易日
  return bj.getHours() > 15 || (bj.getHours() === 15 && bj.getMinutes() >= 5);
}

/** clist 一页。sort=f3 按实时涨跌幅降序，sort=f12 按代码。返回 {rows, total}。 */
async function clistPage(pn, sort) {
  const url = `${CLIST}?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&fid=${sort}` +
    `&fs=${encodeURIComponent(FS)}&fields=f2,f3,f12,f13,f14,f100`;
  const data = await fetchJson(url, { timeoutMs: 10_000 });
  const d = data?.data;
  if (!d) throw new Error(`东财列表第 ${pn} 页无数据`);
  const rows = (Array.isArray(d.diff) ? d.diff : []).map((r) => ({
    code: String(r.f12), market: r.f13, name: r.f14,
    price: num(r.f2), pctChange: num(r.f3), industry: r.f100 || null,
  }));
  return { rows, total: num(d.total) || 0 };
}

/** 全市场代码表（含行业）：内存 TTL 24h + SQLite 持久化（跨进程/重启复用，省 ~59 请求）。 */
async function getUniverse(tables) {
  const hit = universeCache.get('all');
  if (hit) return hit;
  // SQLite 缓存：24h 内有效
  if (tables?.powerful) {
    try {
      const saved = tables.powerful.get('universe');
      if (saved?.rows?.length >= 1000 && Date.now() - Date.parse(saved.savedAt) < 24 * 3600_000) {
        universeCache.set('all', saved.rows, 24 * 3600_000);
        return saved.rows;
      }
    } catch { /* 缓存读取失败则走网络 */ }
  }
  const out = [];
  let pn = 1;
  let total = 0;
  for (;;) {
    const { rows, total: t } = await clistPage(pn, 'f12');
    if (pn === 1) total = t;
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
    pn++;
    if (pn > 100 || (total && out.length >= total)) break;
  }
  if (out.length < 1000) throw new Error(`全市场代码表获取不完整（仅 ${out.length} 只）`);
  universeCache.set('all', out, 24 * 3600_000);
  if (tables?.powerful) {
    try { tables.powerful.put('universe', { rows: out, savedAt: new Date().toISOString() }); } catch { /* 持久化失败不影响 */ }
  }
  return out;
}

/** 最近交易日历（升序，多取 2 根冗余），以沪市指数为准。东财失败回退腾讯指数日K。 */
export async function getTradeDates() {
  const hit = datesCache.get('dates');
  if (hit) return hit;
  let rows = null;
  try {
    const url = `${KLINE}?secid=1.000001&klt=101&fqt=0&lmt=${WINDOW_DAYS + 2}&end=20500101` +
      `&fields1=f1,f2,f3&fields2=f51,f53`;
    const data = await fetchJson(url, { timeoutMs: 10_000 });
    if (Array.isArray(data?.data?.klines)) rows = data.data.klines.map((line) => String(line).split(',')[0]);
  } catch { /* 东财限流 → 走腾讯 */ }
  if (!rows || rows.length < 2) {
    const qq = await qqIndexDates(WINDOW_DAYS + 2);
    if (qq.length >= 2) rows = qq;
  }
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('交易日历获取失败（数据源暂不可用）');
  const value = rows.slice(-WINDOW_DAYS);
  datesCache.set('dates', value, 5 * 60_000);
  return value;
}

/** 腾讯指数日K的日期列（回退源）。 */
async function qqIndexDates(limit) {
  const t = await fetchText(`https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=sh000001,day,,,${limit},`, { timeoutMs: 9000 });
  const d = JSON.parse(t);
  const key = Object.keys(d.data || {})[0];
  return (d.data?.[key]?.day || []).map((row) => String(row[0]));
}

/** 最新交易日的实时强势列表（涨幅降序翻页，翻到 ≤ 阈值即停），TTL 60s。东财失败回退腾讯 rank。 */
async function getLiveList() {
  const hit = liveCache.get('live');
  if (hit) return hit;
  let items = null;
  try {
    items = await liveListFromEM();
  } catch {
    try { items = await liveListFromQQ(); } catch { items = []; }
  }
  liveCache.set('live', items, 60_000);
  return items;
}

/** 东财源：clist f3 降序翻页。 */
async function liveListFromEM() {
  const items = [];
  for (let pn = 1; pn <= 10; pn++) {
    const { rows } = await clistPage(pn, 'f3');
    let below = false;
    for (const r of rows) {
      if (r.pctChange != null && r.pctChange > POWER_PCT) {
        items.push({ code: r.code, name: r.name, pct: r.pctChange, close: r.price, industry: r.industry });
      }
      if (r.pctChange == null || r.pctChange <= POWER_PCT) below = true;
    }
    if (below || rows.length < PAGE) break;
  }
  items.sort((a, b) => b.pct - a.pct);
  return items;
}

/** 腾讯回退源：rank PriceRatio 降序翻页（zdf 为涨跌幅，code 带 sh/sz 前缀）。 */
async function liveListFromQQ() {
  const items = [];
  for (let pn = 0; pn < 10; pn++) {
    const t = await fetchText(
      `https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=PriceRatio&direct=down&offset=${pn * 100}&count=100`,
      { timeoutMs: 9000 },
    );
    const d = JSON.parse(t);
    const rows = d?.data?.rank_list || [];
    let below = false;
    for (const r of rows) {
      const pct = num(r.zdf);
      if (pct != null && pct > POWER_PCT) {
        const code = String(r.code || '').replace(/^(sh|sz|bj)/i, '');
        if (!/^\d{6}$/.test(code)) continue;
        items.push({ code, name: r.name, pct, close: num(r.zxj), industry: null, source: 'tencent' });
      }
      if (pct == null || pct <= POWER_PCT) below = true;
    }
    if (below || rows.length < 100) break;
  }
  items.sort((a, b) => b.pct - a.pct);
  return items;
}

/** 个股前复权日K收盘：[{date, close}]。 */
async function klineCloses(market, code) {
  const url = `${KLINE}?secid=${market}.${code}&klt=101&fqt=1&lmt=${WINDOW_DAYS + 2}&end=20500101` +
    `&fields1=f1,f2,f3&fields2=f51,f53`;
  const data = await fetchJson(url, { timeoutMs: 8000 });
  const rows = data?.data?.klines;
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map((line) => {
    const f = String(line).split(',');
    return { date: f[0], close: num(f[1]) };
  });
}

/** 简单并发池。 */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 全市场扫描：一次拉取所有个股近 WINDOW_DAYS+2 根日K，
 * 用相邻前复权收盘计算每个交易日的涨幅，>阈值即收录，并按日写入缓存。
 * 同进程内并发去重（预热与用户请求共享同一次扫描）。
 */
async function scanWindow(windowDates, tables) {
  const uncached = windowDates.filter((d) => {
    try { return !tables.powerful.get(cacheKey(d)); } catch { return true; }
  });
  if (!uncached.length) return;
  if (scanInflight) return scanInflight;
  scanInflight = (async () => {
    const universe = await getUniverse(tables);
    const targetSet = new Map(uncached.map((d) => [d, []]));
    let fails = 0;
    let consecutiveFails = 0;
    const MAX_CONSECUTIVE_FAILS = 5;   // 熔断：连续失败说明被限流，立即中止避免烧满全列表
    let aborted = null;
    await mapLimit(universe, 16, async (s) => {
      if (aborted) return;                      // 熔断后快速跳过剩余
      let bars;
      try {
        bars = await klineCloses(s.market, s.code);
        consecutiveFails = 0;
      } catch {
        consecutiveFails += 1;
        fails += 1;
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          aborted = `连续 ${consecutiveFails} 个请求失败，疑似被数据源限流，已中止扫描（已处理 ${Math.min(universe.length, fails + consecutiveFails)} 只）`;
          return;
        }
        return;
      }
      for (let i = 1; i < bars.length; i++) {
        const bucket = targetSet.get(bars[i].date);
        if (!bucket) continue;
        const prev = bars[i - 1].close;
        if (prev == null || bars[i].close == null) continue;
        const pct = round2(((bars[i].close / prev) - 1) * 100);
        if (pct != null && pct > POWER_PCT) {
          bucket.push({ code: s.code, name: s.name, pct, close: bars[i].close, industry: s.industry });
        }
      }
    });
    if (aborted) throw new Error(`全市场扫描中止：${aborted}。请稍后重试（数据源限流恢复后可续扫）`);
    if (fails > universe.length * 0.05) {
      throw new Error(`全市场扫描失败过多（${fails}/${universe.length}），请稍后重试`);
    }
    for (const [d, items] of targetSet) {
      if (!items.length && d !== uncached[uncached.length - 1]) continue; // 无数据的日期不写空缓存（避免污染）
      items.sort((a, b) => b.pct - a.pct);
      tables.powerful.put(cacheKey(d), { pct: POWER_PCT, items, scannedAt: new Date().toISOString() });
    }
  })().finally(() => { scanInflight = null; });
  return scanInflight;
}

const fmtTime = (t) => (t == null ? null : String(t).padStart(6, '0').replace(/^(\d{2})(\d{2})(\d{2})$/, '$1:$2:$3'));

/**
 * 按日涨停池（共用同一份 10min 缓存，避免「强势股」与「涨停板」重复请求东财）：
 *   raw —— 全字段归一化明细，供涨停板 Tab 使用
 *   map —— 增强信息 Map，供强势股沿用原有字段形态
 *   tc  —— 当日涨停总数
 */
const ZT_TTL = 10 * 60_000;
async function loadZtPool(date) {
  const key = date.replace(/-/g, '');
  const hit = ztCache.get(key);
  if (hit) return hit;
  const url = `${ZTPOOL}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1000&sort=fbt%3Aasc&date=${key}`;
  let pool = [];
  let tc = null;
  let ok = false;
  try {
    const data = await fetchJson(url, { timeoutMs: 10_000 });
    tc = data?.data?.tc ?? null;
    pool = data?.data?.pool || [];
    ok = true;
  } catch { /* 涨停池为增强信息，失败不影响主数据 */ }
  const raw = pool.map((p) => {
    const amount = num(p.amount), ltsz = num(p.ltsz), tshare = num(p.tshare), fund = num(p.fund);
    return {
      code: String(p.c),
      name: String(p.n ?? ''),
      price: num(p.p) == null ? null : round2(num(p.p) / 1000),   // 东财 p 为价格×1000
      pct: p.zdp == null ? null : round2(p.zdp),
      amountYi: amount == null ? null : round2(amount / 1e8),        // 成交额（亿）
      floatMcapYi: ltsz == null ? null : round2(ltsz / 1e8),         // 流通市值（亿）
      totalMcapYi: tshare == null ? null : round2(tshare / 1e8),      // 总市值（亿）
      turnover: p.hs == null ? null : round2(p.hs),                   // 换手率 %
      lbc: p.lbc ?? null,                                             // 连板数
      fbt: fmtTime(p.fbt),                                            // 首次封板
      lbt: fmtTime(p.lbt),                                            // 最后封板
      fundWan: fund == null ? null : Math.round(fund / 1e4),          // 封单资金（万）
      zbc: p.zbc ?? null,                                             // 炸板次数
      industry: p.hybk ?? null,                                       // 行业板块
      zttj: p.zttj ?? null,                                           // {days, ct}：days 天 ct 板
    };
  });
  const map = new Map(pool.map((p) => [String(p.c), {
    lbc: p.lbc ?? null,
    fbt: p.fbt ?? null,
    fund: p.fund ?? null,
    zbc: p.zbc ?? null,
    hybk: p.hybk ?? null,
    zttj: p.zttj ?? null,
  }]));
  const entry = { raw, map, tc };
  // 请求失败（东财限流）时不缓存，避免空结果被长时间复用；成功才缓存。
  if (ok) ztCache.set(key, entry, ZT_TTL);
  return entry;
}

/** 供「涨停板」Tab 使用：按日涨停池原始明细（全字段）。历史日期可用。 */
export async function getZtPoolRaw(date) {
  return (await loadZtPool(date)).raw;
}

/** 各日涨停总数（侧栏用，轻量 pagesize=1 请求）。 */
const tcCache = new TtlCache();
export async function getZtPoolTc(date) {
  const key = date.replace(/-/g, '');
  const hit = tcCache.get(key);
  if (hit != null) return hit;
  let tc = null;
  try {
    const data = await fetchJson(`${ZTPOOL}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${key}`, { timeoutMs: 10_000 });
    tc = data?.data?.tc ?? null;
  } catch { /* 侧栏数量失败不影响主数据 */ }
  tcCache.set(key, tc, 5 * 60_000);
  return tc;
}

/** 按日涨停池：{code: {lbc, fbt, fund, zbc, hybk, zttj}}。历史日期可用。 */
async function getZtPool(date) {
  return (await loadZtPool(date)).map;
}

/**
 * 强势股主入口。
 * @param {{date?: string}} opts date：YYYY-MM-DD，缺省为最新交易日
 * @param {{powerful: any}} tables kv 表（按日缓存）
 */
export async function getPowerful({ date } = {}, tables) {
  if (!tables?.powerful) throw new Error('强势股缓存表未初始化');
  const windowDates = await getTradeDates();          // 升序
  const latest = windowDates[windowDates.length - 1];
  const target = date || latest;
  if (!windowDates.includes(target)) {
    throw new Error(`仅支持最近 ${WINDOW_DAYS} 个交易日（${windowDates[0]} ~ ${latest}）`);
  }

  // 1) 目标日期数据：实时（最新交易日）或缓存/扫描（历史日期）
  let baseItems;
  let fromScan = false;
  if (target === latest) {
    baseItems = (await getLiveList()).map((r) => ({ ...r }));
    if (isFinal(latest)) {
      try {
        tables.powerful.put(cacheKey(latest), { pct: POWER_PCT, items: baseItems, scannedAt: new Date().toISOString() });
      } catch { /* 缓存失败不影响返回 */ }
    }
  } else {
    let hit;
    try { hit = tables.powerful.get(cacheKey(target)); } catch { hit = null; }
    if (!hit) {
      await scanWindow(windowDates.slice(0, -1), tables);
      hit = tables.powerful.get(cacheKey(target));
      fromScan = true;
    }
    if (!hit) throw new Error('强势股扫描未完成，请重试');
    baseItems = hit.items.map((r) => ({ ...r }));
  }

  // 2) 侧栏各日数量：缓存的读缓存，最新交易日用实时列表
  const live = target === latest ? baseItems : await getLiveList().catch(() => null);
  const datesDesc = [...windowDates].reverse().map((d) => {
    if (d === latest) return { date: d, count: live ? live.length : null, isLatest: true };
    try {
      const c = tables.powerful.get(cacheKey(d));
      return { date: d, count: c ? c.items.length : null, isLatest: false };
    } catch {
      return { date: d, count: null, isLatest: false };
    }
  });

  // 3) 增强：涨停池（连板/首封/封单/行业）+ 最新行情
  const zt = await getZtPool(target);
  const codes = baseItems.map((r) => r.code);
  const qmap = new Map();
  if (codes.length) {
    try {
      const { quotes } = await getQuotes(normalizeSymbols(codes));
      for (const q of quotes) qmap.set(q.code, q);
    } catch { /* 行情增强失败不影响 */ }
  }
  const items = baseItems.map((r) => {
    const z = zt.get(r.code) || null;
    const q = qmap.get(r.code);
    return {
      code: r.code,
      name: r.name,
      pct: r.pct,
      close: r.close,
      industry: r.industry || (z && z.hybk) || null,
      zt: z ? { lbc: z.lbc, fbt: fmtTime(z.fbt), fund: z.fund, zbc: z.zbc, zttj: z.zttj } : null,
      latestPct: (q && q.pctChange != null) ? q.pctChange : null,
      latestPrice: (q && q.price != null) ? q.price : null,
    };
  });

  const ztCount = items.filter((r) => r.zt).length;
  const lbcs = items.map((r) => (r.zt?.lbc ?? 0)).filter((v) => v > 0);
  // 数据源判定：最新交易日带 source 标记的一律为腾讯回退；历史缓存 + 涨停池来自东财
  const fromTencent = target === latest && baseItems.some((r) => r.source === 'tencent');
  return {
    pct: POWER_PCT,
    date: target,
    dates: datesDesc,
    items,
    stats: {
      count: items.length,
      ztCount,
      maxLbc: lbcs.length ? Math.max(...lbcs) : null,
      avgPct: items.length ? round2(items.reduce((a, b) => a + (b.pct ?? 0), 0) / items.length) : null,
    },
    note: fromTencent
      ? '当日名单为腾讯回退源（沪深两市，不含北交所）；涨停/连板/封单等增强信息不可用'
      : target === latest
        ? '最新交易日为实时数据（盘中持续变化）；收盘后自动定稿缓存'
        : '历史日期由前复权日K计算（收盘价为前复权口径），已缓存',
    fromScan,
    source: fromTencent ? 'tencent' : 'eastmoney',
    fetchedAt: new Date().toISOString(),
  };
}
