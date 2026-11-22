// 盘前竞价：展示当日集合竞价（9:15–9:25）阶段的全市场异动与重要信息。
// 免费数据源里只有腾讯 qt.gtimg.cn 在竞价时段给出「虚拟开盘参考价 + 竞价量 + 五档委托」，
// 9:25 之后行情源的 open 定格为竞价格，但竞价量会被全日累计量覆盖。因此采用三态设计：
//   live      交易日 9:15–9:25：腾讯批量实时行情，带并发限流 / 熔断 / 45s 缓存
//   snapshot  9:25 之后或非交易时段：优先读 9:25 定时器落库的 SQLite 定格快照
//   rebuild   无快照（本功能上线前的交易日、或定时器未运行）：用新浪全市场 open 重建
//             个股竞价涨幅与涨跌家数；竞价量/委比无法重建，列显示「—」并标注口径。
import { fetchJson, fetchText } from './http.js';
import { TtlCache } from './cache.js';
import { getTradeDates } from './powerful.js';

export const AUCTION_WINDOW_DAYS = 10;
/** 竞价异动阈值：高开/低开超过该值（%）单独成栏。 */
export const AUCTION_MOVE_PCT = 3;

const SINA_REFERER = 'https://finance.sina.com.cn/';
const QQ_REFERER = 'https://gu.qq.com/';
const SINA_MARKET = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const QQ_QUOTE = 'https://qt.gtimg.cn/q=';

/** 四大指数：竞价时段同样给出虚拟开盘参考价。 */
const INDEX_CODES = [
  { code: '000001', qq: 'sh000001', name: '上证指数' },
  { code: '399001', qq: 'sz399001', name: '深证成指' },
  { code: '399006', qq: 'sz399006', name: '创业板指' },
  { code: '000688', qq: 'sh000688', name: '科创50' },
];

const liveCache = new TtlCache();      // 实时态全市场快照：45s
const rebuildCache = new TtlCache();   // 重建态快照：5min
const universeCache = new TtlCache();  // 全市场代码表：24h
let capturing = false;

const num = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const pad2 = (n) => String(n).padStart(2, '0');
/** 北京时间（不依赖宿主时区）。 */
function bjNow() {
  return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60_000);
}
function bjParts() {
  const d = bjNow();
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    minutes: d.getHours() * 60 + d.getMinutes(),
    clock: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
    weekday: d.getDay(),
  };
}
const isWeekend = (w) => w === 0 || w === 6;

/** 涨跌停阈值（%）：北交所 30、创业板/科创板 20、主板 10（ST 股 ±5% 无法从代码识别，已标注除外）。 */
function limitPct(code) {
  const c = String(code || '');
  if (/^(43|83|87|92)/.test(c)) return 30;
  if (/^(300|301|688|689)/.test(c)) return 20;
  return 10;
}
const isLimitUp = (code, p) => p != null && p >= limitPct(code) - 0.2;
const isLimitDown = (code, p) => p != null && p <= -(limitPct(code) - 0.2);

/** 11 档竞价涨幅分布：统一左闭右开 [min, max)，首档/末档覆盖全部边界，互不重叠。 */
const BANDS = [
  { label: '<-10%', min: -Infinity, max: -10 },
  { label: '-10~-7', min: -10, max: -7 },
  { label: '-7~-5', min: -7, max: -5 },
  { label: '-5~-3', min: -5, max: -3 },
  { label: '-3~-1', min: -3, max: -1 },
  { label: '-1~1', min: -1, max: 1 },
  { label: '1~3', min: 1, max: 3 },
  { label: '3~5', min: 3, max: 5 },
  { label: '5~7', min: 5, max: 7 },
  { label: '7~10', min: 7, max: 10 },
  { label: '≥10%', min: 10, max: Infinity },
];

/**
 * 纯计算：把个股竞价明细汇总成指标卡 / 分档 / 自选提示。导出以便单测。
 * @param {Array} items 每项至少含 {code,name,open,prevClose,openPct,volume,amount,orderRatio,unmatched,industry}
 * @param {{watchCodes?:string[], hasVolume?:boolean}} opts
 */
export function summarize(items, { watchCodes = [], hasVolume = true } = {}) {
  const valid = items.filter((r) => r.openPct != null);
  const pcts = valid.map((r) => r.openPct).sort((a, b) => a - b);
  const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : null;
  const up = valid.filter((r) => r.openPct > 0).length;
  const down = valid.filter((r) => r.openPct < 0).length;
  const flat = valid.filter((r) => r.openPct === 0).length;
  const limitUp = items.filter((r) => isLimitUp(r.code, r.openPct)).length;
  const limitDown = items.filter((r) => isLimitDown(r.code, r.openPct)).length;

  const distribution = BANDS.map((b) => ({
    label: b.label,
    count: valid.filter((r) => r.openPct >= b.min && r.openPct < b.max).length,
  }));

  const volumeShou = hasVolume ? items.reduce((s, r) => s + (r.volume || 0), 0) : null;
  const amountYi = hasVolume && items.some((r) => r.amount != null)
    ? round2(items.reduce((s, r) => s + (r.amount || 0), 0) / 1e8)
    : null;

  const watchSet = new Set(watchCodes.map(String));
  const watchlist = items
    .filter((r) => watchSet.has(String(r.code)))
    .sort((a, b) => Math.abs(b.openPct ?? 0) - Math.abs(a.openPct ?? 0))
    .map((r) => ({
      ...r,
      tag: isLimitUp(r.code, r.openPct) ? '竞价涨停'
        : isLimitDown(r.code, r.openPct) ? '竞价跌停'
          : (r.openPct ?? 0) >= AUCTION_MOVE_PCT ? '大幅高开'
            : (r.openPct ?? 0) <= -AUCTION_MOVE_PCT ? '大幅低开'
              : (r.openPct ?? 0) > 0 ? '高开' : (r.openPct ?? 0) < 0 ? '低开' : '平开',
    }));

  return {
    stats: {
      total: items.length,
      valid: valid.length,
      up, down, flat,
      limitUp, limitDown,
      high3: valid.filter((r) => r.openPct >= AUCTION_MOVE_PCT).length,
      low3: valid.filter((r) => r.openPct <= -AUCTION_MOVE_PCT).length,
      avgPct: pcts.length ? round2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      medianPct: median == null ? null : round2(median),
      volumeShou: volumeShou == null ? null : Math.round(volumeShou),
      amountYi,
      hasVolume,
    },
    distribution,
    watchlist,
  };
}

/** 并发限流 + 连续失败熔断（沿用强势股扫描的口径）。 */
async function mapLimit(items, limit, fn, maxFails = 8) {
  const out = new Array(items.length);
  let i = 0;
  let fails = 0;
  let aborted = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !aborted) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
        fails = 0;
      } catch (e) {
        out[idx] = null;
        if (++fails >= maxFails) aborted = e;
      }
    }
  });
  await Promise.all(workers);
  return { results: out.filter(Boolean), aborted, failed: out.filter((x) => x === null).length };
}

/** 全市场代码表：优先复用强势股持久化 24h 缓存，否则新浪 Market_Center 分页拉取（56 页）。 */
async function getUniverse(tables) {
  const hit = universeCache.get('all');
  if (hit) return hit;
  const saved = tables?.powerful?.get('universe');
  if (saved?.rows?.length >= 1000 && Date.now() - Date.parse(saved.savedAt) < 24 * 3600_000) {
    universeCache.set('all', saved.rows, 24 * 3600_000);
    return saved.rows;
  }
  const rows = [];
  for (let page = 1; page <= 60; page++) {
    const url = `${SINA_MARKET}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&_s_r_a=init`;
    const data = await fetchJson(url, { headers: { Referer: SINA_REFERER }, timeoutMs: 10_000 });
    const list = Array.isArray(data) ? data : [];
    if (!list.length) break;
    for (const r of list) {
      rows.push({ code: String(r.code), name: r.name, market: String(r.symbol || '').startsWith('sh') ? 1 : 0, industry: null });
    }
    if (list.length < 100) break;
  }
  if (rows.length < 1000) throw new Error(`全市场代码表获取不完整（仅 ${rows.length} 只）`);
  universeCache.set('all', rows, 24 * 3600_000);
  return rows;
}

/** 6 位代码 → 腾讯行情前缀：沪市 6/9 开头，北交所 4/8/92 开头，其余深市。 */
const qqCode = (code) => {
  const c = String(code);
  if (/^(4|8|92)/.test(c)) return `bj${c}`;
  if (/^(6|9)/.test(c)) return `sh${c}`;
  return `sz${c}`;
};

/**
 * 解析腾讯批量行情一行：v_sh600519="1~名称~代码~现价~昨收~今开~成交量(手)~..."
 * mode=live：9:15–9:25 用 p[3]（虚拟开盘参考价，随撮合变动）。
 * mode=snapshot：9:25 定格后用 p[5]（今开 = 竞价格，盘中不再变化），
 *   避免定时器延迟到 9:30 后把盘中实时价误当竞价格。
 */
function parseTencentLine(line, mode = 'live') {
  const m = /^v_([a-z]{2}\d{6})="(.*)";?$/.exec(line.trim());
  if (!m) return null;
  const p = m[2].split('~');
  if (p.length < 36) return null;
  const code = p[2];
  const prevClose = num(p[4]);
  const open = num(p[5]);
  const price = num(p[3]);
  // 定格态若今开仍为 0（停牌 / 未撮合），不能退回用现价冒充竞价格；实时态 9:25 前今开本就为 0。
  const ref = mode === 'snapshot'
    ? (open != null && open > 0 ? open : null)
    : (price != null && price > 0 ? price : (open != null && open > 0 ? open : null));
  if (ref == null || !prevClose || prevClose <= 0) return null;   // 停牌 / 未撮合
  const volume = num(p[6]);                       // 成交量（手）
  const amountWan = num(p[37]);                  // 成交额（万元）
  const buyVol = [10, 12, 14, 16, 18].reduce((s, i) => s + (num(p[i]) || 0), 0);
  const sellVol = [20, 22, 24, 26, 28].reduce((s, i) => s + (num(p[i]) || 0), 0);
  const total = buyVol + sellVol;
  const orderRatio = total ? round2(((buyVol - sellVol) / total) * 100) : null;
  const unmatched = total ? Math.round(buyVol - sellVol) : null;  // 委差（手），近似未匹配买量
  const openPct = round2(((ref - prevClose) / prevClose) * 100);
  return {
    code, name: p[1], open: ref, prevClose, openPct,
    volume, amount: amountWan == null ? null : Math.round(amountWan * 1e4),
    orderRatio, unmatched, industry: null,
    ts: p[30] || null,
  };
}

/** 腾讯批量行情（每批 80 只）；竞价时段全市场约 70 请求，并发 8 + 熔断。 */
async function fetchTencentBatch(codes, mode = 'live') {
  const batches = [];
  for (let i = 0; i < codes.length; i += 80) batches.push(codes.slice(i, i + 80));
  const { results, aborted, failed } = await mapLimit(batches, 8, async (batch) => {
    const text = await fetchText(QQ_QUOTE + batch.join(','), {
      headers: { Referer: QQ_REFERER }, timeoutMs: 8000, decode: 'gbk',
    });
    return text.split('\n').map((l) => parseTencentLine(l, mode)).filter(Boolean);
  });
  return { items: results.flat(), aborted, failed };
}

/** 新浪全市场 open 重建：收盘后仍可拿到 9:25 竞价格；无竞价量/委比。 */
async function fetchRebuildItems() {
  const rows = [];
  for (let page = 1; page <= 60; page++) {
    const url = `${SINA_MARKET}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&_s_r_a=init`;
    const data = await fetchJson(url, { headers: { Referer: SINA_REFERER }, timeoutMs: 10_000 });
    const list = Array.isArray(data) ? data : [];
    if (!list.length) break;
    for (const r of list) {
      const prevClose = num(r.settlement);
      const open = num(r.open);
      // 停牌 / 当日无集合竞价：新浪返回 open=0.000，若按 -100% 计入会污染分布与均值。
      if (open == null || open <= 0 || prevClose == null || prevClose <= 0) continue;
      const openPct = round2(((open - prevClose) / prevClose) * 100);
      rows.push({
        code: String(r.code), name: r.name, open, prevClose, openPct,
        volume: null, amount: null, orderRatio: null, unmatched: null,
        industry: null,
      });
    }
    if (list.length < 100) break;
  }
  return rows;
}

/** 指数竞价：竞价/定格时段用腾讯实时行情，历史日期用腾讯指数日K的 open 与前一交易日 close。 */
async function fetchIndices(mode = 'live', date = null) {
  if (mode === 'live' || mode === 'snapshot') {
    const text = await fetchText(QQ_QUOTE + INDEX_CODES.map((x) => x.qq).join(','), {
      headers: { Referer: QQ_REFERER }, timeoutMs: 8000, decode: 'gbk',
    });
    const map = new Map(text.split('\n').map((l) => parseTencentLine(l, mode === 'snapshot' ? 'snapshot' : 'live')).filter(Boolean).map((r) => [r.code, r]));
    return INDEX_CODES.map((x) => {
      const r = map.get(x.code);
      return { code: x.code, name: x.name, open: r?.open ?? null, prevClose: r?.prevClose ?? null, openPct: r?.openPct ?? null };
    }).filter((r) => r.openPct != null);
  }
  // 历史/重建：腾讯指数日K [date, open, close, high, low, volume]
  const out = await Promise.all(INDEX_CODES.map(async (x) => {
    try {
      const t = await fetchText(`https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${x.qq},day,,,14,`, {
        headers: { Referer: QQ_REFERER }, timeoutMs: 9000,
      });
      const d = JSON.parse(t);
      const bars = d?.data?.[x.qq]?.day || [];
      const idx = bars.findIndex((b) => b[0] === date);
      if (idx < 1) return null;
      const open = num(bars[idx][1]);
      const prevClose = num(bars[idx - 1][2]);
      if (open == null || !prevClose) return null;
      return { code: x.code, name: x.name, open, prevClose, openPct: round2(((open - prevClose) / prevClose) * 100) };
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

function watchCodesOf(tables) {
  try { return [...(tables?.watchlist?.keys() || [])].map(String); } catch { return []; }
}

/** 组装返回体（统一口径）。 */
function assemble({ date, phase, phaseLabel, clock, countdown, items, indices, dates, compare, watchCodes, sources, note, hasVolume, extra }) {
  const sum = summarize(items, { watchCodes, hasVolume });
  return {
    date, phase, phaseLabel, clock, countdown,
    dates, indices, compare,
    items: [...items].sort((a, b) => (b.openPct ?? -999) - (a.openPct ?? -999)),
    ...sum,
    sources,
    note,
    fetchedAt: new Date().toISOString(),
    ...(extra || {}),
  };
}

/** 从 SQLite 读取定格快照并重新汇总（自选可能变化，需重算）。 */
function fromSnapshot(snap, date, dates, watchCodes, phaseLabel, clock) {
  const items = snap.items || [];
  const sum = summarize(items, { watchCodes, hasVolume: snap.hasVolume !== false });
  return {
    date, phase: 'snapshot', phaseLabel: phaseLabel || `已定格 · ${date} 09:25`, clock, countdown: null,
    dates,
    indices: snap.indices || [],
    compare: snap.compare || null,
    items: [...items].sort((a, b) => (b.openPct ?? -999) - (a.openPct ?? -999)),
    ...sum,
    sources: snap.sources || ['腾讯批量行情（9:25 定格快照）'],
    note: snap.note || '9:25 集合竞价定格快照：竞价格、竞价量与五档委托为定时器当日 09:25 采集，收盘后不再变化。',
    capturedAt: snap.capturedAt || null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 盘前竞价主入口。
 * @param {{date?:string, force?:boolean}} opts
 * @param {object} tables 需提供 tables.auction（快照表）与 tables.watchlist / tables.powerful
 */
export async function getAuction({ date, force = false } = {}, tables) {
  const windowDates = await getTradeDates();            // 升序，最近 10 个交易日
  const latest = windowDates[windowDates.length - 1];
  const target = date || latest;
  if (!windowDates.includes(target)) {
    throw new Error(`仅支持最近 ${AUCTION_WINDOW_DAYS} 个交易日（${windowDates[0]} ~ ${latest}）`);
  }
  const { date: today, minutes, clock, weekday } = bjParts();
  const isToday = target === latest && latest === today;
  const inWindow = !isWeekend(weekday) && minutes >= 9 * 60 + 15 && minutes < 9 * 60 + 25;
  const phase = isToday && inWindow ? 'live' : (target !== latest ? 'historical' : 'snapshot');

  const dates = [...windowDates].reverse().map((d) => ({
    date: d, isLatest: d === latest,
    hasSnapshot: !!tables?.auction?.get(`auction:${d}`),
  }));
  const watchCodes = watchCodesOf(tables);

  // ---- 历史日期：只读已采集快照；没有则给出指数竞价并明确标注 ----
  if (phase === 'historical') {
    const snap = tables?.auction?.get(`auction:${target}`);
    if (snap) return fromSnapshot(snap, target, dates, watchCodes, `历史快照 · ${target} 09:25`, clock);
    const indices = await fetchIndices('history', target).catch(() => []);
    return assemble({
      date: target, phase: 'historical',
      phaseLabel: `历史交易日 · ${target}`,
      clock, countdown: null, items: [], indices, dates, compare: null, watchCodes,
      sources: ['腾讯指数日K（历史竞价开盘价）'],
      note: '该交易日未采集个股竞价快照（本功能上线后每日 09:25 自动落库）。上方仅展示四大指数的竞价开盘涨跌；历史全市场竞价分布无法由免费接口回溯。',
      hasVolume: false,
      extra: { missingSnapshot: true },
    });
  }

  // ---- 实时竞价（9:15–9:25）----
  if (phase === 'live') {
    const cached = !force ? liveCache.get('live') : null;
    if (cached) return { ...cached, clock, countdown: (9 * 60 + 25) * 60 - (minutes * 60 + bjNow().getSeconds()) };
    const universe = await getUniverse(tables);
    const codes = universe.map((u) => qqCode(u.code));
    const { items: raw, aborted, failed } = await fetchTencentBatch(codes);
    // 补行业（若代码表带）
    const industryOf = new Map(universe.map((u) => [String(u.code), u.industry]));
    const items = raw.map((r) => ({ ...r, industry: industryOf.get(String(r.code)) || null }));
    const indices = await fetchIndices('live').catch(() => []);
    const prev = windowDates[windowDates.length - 2];
    const prevSnap = prev ? tables?.auction?.get(`auction:${prev}`) : null;
    const compare = prevSnap ? {
      date: prev,
      up: prevSnap.stats?.up ?? null,
      limitUp: prevSnap.stats?.limitUp ?? null,
      avgPct: prevSnap.stats?.avgPct ?? null,
      hasStockSnapshot: true,
    } : { date: prev || null, up: null, limitUp: null, avgPct: null, hasStockSnapshot: false };
    const sum = summarize(items, { watchCodes, hasVolume: true });
    compare.deltaUp = compare.up == null ? null : sum.stats.up - compare.up;
    compare.deltaLimitUp = compare.limitUp == null ? null : sum.stats.limitUp - compare.limitUp;
    compare.deltaAvgPct = compare.avgPct == null ? null : round2((sum.stats.avgPct ?? 0) - compare.avgPct);

    const out = assemble({
      date: target, phase: 'live',
      phaseLabel: `竞价中 ${clock} · 距定格 ${Math.max(0, 9 * 60 + 25 - minutes)} 分钟`,
      clock, countdown: Math.max(0, (9 * 60 + 25) * 60 - (minutes * 60 + bjNow().getSeconds())),
      items, indices, dates, compare, watchCodes,
      sources: ['腾讯 qt.gtimg.cn（竞价虚拟开盘参考价 / 竞价量 / 五档委托）', '新浪 Market_Center（全市场代码表）'],
      note: '9:15–9:25 集合竞价实时数据：价格随撮合变动，可撤单，最终以 09:25 定格为准。',
      hasVolume: true,
      extra: {
        partial: !!aborted,
        failedBatches: failed,
        scanNote: aborted ? `连续失败触发熔断，本轮仅覆盖部分股票（失败 ${failed} 批），已保留可用数据。` : null,
      },
    });
    liveCache.set('live', out, 45_000);
    return out;
  }

  // ---- 9:25 之后 / 非交易时段：定格快照优先 ----
  const snap = tables?.auction?.get(`auction:${target}`);
  if (snap) {
    const out = fromSnapshot(snap, target, dates, watchCodes, null, clock);
    // 昨日对比（快照内已存 compare 时用其填充）
    const prev = windowDates[windowDates.length - 2];
    const prevSnap = prev ? tables?.auction?.get(`auction:${prev}`) : null;
    if (!out.compare) {
      out.compare = prevSnap ? {
        date: prev, up: prevSnap.stats?.up ?? null, limitUp: prevSnap.stats?.limitUp ?? null,
        avgPct: prevSnap.stats?.avgPct ?? null, hasStockSnapshot: true,
        deltaUp: out.stats.up - (prevSnap.stats?.up ?? out.stats.up),
        deltaLimitUp: out.stats.limitUp - (prevSnap.stats?.limitUp ?? out.stats.limitUp),
        deltaAvgPct: round2((out.stats.avgPct ?? 0) - (prevSnap.stats?.avgPct ?? 0)),
      } : { date: prev || null, up: null, limitUp: null, avgPct: null, hasStockSnapshot: false };
    }
    out.phaseLabel = latest === today ? `已定格 · ${target} 09:25` : `非交易时段 · ${target} 定格快照`;
    return out;
  }

  // ---- 无快照：用新浪全市场 open 重建（本功能上线前的交易日）----
  const cached = !force ? rebuildCache.get(`rebuild:${target}`) : null;
  if (cached) return { ...cached, clock, phaseLabel: `非交易时段 · ${target} 重建快照`, dates };
  const items = await fetchRebuildItems();
  if (items.length < 1000) throw new Error(`竞价快照重建失败：全市场数据仅 ${items.length} 只`);
  const indices = await fetchIndices('history', target).catch(() => []);
  const out = assemble({
    date: target, phase: 'rebuild',
    phaseLabel: `非交易时段 · ${target} 重建快照`,
    clock, countdown: null, items, indices, dates,
    compare: { date: null, up: null, limitUp: null, avgPct: null, hasStockSnapshot: false },
    watchCodes,
    sources: ['新浪 Market_Center（全市场 open = 9:25 竞价格 / 昨收）', '腾讯指数日K（指数竞价开盘价）'],
    note: '当前交易日没有 9:25 定格快照（本功能上线后每日自动采集）。此处用全市场开盘价重建竞价涨跌与家数分布；竞价量、竞价额、委比与未匹配量无法回溯，表中显示「—」。',
    hasVolume: false,
    extra: { rebuilt: true },
  });
  rebuildCache.set(`rebuild:${target}`, out, 5 * 60_000);
  return out;
}

/**
 * 9:25 定格采集：由 index.js 的定时器在每个交易日 09:25 调用一次，落 SQLite。
 * 与实时态共用腾讯批量抓取；采集失败不抛错（下次定时器会重试）。
 */
export async function captureAuctionSnapshot(tables, date = null) {
  if (capturing) return { ok: false, reason: 'inflight' };
  capturing = true;
  try {
    const windowDates = await getTradeDates();
    const latest = windowDates[windowDates.length - 1];
    // 定时器自动采集时必须是「当日为交易日」：节假日/latest 为上一交易日时不能用今天的数据写历史快照。
    if (!date && latest !== bjParts().date) return { ok: false, reason: 'not-trading-day' };
    const target = date || latest;
    if (tables?.auction?.get(`auction:${target}`)) return { ok: false, reason: 'exists' };
    const universe = await getUniverse(tables);
    const { items: raw, aborted } = await fetchTencentBatch(universe.map((u) => qqCode(u.code)), 'snapshot');
    if (!raw.length || aborted) return { ok: false, reason: aborted ? 'partial' : 'empty' };
    const industryOf = new Map(universe.map((u) => [String(u.code), u.industry]));
    const items = raw.map((r) => ({ ...r, industry: industryOf.get(String(r.code)) || null }));
    const indices = await fetchIndices('snapshot').catch(() => []);
    const sum = summarize(items, { watchCodes: watchCodesOf(tables), hasVolume: true });
    // 双进程（Harness 插件 + 独立 HTTP 服务）可能同时到达 9:25，写入内容等价；put 为幂等覆盖，无副作用。
    tables.auction.put(`auction:${target}`, {
      date: target,
      items, indices,
      stats: sum.stats,
      hasVolume: true,
      capturedAt: new Date().toISOString(),
      sources: ['腾讯 qt.gtimg.cn（9:25 定格：竞价格 / 竞价量 / 五档委托）'],
      note: '9:25 集合竞价定格快照：竞价格、竞价量与五档委托为定时器当日 09:25 采集，收盘后不再变化。',
    });
    return { ok: true, date: target, count: items.length };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  } finally {
    capturing = false;
  }
}
