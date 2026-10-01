/**
 * 台股智慧分析平台 — Cloudflare Worker Proxy
 *
 * 部署方式：
 *   1. 到 https://workers.cloudflare.com 建立帳號（免費）
 *   2. 建立新 Worker，貼上此程式碼
 *   3. 部署後取得 Worker URL（如 https://twstock-proxy.xxx.workers.dev）
 *   4. 把 index.html 裡的 PROXY_BASE 改成你的 Worker URL
 *
 * 免費方案限制：每天 100,000 次請求（日常使用完全夠用）
 */

const ALLOWED_ORIGINS = ['*'];

const YF_BASE     = 'https://query1.finance.yahoo.com';
const TWSE_OA     = 'https://openapi.twse.com.tw';
const TPEX_OA     = 'https://www.tpex.org.tw';
const FINMIND     = 'https://api.finmindtrade.com';
const GNEWS_RSS   = 'https://news.google.com';

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  'Referer': 'https://finance.yahoo.com/',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-cache, no-store',
};

function corsResp(body, status = 200, ct = 'application/json; charset=utf-8') {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': ct },
  });
}

function yfSymbol(code, mkt) {
  code = code.toUpperCase();
  if (code === 'FITX' || code === 'TX') return '^TWII';
  return code + (mkt === 'otc' ? '.TWO' : '.TW');
}

async function fetchYF(url) {
  const r = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) return null;
  return r.json();
}

// ── /api/realtime?symbol=2330&type=tse ──────────────────────────
async function handleRealtime(url) {
  const code = url.searchParams.get('symbol') || '';
  const mkt  = url.searchParams.get('type') || 'tse';
  if (!code) return corsResp(JSON.stringify({ error: 'missing symbol' }), 400);

  const sym = yfSymbol(code, mkt);
  const yfUrl = `${YF_BASE}/v8/finance/chart/${sym}?interval=1m&range=1d&includePrePost=false`;
  const d = await fetchYF(yfUrl);
  if (!d?.chart?.result?.[0]) return corsResp(JSON.stringify({ error: 'fetch failed' }), 502);

  const result = d.chart.result[0];
  const meta   = result.meta;
  const price  = meta.regularMarketPrice;
  const prev   = meta.previousClose ?? price;
  const ts_s   = meta.regularMarketTime ?? 0;

  // 台灣時間 HH:MM:SS
  const tw = new Date((ts_s * 1000) + (8 * 3600 * 1000));
  const pad = n => String(n).padStart(2, '0');
  const tStr = `${pad(tw.getUTCHours())}:${pad(tw.getUTCMinutes())}:${pad(tw.getUTCSeconds())}`;

  const s = {
    n:     meta.shortName || meta.longName || code,
    z:     String(price ?? '-'),
    y:     String(prev),
    o:     String(meta.regularMarketOpen ?? prev),
    h:     String(meta.regularMarketDayHigh ?? price),
    l:     String(meta.regularMarketDayLow ?? price),
    v:     String(meta.regularMarketVolume ?? 0),
    t:     tStr,
    tlong: String(ts_s * 1000),
    trade: { z: String(price ?? '-') },
  };
  return corsResp(JSON.stringify({ msgArray: [s] }));
}

// ── 共用：把 YF chart result 轉成 TWSE 陣列格式 ─────────────────
function yfResultToRows(result) {
  const tsList  = result.timestamp ?? [];
  const q       = result.indicators.quote[0];
  const rows    = [];
  let prevClose = null;
  const pad = n => String(n).padStart(2, '0');

  for (let i = 0; i < tsList.length; i++) {
    const c = q.close[i], o = q.open[i], h = q.high[i], l = q.low[i], v = q.volume[i];
    if (c == null) continue;
    const dt   = new Date((tsList[i] + 8 * 3600) * 1000);
    const date = `${dt.getUTCFullYear()}/${pad(dt.getUTCMonth()+1)}/${pad(dt.getUTCDate())}`;
    const chg  = prevClose ? +(c - prevClose).toFixed(2) : 0;
    const chgS = chg >= 0 ? `+${chg.toFixed(2)}` : chg.toFixed(2);
    rows.push([
      date,
      v ? String(v) : '0',
      v ? String(Math.round(c * v)) : '0',
      o ? o.toFixed(2) : '0.00',
      h ? h.toFixed(2) : '0.00',
      l ? l.toFixed(2) : '0.00',
      c.toFixed(2),
      chgS,
      prevClose ? ((chg / prevClose) * 100).toFixed(2) : '0.00',
      '',
    ]);
    prevClose = c;
  }
  return rows;
}

// ── /api/history?symbol=2330&date=20250101  (TWSE 陣列格式) ──────
// ── /api/history_otc 同上，type 自動推斷 ────────────────────────
async function handleHistory(url) {
  const code    = url.searchParams.get('symbol') || '';
  // type 可由 query param 傳入，或由 pathname 推斷（/api/history_otc → otc）
  const isOtcPath = url.pathname === '/api/history_otc';
  const mkt     = url.searchParams.get('type') || (isOtcPath ? 'otc' : 'tse');
  // months：未傳時預設 3，但若有 date param 只取當月 → 保留 3 個月作為足夠緩衝
  const months  = parseInt(url.searchParams.get('months') || '3', 10);
  if (!code) return corsResp(JSON.stringify({ error: 'missing symbol' }), 400);

  const sym   = yfSymbol(code, mkt);
  const range = months <= 1 ? '1mo' : months <= 3 ? '3mo' : months <= 6 ? '6mo' : months <= 12 ? '1y' : '2y';
  const yfUrl = `${YF_BASE}/v8/finance/chart/${sym}?interval=1d&range=${range}&includePrePost=false`;
  const d = await fetchYF(yfUrl);
  if (!d?.chart?.result?.[0]) return corsResp(JSON.stringify({ error: 'fetch failed' }), 502);

  const rows = yfResultToRows(d.chart.result[0]);
  const body = mkt === 'otc'
    ? JSON.stringify({ aaData: rows })
    : JSON.stringify({ stat: 'OK', data: rows });
  return corsResp(body);
}

// ── /api/historyrange?symbol=2330&months=6  (FinMind 物件格式) ───
// app.js drawOverviewHistory 使用，預期格式：{data:[{date,open,max,min,close,Trading_Volume}]}
async function handleHistoryRange(url) {
  const code   = url.searchParams.get('symbol') || '';
  const mkt    = url.searchParams.get('type') || 'tse';
  const months = parseInt(url.searchParams.get('months') || '6', 10);
  if (!code) return corsResp(JSON.stringify({ data: [] }), 400);

  const sym   = yfSymbol(code, mkt);
  const range = months <= 1 ? '1mo' : months <= 3 ? '3mo' : months <= 6 ? '6mo' : months <= 12 ? '1y' : '2y';
  const yfUrl = `${YF_BASE}/v8/finance/chart/${sym}?interval=1d&range=${range}&includePrePost=false`;
  const d = await fetchYF(yfUrl);
  if (!d?.chart?.result?.[0]) return corsResp(JSON.stringify({ data: [] }), 502);

  const result = d.chart.result[0];
  const tsList = result.timestamp ?? [];
  const q      = result.indicators.quote[0];
  const pad    = n => String(n).padStart(2, '0');
  const data   = [];

  for (let i = 0; i < tsList.length; i++) {
    const c = q.close[i], o = q.open[i], h = q.high[i], l = q.low[i], v = q.volume[i];
    if (c == null) continue;
    const dt   = new Date((tsList[i] + 8 * 3600) * 1000);
    const date = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`;
    data.push({
      date,
      open:  o ? +o.toFixed(2) : 0,
      max:   h ? +h.toFixed(2) : 0,
      min:   l ? +l.toFixed(2) : 0,
      close: +c.toFixed(2),
      Trading_Volume: v || 0,
    });
  }
  return corsResp(JSON.stringify({ data }));
}

// ── /api/taiex ───────────────────────────────────────────────────
async function handleTaiex() {
  const d = await fetchYF(`${YF_BASE}/v8/finance/chart/%5ETWII?interval=1m&range=1d`);
  if (!d?.chart?.result?.[0]) return corsResp(JSON.stringify({ error: 'fetch failed' }), 502);

  const meta   = d.chart.result[0].meta;
  const price  = meta.regularMarketPrice;
  const prev   = meta.previousClose ?? price;
  const ts_s   = meta.regularMarketTime ?? 0;
  const tw     = new Date((ts_s * 1000) + (8 * 3600 * 1000));
  const pad    = n => String(n).padStart(2, '0');
  const tStr   = `${pad(tw.getUTCHours())}:${pad(tw.getUTCMinutes())}:${pad(tw.getUTCSeconds())}`;

  const idx = { n: '加權指數', z: String(price), y: String(prev), t: tStr, tlong: String(ts_s * 1000), trade: { z: String(price) } };
  const fut = { ...idx, n: '台指期（近月）' };
  return corsResp(JSON.stringify({ index: { msgArray: [idx] }, futures: { msgArray: [fut] } }));
}

// ── /api/fundamental?symbol=2330 ────────────────────────────────
// 上市 (TWSE) BWIBBU_ALL 快取
let bwibbuCache = null;
let bwibbuTs    = 0;
// 上櫃 (TPEx) 本益比快取
let tpexCache   = null;
let tpexTs      = 0;

async function handleFundamental(url) {
  const code = url.searchParams.get('symbol') || '';
  const mkt  = url.searchParams.get('type') || 'tse';
  if (!code) return corsResp(JSON.stringify({ error: 'missing symbol' }), 400);

  const now = Date.now();

  // ── TWSE 上市：BWIBBU_ALL ─────────────────────────────────────
  if (mkt !== 'otc') {
    if (!bwibbuCache || now - bwibbuTs > 600000) {
      try {
        const r = await fetch(`${TWSE_OA}/v1/exchangeReport/BWIBBU_ALL`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        });
        if (r.ok) {
          const arr = await r.json();
          bwibbuCache = {};
          for (const item of arr) bwibbuCache[item.Code] = item;
          bwibbuTs = now;
        }
      } catch { }
    }
    const bw = bwibbuCache?.[code] || {};
    if (Object.keys(bw).length) {
      const perData = { data: [{
        PER:            bw.PEratio       || '',
        PBR:            bw.PBratio       || '',
        DividendYield:  bw.DividendYield || '',
        dividend_yield: bw.DividendYield || '',
      }] };
      // 補抓 Yahoo Finance marketCap
      let marketCap = null;
      try {
        const yfD = await fetchYF(`${YF_BASE}/v8/finance/chart/${yfSymbol(code,'tse')}?interval=1d&range=1d`);
        marketCap = yfD?.chart?.result?.[0]?.meta?.marketCap ?? null;
      } catch { }
      return corsResp(JSON.stringify({ per: perData, info: { marketCap } }));
    }
  }

  // ── TPEx 上櫃：BWIBBU_ALL_OTC ────────────────────────────────
  if (!tpexCache || now - tpexTs > 600000) {
    try {
      const r = await fetch(`${TPEX_OA}/web/stock/aftertrading/peratio_listed/ajax_pera.php?l=zh-tw&d=${new Date().toLocaleDateString('zh-TW', {timeZone:'Asia/Taipei'}).replace(/\//g,'/').replace(/^(\d{4})/, y => y-1911)}&o=json`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      if (r.ok) {
        const j = await r.json();
        tpexCache = {};
        for (const row of (j?.aaData || [])) {
          // [代碼, 名稱, 本益比, 殖利率, 淨值比, ...]
          if (row[0]) tpexCache[row[0].trim()] = { PER: row[2], DY: row[3], PBR: row[4] };
        }
        tpexTs = now;
      }
    } catch { }
  }

  const tp = tpexCache?.[code];
  const perData = tp ? { data: [{
    PER:            tp.PER || '',
    PBR:            tp.PBR || '',
    DividendYield:  tp.DY  || '',
    dividend_yield: tp.DY  || '',
  }] } : null;

  // 補抓 Yahoo Finance marketCap（OTC 用 .TWO）
  let marketCap = null;
  try {
    const yfD = await fetchYF(`${YF_BASE}/v8/finance/chart/${yfSymbol(code,'otc')}?interval=1d&range=1d`);
    marketCap = yfD?.chart?.result?.[0]?.meta?.marketCap ?? null;
  } catch { }

  return corsResp(JSON.stringify({ per: perData, info: { marketCap } }));
}

// ── /api/eps?symbol=2330 ─────────────────────────────────────────
async function handleEps(url) {
  const code = url.searchParams.get('symbol') || '';
  const mkt  = url.searchParams.get('type') || 'tse';
  if (!code) return corsResp(JSON.stringify({ data: [] }));

  // 先嘗試傳入的 mkt，若查無結果再試另一市場
  const tryFetch = async (market) => {
    const sym   = yfSymbol(code, market);
    const yfUrl = `${YF_BASE}/v10/finance/quoteSummary/${sym}?modules=incomeStatementHistory`;
    const d = await fetchYF(yfUrl);
    const stmts = d?.quoteSummary?.result?.[0]?.incomeStatementHistory?.incomeStatementHistory;
    if (!stmts?.length) return null;
    return stmts.slice(0, 8).map(s => ({
      date: new Date((s.endDate?.raw ?? 0) * 1000).toISOString().slice(0, 7),
      EPS:  +(s.basicEPS?.raw ?? 0).toFixed(2),
    }));
  };

  try {
    let rows = await tryFetch(mkt);
    if (!rows) rows = await tryFetch(mkt === 'tse' ? 'otc' : 'tse');
    return corsResp(JSON.stringify({ data: rows || [] }));
  } catch {
    return corsResp(JSON.stringify({ data: [] }));
  }
}

// ── /api/etf_holdings?symbol=0050 ───────────────────────────────
async function handleEtfHoldings(url) {
  const code = url.searchParams.get('symbol') || '';
  if (!code) return corsResp(JSON.stringify({ error: 'missing symbol' }), 400);
  try {
    const r = await fetch(
      `${FINMIND}/api/v4/data?dataset=TaiwanETFStockInfo&data_id=${code}&token=`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const body = await r.text();
    return corsResp(body);
  } catch {
    return corsResp(JSON.stringify({ error: 'fetch failed' }), 502);
  }
}

// ── /api/news?q=... ──────────────────────────────────────────────
async function handleNews(url) {
  const q = url.searchParams.get('q') || '';
  if (!q) return corsResp('<rss version="2.0"><channel></channel></rss>', 200, 'text/xml');
  try {
    const r = await fetch(
      `${GNEWS_RSS}/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const xml = await r.text();
    return new Response(xml, {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/xml; charset=utf-8' },
    });
  } catch {
    return corsResp('<rss version="2.0"><channel></channel></rss>', 200, 'text/xml');
  }
}

// ── Main handler ─────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    switch (url.pathname) {
      case '/api/realtime':
      case '/api/intraday':
        return handleRealtime(url);
      case '/api/history':
      case '/api/history_otc':
        return handleHistory(url);
      case '/api/historyrange':
        return handleHistoryRange(url);
      case '/api/taiex':
        return handleTaiex();
      case '/api/fundamental':
        return handleFundamental(url);
      case '/api/eps':
        return handleEps(url);
      case '/api/etf_holdings':
        return handleEtfHoldings(url);
      case '/api/news':
        return handleNews(url);
      default:
        return corsResp(JSON.stringify({ error: 'not found' }), 404);
    }
  },
};
