/* =============================================================
   台股智慧分析平台 — app.js（網頁版 / GitHub Pages）
   資料來源：Yahoo Finance、TWSE OpenAPI、FinMind、Google News
   透過 Cloudflare Worker Proxy 存取（無需本地伺服器）
   ============================================================= */
'use strict';

// ─────────────────────────────────────────────
// 🔧 Cloudflare Worker Proxy URL（部署後請修改此處）
// 部署教學見 README.md
// ─────────────────────────────────────────────
const PROXY_BASE = 'https://YOUR-WORKER.workers.dev';

// ─────────────────────────────────────────────
// 工具函式
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
// TWSE API：頂層 z 在撮合間隙為 '-'，即時成交價藏在 trade.z 子物件
// 取即時成交價：trade.z → 頂層 z → fallback null（由呼叫端決定是否用昨收 y）
const livePrice = s => {
  if (!s) return null;
  const tz = s.trade?.z;
  if (tz && tz !== '-') return tz;
  const z  = s.z;
  if (z  && z  !== '-') return z;
  return null;
};
const fmt = (n, d = 2) => n != null && !isNaN(n) ? Number(n).toFixed(d) : '--';
const fmtNum = n => {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' 兆';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 億';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 萬';
  return Number(n).toLocaleString();
};
const fmtVol = n => {
  if (!n) return '--';
  n = parseInt(n.toString().replace(/,/g, ''));
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 億股';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 萬股';
  return n.toLocaleString() + ' 股';
};
const toFloat = s => parseFloat((s || '0').toString().replace(/,/g, '')) || 0;

let currentStock = null;
let charts = {};

function showLoading(text = '資料載入中...') {
  $('loadingText').textContent = text;
  $('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { $('loadingOverlay').classList.add('hidden'); }
function setVal(id, val) { const e = $(id); if (e) e.textContent = val ?? '--'; }

// ─────────────────────────────────────────────
// 儀表板渲染
// ─────────────────────────────────────────────
function renderDashboard() {
  const tpl = document.getElementById('dashboardTemplate');
  const main = document.getElementById('mainContent');
  main.innerHTML = '';
  main.appendChild(tpl.content.cloneNode(true));

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.remove('active'); c.classList.add('hidden');
      });
      btn.classList.add('active');
      const t = $(`tab-${btn.dataset.tab}`);
      if (t) { t.classList.remove('hidden'); t.classList.add('active'); }
    });
  });

  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawCandleForPeriod(btn.dataset.period);
    });
  });
}

// ─────────────────────────────────────────────
// 主分析入口
// ─────────────────────────────────────────────
// ── 個股即時輪詢（5秒更新，累積分時序列）────────
let stockPollTimer = null;
let intradayPoints = [];   // { ts: ms, price: number, vol: number }
let intradayPrev   = 0;    // 昨收價

function startStockPoll(code, type) {
  stopStockPoll();
  intradayPoints = [];
  const poll = async () => {
    try {
      const res  = await fetch(`${PROXY_BASE}/api/realtime?symbol=${code}&type=${type}`, { cache: 'no-store' });
      const json = await res.json();
      const s    = json?.msgArray?.[0];
      if (!s) return;
      const liveZ  = livePrice(s);          // trade.z → z → null
      const price  = toFloat(liveZ || s.y);
      intradayPrev = toFloat(s.y);

      // 時間：優先用 API 回傳的台灣時間字串 s.t（格式 HH:MM:SS），避免 tlong 時區問題
      const timeStr = s.t && /^\d{2}:\d{2}/.test(s.t) ? s.t.substring(0,5) : null; // HH:MM
      const ts      = parseInt(s.tlong) || Date.now();

      // 只在有即時成交價時才累積分時點
      const sess = getSession();
      if ((sess === 'day' || sess === 'between') && liveZ && price > 0 && timeStr) {
        const last = intradayPoints[intradayPoints.length - 1];
        if (!last || timeStr > last.timeStr) {
          intradayPoints.push({ ts, timeStr, price, vol: toFloat(s.tv) });
        } else if (last && timeStr === last.timeStr) {
          last.price = price;   // 同分鐘更新
          last.vol   = toFloat(s.tv);
        }
      }
      // 更新右上角即時數字
      updateRealtimeHeader(s);
      // 若總覽圖表正在顯示日盤走勢，即時更新
      if (overviewSession === 'day') updateIntradayChart();
    } catch { }
  };
  poll();
  stockPollTimer = setInterval(poll, 3000);  // 3 秒一次（TWSE API 約 3 秒更新）
}

function stopStockPoll() {
  if (stockPollTimer)   { clearInterval(stockPollTimer);   stockPollTimer   = null; }
  if (etfHoldingsTimer) { clearInterval(etfHoldingsTimer); etfHoldingsTimer = null; }
}

function updateRealtimeHeader(s) {
  const liveZ = livePrice(s);
  const cur   = toFloat(liveZ || s.y);
  const prev  = toFloat(s.y);
  const chg  = cur - prev;
  const pct  = prev ? chg / prev * 100 : 0;
  const curEl = $('currentPrice');
  if (curEl) curEl.textContent = cur.toFixed(2);
  const chgEl = $('priceChange');
  if (chgEl) {
    chgEl.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)} (${Math.abs(pct).toFixed(2)}%)`;
    chgEl.className = 'price-change ' + (chg >= 0 ? 'up' : 'down');
  }
  setVal('updateTime', `更新時間：${new Date().toLocaleString('zh-TW')}`);
  setVal('volume', fmtVol(s.v));
  setVal('highPrice', fmt(toFloat(s.h)));
  setVal('lowPrice',  fmt(toFloat(s.l)));
}

// ── 即時更新分時圖表（每5秒由輪詢呼叫）────────
function updateIntradayChart() {
  if (!intradayPoints.length) return;
  // 若圖表尚未建立（使用者還沒點日盤走勢），先建立
  if (!charts.overview) {
    buildIntradayChart(intradayPrev, intradayPrev, intradayPrev, intradayPrev,
      '#ef4444', [], []);
  }
  fillIntradayChart(intradayPrev);
}

// 判斷是否為台灣 ETF（代碼以 0 開頭，如 0050 / 00878 / 006208 等）
function isETF(code) {
  return /^0\d{3,5}[A-Za-z]?$/.test(code);
}

async function analyzeStock(rawCode) {
  const code = rawCode.trim().replace(/[^0-9A-Za-z]/g, '');
  if (!code) return;
  currentStock = { code, isOTC: false };
  renderDashboard();
  showLoading('取得即時行情...');

  // 若為 ETF，顯示「ETF 成分股」tab
  if (isETF(code)) {
    document.querySelectorAll('.etf-tab').forEach(t => t.classList.remove('hidden'));
  } else {
    document.querySelectorAll('.etf-tab').forEach(t => t.classList.add('hidden'));
  }

  try {
    // 1. 即時行情（先試上市，失敗試上櫃）
    // 注意：盤間休息時 z（成交價）為 '-'，但 n（名稱）仍有值，
    // 以 n 是否存在判斷股票是否找到，避免休息時間誤判為找不到
    const tryFetch = async (c, t) => {
      let rt = await fetchRealtime(c, t);
      let s  = rt?.msgArray?.[0];
      // 若第一次拿到空結果（TWSE 偶爾在連線剛建立時回空），等 800ms 重試一次
      if (!s?.n) {
        await new Promise(r => setTimeout(r, 800));
        rt = await fetchRealtime(c, t);
        s  = rt?.msgArray?.[0];
      }
      return s;
    };

    let stock = await tryFetch(code, 'tse');
    if (!stock?.n) {
      stock = await tryFetch(code, 'otc');
      currentStock.isOTC = true;
    }
    if (!stock?.n) throw new Error('找不到此股票代碼，請確認代碼是否正確。\n\n可能原因：\n• 代碼輸入錯誤\n• Cloudflare Worker 尚未部署或 PROXY_BASE 未設定（請見 README.md）\n• Yahoo Finance / TWSE API 暫時無回應，請稍後再試');

    currentStock.realtime = stock;
    renderRealtime(stock, code);

    // 2. 歷史K線（抓過去3個月）
    showLoading('載入歷史K線...');
    await loadHistoryMultiMonth(code, 3);

    // 3. 基本面
    showLoading('載入基本面資料...');
    await loadFundamental(code);

    // 4. EPS
    await loadEPS(code);

    // 5. 新聞
    showLoading('載入新聞...');
    await loadNews(code, stock.n);

    // 6. 預測
    showLoading('計算漲跌機率...');
    renderPrediction();

    // 7. ETF 成分股（僅 ETF）
    if (isETF(code)) {
      showLoading('載入 ETF 成分股...');
      await loadEtfHoldings(code);
    }

    hideLoading();

    // 8. 啟動即時輪詢（日盤）
    const type = currentStock.isOTC ? 'otc' : 'tse';
    startStockPoll(code, type);
  } catch (err) {
    hideLoading();
    alert('分析失敗：' + err.message);
  }
}

// ─────────────────────────────────────────────
// 1. TWSE 即時行情
// ─────────────────────────────────────────────
async function fetchRealtime(code, type = 'tse') {
  try {
    const res = await fetch(`${PROXY_BASE}/api/realtime?symbol=${code}&type=${type}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function renderRealtime(s, code) {
  // s 欄位：n=名稱 z=成交 o=開盤 h=最高 l=最低 v=成交量 y=昨收
  const cur  = toFloat(livePrice(s) || s.y);
  const prev = toFloat(s.y);
  const chg  = cur - prev;
  const chgPct = prev ? chg / prev * 100 : 0;

  setVal('stockName', s.n || '--');
  setVal('stockCode', code);
  setVal('stockMarket', currentStock.isOTC ? '上櫃 TPEx' : '上市 TWSE');

  setVal('currentPrice', cur.toFixed(2));
  const chgEl = $('priceChange');
  if (chgEl) {
    chgEl.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)} (${Math.abs(chgPct).toFixed(2)}%)`;
    chgEl.className = 'price-change ' + (chg >= 0 ? 'up' : 'down');
  }
  setVal('updateTime', `更新時間：${new Date().toLocaleString('zh-TW')}`);

  setVal('openPrice',  fmt(toFloat(s.o)));
  setVal('highPrice',  fmt(toFloat(s.h)));
  setVal('lowPrice',   fmt(toFloat(s.l)));
  setVal('volume',     fmtVol(s.v));

  // 52週先清空，等歷史資料載入後再更新
  setVal('week52High', '--'); setVal('week52Low', '--');
  setVal('peRatio', '--'); setVal('pbRatio', '--');
  setVal('dividendYield', '--'); setVal('eps', '--');
  setVal('beta', '--'); setVal('marketCap', '--');
}

// ─────────────────────────────────────────────
// 2. TWSE 歷史K線（多月合併）
// ─────────────────────────────────────────────
async function loadHistoryMultiMonth(code, months) {
  const mkt = currentStock.isOTC ? 'otc' : 'tse';
  // 一次呼叫 historyrange，取得物件格式，比逐月迴圈更可靠（避免重複資料）
  try {
    const res  = await fetch(`${PROXY_BASE}/api/historyrange?symbol=${code}&type=${mkt}&months=${months}`);
    const json = await res.json();
    const data = json?.data || [];
    if (!data.length) return;

    const allRows = data.map(d => ({
      date:   d.date,
      vol:    d.Trading_Volume,
      open:   d.open,
      high:   d.max,
      low:    d.min,
      close:  d.close,
      change: 0
    })).filter(r => r.close > 0);

    if (!allRows.length) return;
    currentStock.history = allRows;

    // 52週高低
    const closes = allRows.map(r => r.close).filter(Boolean);
    const highs  = allRows.map(r => r.high).filter(Boolean);
    const lows   = allRows.map(r => r.low).filter(Boolean);
    setVal('week52High', Math.max(...highs).toFixed(2));
    setVal('week52Low',  Math.min(...lows).toFixed(2));

    drawCandle(allRows);
    drawVolume(allRows);
    drawOverviewLine(allRows);
    renderTechSummary(allRows);
    drawRSI(allRows);
    drawMACD(allRows);
  } catch (e) { console.warn('loadHistoryMultiMonth error', e); }
}

function parseHistoryRows(json, isOTC) {
  // TWSE: json.data 每筆 = [日期,成交股數,成交金額,開盤,最高,最低,收盤,漲跌,成交筆數]
  // TPEx: json.iTotalRecords, json.aaData 每筆 = [日期,成交股數,成交金額,開盤,最高,最低,收盤,漲跌,成交筆數]
  try {
    const raw = json.data || json.aaData || [];
    return raw.map(r => ({
      date:   r[0],
      vol:    toFloat(r[1]),
      open:   toFloat(r[3]),
      high:   toFloat(r[4]),
      low:    toFloat(r[5]),
      close:  toFloat(r[6]),
      change: toFloat(r[7])
    })).filter(r => r.close > 0);
  } catch { return []; }
}

// ─────────────────────────────────────────────
// ETF 成分股：NAV 估算 + 溢折價 + 成分股表格
// ─────────────────────────────────────────────
let etfHoldingsTimer = null;

async function loadEtfHoldings(code) {
  try {
    // 1. 拉 FinMind 成分股資料（帶權重比例）
    const res  = await fetch(`${PROXY_BASE}/api/etf_holdings?symbol=${code}`);
    const json = await res.json();
    const data = json?.data;
    if (!data || !data.length) {
      renderEtfHoldingsTable([], 0, 0);
      return;
    }

    // FinMind TaiwanETFStockInfo 欄位：
    //   stock_id（成分股代碼）, stock_name, percentage（佔比 %）, date
    // 取最新一期（date 最大）的成分股清單
    const latestDate = data.reduce((a, b) => b.date > a ? b.date : a, '');
    const holdings   = data.filter(d => d.date === latestDate);

    currentStock.etfHoldings = holdings;
    currentStock.etfDate     = latestDate;

    setVal('etfHoldingsMeta', `資料日期：${latestDate}，共 ${holdings.length} 檔成分股`);

    // 2. 並發取所有成分股即時價格
    await refreshEtfHoldings();

    // 3. 每 10 秒更新一次成分股即時價（日盤期間）
    if (etfHoldingsTimer) clearInterval(etfHoldingsTimer);
    etfHoldingsTimer = setInterval(async () => {
      if (getSession() === 'day' || getSession() === 'between') {
        await refreshEtfHoldings();
      }
    }, 10000);
  } catch (e) {
    console.warn('ETF holdings error', e);
  }
}

async function refreshEtfHoldings() {
  const holdings = currentStock.etfHoldings;
  if (!holdings || !holdings.length) return;

  // 並發抓所有成分股即時價（最多 30 支，避免打爆上游）
  const slice = holdings.slice(0, 30);
  const prices = await Promise.all(
    slice.map(async h => {
      try {
        const r = await fetch(`${PROXY_BASE}/api/realtime?symbol=${h.stock_id}&type=tse`, { cache: 'no-store' });
        const j = await r.json();
        const s = j?.msgArray?.[0];
        const price = toFloat(livePrice(s) || s?.y) || 0;
        return { ...h, price, change: toFloat(s?.ud || 0), chgPct: toFloat(s?.udp || 0), name: s?.n || h.stock_name };
      } catch { return { ...h, price: 0 }; }
    })
  );

  // 計算估算 NAV：Σ(成分股價 × 佔比%) / 100
  // 注意 percentage 欄位已是百分比數值（如 30.5 代表 30.5%）
  let navSum      = 0;
  let weightSum   = 0;
  for (const h of prices) {
    const w = toFloat(h.percentage);
    if (h.price > 0 && w > 0) {
      navSum    += h.price * w;
      weightSum += w;
    }
  }
  // 以覆蓋到的權重比例估算（未抓到價格的成分股不納入）
  const estNav = weightSum > 0 ? navSum / weightSum : 0;

  // ETF 目前市價
  const etfPrice = toFloat(livePrice(currentStock.realtime) || currentStock.realtime?.y) || 0;

  renderEtfPremium(etfPrice, estNav, weightSum);
  renderEtfHoldingsTable(prices, etfPrice, estNav);
}

function renderEtfPremium(etfPrice, estNav, weightCoverage) {
  const premiumEl = $('etfPremium');
  const navEl     = $('etfNav');
  const mpEl      = $('etfMarketPrice');
  const noteEl    = $('etfPremiumNote');
  const cardEl    = $('etfPremiumCard');
  if (!premiumEl) return;

  if (mpEl)  mpEl.textContent  = etfPrice > 0 ? etfPrice.toFixed(2) : '--';
  if (navEl) navEl.textContent = estNav   > 0 ? estNav.toFixed(3)   : '--';

  if (etfPrice > 0 && estNav > 0) {
    const pct = (etfPrice - estNav) / estNav * 100;
    const isP = pct >= 0;
    premiumEl.textContent  = `${isP ? '▲ 溢價' : '▼ 折價'} ${Math.abs(pct).toFixed(2)}%`;
    premiumEl.className    = 'etf-nav-val etf-premium-val ' + (isP ? 'premium-up' : 'premium-down');
    if (cardEl) cardEl.className = 'etf-premium-card ' + (isP ? 'card-premium' : 'card-discount');
    if (noteEl) noteEl.textContent =
      `以前 ${Math.round(weightCoverage)}% 權重成分股估算 NAV。` +
      (isP
        ? `目前市價高於 NAV ${Math.abs(pct).toFixed(2)}%，投資人以溢價買入。`
        : `目前市價低於 NAV ${Math.abs(pct).toFixed(2)}%，投資人以折價買入。`);
  } else {
    premiumEl.textContent = '--';
    if (noteEl) noteEl.textContent = '盤間休息或資料不足，無法即時估算 NAV。';
  }
}

function renderEtfHoldingsTable(holdings, etfPrice, estNav) {
  const el = $('etfHoldingsTable');
  if (!el) return;
  if (!holdings.length) {
    el.innerHTML = '<div class="etf-loading">無成分股資料</div>';
    return;
  }

  const rows = holdings.map((h, i) => {
    const pct    = toFloat(h.percentage);
    const price  = h.price;
    const chg    = toFloat(h.chgPct);
    const isUp   = chg > 0;
    const isDn   = chg < 0;
    return `<div class="etf-row">
      <div class="etf-rank">${i + 1}</div>
      <div class="etf-stock-info">
        <span class="etf-stock-name">${h.name || h.stock_name}</span>
        <span class="etf-stock-code">${h.stock_id}</span>
      </div>
      <div class="etf-weight">${pct.toFixed(2)}%</div>
      <div class="etf-price ${isUp ? 'up' : isDn ? 'down' : ''}">
        ${price > 0 ? price.toFixed(2) : '--'}
      </div>
      <div class="etf-chg ${isUp ? 'up' : isDn ? 'down' : ''}">
        ${price > 0 ? (isUp ? '▲' : isDn ? '▼' : '') + ' ' + Math.abs(chg).toFixed(2) + '%' : '--'}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="etf-row etf-row-header">
      <div class="etf-rank">#</div>
      <div class="etf-stock-info">成分股</div>
      <div class="etf-weight">佔比</div>
      <div class="etf-price">即時價</div>
      <div class="etf-chg">漲跌幅</div>
    </div>
    ${rows}`;
}

// ─────────────────────────────────────────────
// 3. FinMind 基本面
// ─────────────────────────────────────────────
async function loadFundamental(code) {
  try {
    const type = currentStock?.isOTC ? 'otc' : 'tse';
    const res  = await fetch(`${PROXY_BASE}/api/fundamental?symbol=${code}&type=${type}`);
    const json = await res.json();

    // PER / PBR / 殖利率（server.py 回傳 per.data 陣列相容原格式）
    const perData  = json.per?.data;

    if (perData && perData.length) {
      const last = perData[perData.length - 1];
      setVal('peRatio',       fmt(toFloat(last.PER)));
      setVal('pbRatio',       fmt(toFloat(last.PBR)));
      const dy = last.dividend_yield || last.DividendYield;
      setVal('dividendYield', dy != null && dy !== '' ? toFloat(dy).toFixed(2) + '%' : '--');
      currentStock.perHistory = perData;
    }

    // 市值（來自 Yahoo Finance meta.marketCap）
    const mc = json.info?.marketCap;
    if (mc) setVal('marketCap', fmtNum(mc));

    // 公司資訊（若有 info.data 陣列則保留舊邏輯）
    const infoData = json.info?.data;
    if (infoData && infoData.length) {
      const info = infoData[0];
      currentStock.info = info;
      renderCompanyInfo(info);
    }

    renderFinancialRatios(json);
  } catch (e) { console.warn('fundamental error', e); }
}

function renderCompanyInfo(info) {
  const rows = [
    ['公司名稱', info.stock_name],
    ['股票代碼', info.stock_id],
    ['產業類別', info.industry_category],
    ['市場類別', info.type === 'twse' ? '上市 TWSE' : '上櫃 TPEx'],
  ];
  const el = $('companyInfo');
  if (el) el.innerHTML = rows.map(([k, v]) =>
    `<div class="info-row"><span class="info-label">${k}</span><span class="info-val">${v || '--'}</span></div>`
  ).join('');
  const sumEl = $('businessSummary');
  if (sumEl) sumEl.textContent = `${info.stock_name}（${info.stock_id}）屬於 ${info.industry_category || '--'} 產業。`;
}

function renderFinancialRatios(json) {
  const perData = json.per?.data;
  if (!perData || !perData.length) return;
  const last = perData[perData.length - 1];
  const dy = last.dividend_yield ?? last.DividendYield;
  const ratios = [
    ['本益比 P/E',   fmt(toFloat(last.PER))],
    ['股價淨值比 P/B', fmt(toFloat(last.PBR))],
    ['殖利率',       dy != null && dy !== '' ? toFloat(dy).toFixed(2) + '%' : '--'],
  ];
  const el = $('financialRatios');
  if (el) el.innerHTML = ratios.map(([k, v]) =>
    `<div class="ratio-item"><div class="ratio-name">${k}</div><div class="ratio-val">${v}</div></div>`
  ).join('');
}

// ─────────────────────────────────────────────
// 4. FinMind EPS
// ─────────────────────────────────────────────
async function loadEPS(code) {
  try {
    const type = currentStock?.isOTC ? 'otc' : 'tse';
    const res  = await fetch(`${PROXY_BASE}/api/eps?symbol=${code}&type=${type}`);
    const json = await res.json();
    const data = json.data;
    if (!data || !data.length) return;
    currentStock.eps = data;
    // 相容大寫 EPS（Yahoo Finance）和小寫 eps（FinMind）
    const lastEps = data[data.length - 1];
    setVal('eps', fmt(lastEps?.EPS ?? lastEps?.eps));
    drawEPSChart(data.slice(-8));
  } catch (e) { console.warn('eps error', e); }
}

function drawEPSChart(data) {
  const labels = data.map(d => d.date?.substring(0, 7) || d.quarter || '--');
  const values = data.map(d => d.EPS ?? d.eps);
  const dom = $('epsChart');
  if (!dom) return;
  if (charts.eps) charts.eps.dispose();
  charts.eps = echarts.init(dom, 'dark');
  charts.eps.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 50, right: 20, top: 20, bottom: 40 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#7b82a0', fontSize: 10 } },
    yAxis: { splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0' } },
    series: [{
      type: 'bar', data: values.map(v => ({
        value: v,
        itemStyle: { color: v >= 0 ? '#4f8ef7' : '#ef4444' }
      })), barMaxWidth: 40
    }]
  });
}

// ─────────────────────────────────────────────
// 5. 技術指標計算
// ─────────────────────────────────────────────
function calcMA(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    const sl = arr.slice(i - n + 1, i + 1).filter(v => v != null);
    return sl.length ? sl.reduce((a, b) => a + b, 0) / sl.length : null;
  });
}

function calcRSI(closes, period = 14) {
  const rsi = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) { rsi.push(null); continue; }
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      if (d > 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
}

function calcEMA(arr, p) {
  const k = 2 / (p + 1); let prev = null;
  return arr.map(v => {
    if (v == null) return null;
    if (prev == null) { prev = v; return v; }
    prev = v * k + prev * (1 - k);
    return prev;
  });
}

function calcMACD(closes) {
  const e12 = calcEMA(closes, 12);
  const e26 = calcEMA(closes, 26);
  const dif = e12.map((v, i) => v != null && e26[i] != null ? v - e26[i] : null);
  const validDif = dif.filter(v => v != null);
  const deaRaw = calcEMA(validDif, 9);
  const offset = dif.filter(v => v == null).length;
  const dea = Array(offset).fill(null).concat(deaRaw);
  const macd = dif.map((v, i) => v != null && dea[i] != null ? (v - dea[i]) * 2 : null);
  return { dif, dea, macd };
}

// ─────────────────────────────────────────────
// 6. 圖表繪製
// ─────────────────────────────────────────────
function drawCandle(rows) {
  const dom = $('candleChart');
  if (!dom) return;
  const dates  = rows.map(r => r.date);
  const data   = rows.map(r => [r.open, r.close, r.low, r.high]);
  const closes = rows.map(r => r.close);
  const ma5  = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);

  if (charts.candle) charts.candle.dispose();
  charts.candle = echarts.init(dom, 'dark');
  charts.candle.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 65, right: 20, top: 30, bottom: 60 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    legend: { data: ['K線', 'MA5', 'MA20', 'MA60'], textStyle: { color: '#7b82a0' } },
    xAxis: { type: 'category', data: dates, boundaryGap: true, axisLabel: { color: '#7b82a0', fontSize: 10 }, splitLine: { show: false } },
    yAxis: { scale: true, splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0' } },
    dataZoom: [{ type: 'inside', start: 40, end: 100 }, { type: 'slider', bottom: 0, height: 24, fillerColor: 'rgba(79,142,247,0.1)', borderColor: '#2e3248' }],
    series: [
      { name: 'K線', type: 'candlestick', data, itemStyle: { color: '#ef4444', color0: '#22c55e', borderColor: '#ef4444', borderColor0: '#22c55e' } },
      { name: 'MA5',  type: 'line', data: ma5,  smooth: true, showSymbol: false, lineStyle: { width: 1.5, color: '#f59e0b' } },
      { name: 'MA20', type: 'line', data: ma20, smooth: true, showSymbol: false, lineStyle: { width: 1.5, color: '#4f8ef7' } },
      { name: 'MA60', type: 'line', data: ma60, smooth: true, showSymbol: false, lineStyle: { width: 1.5, color: '#7c5cd8' } },
    ]
  });
}

function drawVolume(rows) {
  const dom = $('volumeChart');
  if (!dom) return;
  if (charts.volume) charts.volume.dispose();
  charts.volume = echarts.init(dom, 'dark');
  charts.volume.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 65, right: 20, top: 10, bottom: 40 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: rows.map(r => r.date), axisLabel: { color: '#7b82a0', fontSize: 10 } },
    yAxis: { axisLabel: { formatter: v => v >= 1e8 ? (v / 1e8).toFixed(1) + '億' : (v / 1e4).toFixed(0) + '萬', color: '#7b82a0' }, splitLine: { lineStyle: { color: '#2e3248' } } },
    dataZoom: [{ type: 'inside', start: 40, end: 100 }],
    series: [{ type: 'bar', data: rows.map(r => ({ value: r.vol, itemStyle: { color: r.close >= r.open ? '#ef4444' : '#22c55e' } })), barMaxWidth: 12 }]
  });
}

// ── 總覽圖表狀態 ───────────────────────────────
let overviewSession = 'day';  // 'day' | 'history'
let overviewDays    = 1;

function bindOverviewControls() {
  // 日盤 vs 歷史 切換
  document.querySelectorAll('[data-session]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-session]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      overviewSession = btn.dataset.session;
      const dayGroup = $('overviewDayGroup');
      if (dayGroup) dayGroup.style.display = overviewSession === 'history' ? 'flex' : 'none';
      refreshOverviewChart();
    });
  });
  // 天數切換
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      overviewDays = parseInt(btn.dataset.days);
      refreshOverviewChart();
    });
  });
}

async function refreshOverviewChart() {
  const code = currentStock?.code;
  const type = currentStock?.isOTC ? 'otc' : 'tse';
  if (!code) return;

  if (overviewSession === 'day') {
    // 日盤即時模式：用 TWSE 即時資料畫今日資訊
    await drawOverviewToday(code, type);
  } else {
    // 歷史模式：用已有的歷史資料或 FinMind 日K
    await drawOverviewHistory(code, overviewDays);
  }
}

// ── 建立分時圖表底座（第一次呼叫時建立，之後只 update）──
function buildIntradayChart(prev, open, high, low, lineColor, labels, prices) {
  const dom = $('overviewChart');
  if (!dom) return;
  if (charts.overview) charts.overview.dispose();
  charts.overview = echarts.init(dom, 'dark');

  // 生成 09:00–13:30 的所有分鐘標籤（台股完整分時）
  const allLabels = [];
  for (let h = 9; h <= 13; h++) {
    const mEnd = h === 13 ? 30 : 59;
    for (let m = (h === 9 ? 0 : 0); m <= mEnd; m++) {
      allLabels.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }
  }

  charts.overview.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 65, right: 20, top: 16, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      formatter: p => {
        if (!p || !p[0]) return '';
        const v = p[0].value;
        if (v == null) return p[0].axisValue;
        const chg = v - prev;
        const pct = prev ? (chg/prev*100).toFixed(2) : 0;
        const sym = chg >= 0 ? '▲' : '▼';
        return `${p[0].axisValue}<br/>成交：<b>${v.toFixed(2)}</b>  ${sym}${Math.abs(chg).toFixed(2)} (${Math.abs(pct)}%)`;
      }
    },
    xAxis: {
      type: 'category', data: allLabels, boundaryGap: false,
      axisLabel: {
        color: '#7b82a0', fontSize: 9,
        formatter: v => {
          // 只顯示整點
          const [h,m] = v.split(':');
          return m === '00' ? v : '';
        },
        interval: 0
      },
      splitLine: { show: false }
    },
    yAxis: {
      scale: true,
      min: v => Math.min(+(v.min * 0.998).toFixed(0), prev * 0.995),
      max: v => Math.max(+(v.max * 1.002).toFixed(0), prev * 1.005),
      splitLine: { lineStyle: { color: '#2e3248' } },
      axisLabel: { color: '#7b82a0' }
    },
    series: [
      // 分時折線
      {
        name: '成交價', type: 'line',
        data: allLabels.map(() => null),   // 先全null，後面 update 填入
        smooth: false, showSymbol: false,
        lineStyle: { color: lineColor, width: 2 },
        areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1,
          colorStops:[{offset:0, color: lineColor==='#ef4444'?'rgba(239,68,68,0.2)':'rgba(34,197,94,0.2)'},{offset:1,color:'transparent'}]
        }}
      },
      // 昨收參考線（平行線）
      {
        name: '昨收', type: 'line',
        data: allLabels.map(() => prev),
        showSymbol: false,
        lineStyle: { color: '#7b82a0', type: 'dashed', width: 1, opacity: 0.6 },
        tooltip: { show: false }
      }
    ]
  });
}

// ── 把累積的 intradayPoints 填入圖表 ─────────
function fillIntradayChart(prev) {
  if (!charts.overview) return;
  const pts = intradayPoints;
  if (!pts.length) return;

  // 生成完整標籤表（便於 index 對應）
  const allLabels = [];
  for (let h = 9; h <= 13; h++) {
    const mEnd = h === 13 ? 30 : 59;
    for (let m = 0; m <= mEnd; m++) {
      allLabels.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }
  }
  const labelIdx = {};
  allLabels.forEach((l, i) => labelIdx[l] = i);

  // 用 timeStr 索引（API 台灣時間字串，無時區問題）
  const data = Array(allLabels.length).fill(null);
  pts.forEach(p => {
    const idx = labelIdx[p.timeStr];
    if (idx !== undefined) data[idx] = p.price;
  });

  const lastPt  = pts[pts.length - 1];
  const firstPt = pts[0];

  // 向前填補：09:00 到第一筆成交前，用昨收填充，作為視覺基準線
  // 讓使用者不論何時進入頁面都有參考基準，不是一片空白
  if (firstPt?.timeStr) {
    const firstIdx = labelIdx[firstPt.timeStr] ?? 0;
    for (let i = 0; i < firstIdx; i++) {
      data[i] = prev;
    }
  }

  // 向後填補：從最後一筆成交到當前分鐘，填入最後成交價
  // 讓線段延伸到「現在」而不停在最後一筆成交的分鐘
  if (lastPt?.timeStr) {
    const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const nowLbl = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const fromIdx = (labelIdx[lastPt.timeStr] ?? -1) + 1;
    const toIdx   = labelIdx[nowLbl] ?? fromIdx;
    for (let i = fromIdx; i <= toIdx; i++) {
      if (data[i] === null) data[i] = lastPt.price;
    }
  }

  const lastPrice = lastPt.price;
  const lineColor = lastPrice >= prev ? '#ef4444' : '#22c55e';

  charts.overview.setOption({
    series: [
      { data, connectNulls: false,   // 不連接空值；配合補點讓線連續
        lineStyle: { color: lineColor },
        areaStyle: { color: { type:'linear',x:0,y:0,x2:0,y2:1,
          colorStops:[{offset:0,color:lineColor==='#ef4444'?'rgba(239,68,68,0.2)':'rgba(34,197,94,0.2)'},{offset:1,color:'transparent'}] }} },
      { data: allLabels.map(() => prev) }
    ]
  }, false);
}

// 今日即時走勢（日盤）
async function drawOverviewToday(code, type) {
  const titleEl = $('overviewChartTitle');
  if (titleEl) titleEl.textContent = '☀️ 今日盤中走勢（即時 / 每5秒更新）';

  // 先取最新即時快照
  let rt = null;
  try {
    const res = await fetch(`${PROXY_BASE}/api/realtime?symbol=${code}&type=${type}`, { cache: 'no-store' });
    const j   = await res.json();
    rt = j?.msgArray?.[0] || null;
  } catch { }

  const dom = $('overviewChart');
  if (!dom) return;

  const session = getSession();
  const prev    = rt ? toFloat(rt.y) : intradayPrev;
  const cur     = rt ? toFloat(livePrice(rt) || rt.y) : prev;
  const lineColor = cur >= prev ? '#ef4444' : '#22c55e';

  if (session === 'closed') {
    // 休市：顯示最近5日收盤折線
    if (charts.overview) charts.overview.dispose();
    charts.overview = echarts.init(dom, 'dark');
    const rows   = currentStock.history || [];
    const last5  = rows.slice(-5);
    charts.overview.setOption({
      backgroundColor: 'transparent', animation: false,
      title: { text: '今日休市（顯示近5日）', subtext: '', left: 'center', top: 'middle',
        textStyle: { color: '#7b82a0', fontSize: 14 } },
      grid: { left: 65, right: 20, top: 30, bottom: 40 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: last5.map(r => r.date), axisLabel: { color: '#7b82a0', fontSize: 10 } },
      yAxis: { scale: true, splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0' } },
      series: [{ type: 'line', data: last5.map(r => r.close), smooth: false, showSymbol: true,
        lineStyle: { color: '#4f8ef7', width: 2 },
        areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1, colorStops:[{offset:0,color:'rgba(79,142,247,0.25)'},{offset:1,color:'transparent'}] } }
      }]
    });
    return;
  }

  // 建立完整分時圖表底座
  buildIntradayChart(prev, toFloat(rt?.o||prev), toFloat(rt?.h||prev), toFloat(rt?.l||prev), lineColor, [], []);
  // 填入已有的分時資料
  if (intradayPoints.length) fillIntradayChart(prev);
}

// 歷史多日走勢
async function drawOverviewHistory(code, days) {
  const titleMap = { 1:'今日分時', 5:'近5日', 20:'近1個月', 60:'近3個月', 120:'近半年', 240:'近1年' };
  const titleEl = $('overviewChartTitle');
  if (titleEl) titleEl.textContent = `📅 ${titleMap[days] || `近${days}日`}走勢`;

  // 今日（days=1）直接顯示分時走勢
  if (days === 1) {
    if (titleEl) titleEl.textContent = '📅 今日分時走勢';
    if (intradayPoints.length) {
      const prev = intradayPrev || (currentStock.history?.slice(-1)[0]?.close || 0);
      buildIntradayChart(prev, prev, prev, prev,
        intradayPoints.slice(-1)[0].price >= prev ? '#ef4444' : '#22c55e', [], []);
      fillIntradayChart(prev);
    } else {
      // 無分時資料時觸發日盤模式拿快照
      await drawOverviewToday(code, currentStock.isOTC ? 'otc' : 'tse');
    }
    return;
  }

  let rows = currentStock.history || [];

  // 若需要更多歷史（超過已有資料），向 FinMind 多抓幾個月
  // 多拉 20% 緩衝避免節假日導致交易日數不足
  const neededMonths = days <= 20 ? 1 : days <= 60 ? 3 : days <= 120 ? 7 : 14;
  if (days > rows.length) {
    try {
      const res  = await fetch(`${PROXY_BASE}/api/historyrange?symbol=${code}&months=${neededMonths}`);
      const json = await res.json();
      const data = json?.data || [];
      if (data.length) {
        // FinMind 格式：date, open, max, min, close, Trading_Volume
        rows = data.map(d => ({
          date:  d.date,
          open:  d.open,
          high:  d.max,
          low:   d.min,
          close: d.close,
          vol:   d.Trading_Volume
        }));
        currentStock.historyLong = rows;
      }
    } catch { }
  }

  // 以交易日數切片（FinMind 回傳皆為真實交易日，無假日）
  const sliced = rows.slice(-days);
  if (!sliced.length) return;

  const dom = $('overviewChart');
  if (!dom) return;
  if (charts.overview) charts.overview.dispose();
  charts.overview = echarts.init(dom, 'dark');

  const first = sliced[0].close;
  const last  = sliced[sliced.length - 1].close;
  const isUp  = last >= first;
  const lineColor = isUp ? '#ef4444' : '#22c55e';

  charts.overview.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 65, right: 20, top: 10, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      formatter: params => {
        const p = params[0];
        return `${p.axisValue}<br/>收盤：<b>${p.value}</b>`;
      }
    },
    xAxis: {
      type: 'category', data: sliced.map(r => r.date), boundaryGap: false,
      axisLabel: {
        color: '#7b82a0', fontSize: 10,
        // 資料點多時自動稀疏顯示，只標月初
        formatter: (v, i) => {
          if (sliced.length <= 30) return v;
          // 只顯示每月第一個交易日的標籤
          const prev = i > 0 ? sliced[i-1]?.date?.substring(0,7) : '';
          return v.substring(0,7) !== prev ? v.substring(5) : '';
        },
        interval: 0
      }
    },
    yAxis: { scale: true, splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0' } },
    series: [{
      type: 'line', data: sliced.map(r => r.close), smooth: true, showSymbol: false,
      lineStyle: { color: lineColor, width: 2 },
      areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1,
        colorStops:[{offset:0,color:lineColor==='#ef4444'?'rgba(239,68,68,0.25)':'rgba(34,197,94,0.25)'},{offset:1,color:'transparent'}]
      }}
    }]
  });
}

// 入口（給 loadHistoryMultiMonth 呼叫）
function drawOverviewLine(rows) {
  bindOverviewControls();
  overviewSession = 'day';
  overviewDays    = 1;
  // 重置按鈕狀態
  document.querySelectorAll('[data-session]').forEach((b,i) => b.classList.toggle('active', i===0));
  document.querySelectorAll('[data-days]').forEach((b,i) => b.classList.toggle('active', i===0));
  const dg = $('overviewDayGroup');
  if (dg) dg.style.display = 'none';
  refreshOverviewChart();
}

function drawRSI(rows) {
  const dom = $('rsiChart');
  if (!dom) return;
  const closes = rows.map(r => r.close);
  const rsi    = calcRSI(closes);
  const dates  = rows.map(r => r.date);
  if (charts.rsi) charts.rsi.dispose();
  charts.rsi = echarts.init(dom, 'dark');
  charts.rsi.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 50, right: 10, top: 10, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: dates, axisLabel: { color: '#7b82a0', fontSize: 9 } },
    yAxis: { min: 0, max: 100, splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0', fontSize: 10 } },
    dataZoom: [{ type: 'inside', start: 40, end: 100 }],
    visualMap: { show: false, pieces: [{ min: 70, color: '#ef4444' }, { min: 30, max: 70, color: '#4f8ef7' }, { max: 30, color: '#22c55e' }] },
    series: [{
      type: 'line', data: rsi, showSymbol: false, smooth: true,
      markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(255,255,255,0.2)', type: 'dashed' }, data: [{ yAxis: 70 }, { yAxis: 30 }] }
    }]
  });
}

function drawMACD(rows) {
  const dom = $('macdChart');
  if (!dom) return;
  const closes    = rows.map(r => r.close);
  const dates     = rows.map(r => r.date);
  const { dif, dea, macd } = calcMACD(closes);
  if (charts.macd) charts.macd.dispose();
  charts.macd = echarts.init(dom, 'dark');
  charts.macd.setOption({
    backgroundColor: 'transparent', animation: false,
    grid: { left: 50, right: 10, top: 10, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['DIF', 'DEA', 'MACD'], textStyle: { color: '#7b82a0', fontSize: 10 } },
    xAxis: { type: 'category', data: dates, axisLabel: { color: '#7b82a0', fontSize: 9 } },
    yAxis: { splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0', fontSize: 10 } },
    dataZoom: [{ type: 'inside', start: 40, end: 100 }],
    series: [
      { name: 'MACD', type: 'bar', data: macd.map(v => ({ value: v, itemStyle: { color: v >= 0 ? '#ef4444' : '#22c55e' } })), barMaxWidth: 8 },
      { name: 'DIF', type: 'line', data: dif, showSymbol: false, lineStyle: { color: '#4f8ef7', width: 1.5 } },
      { name: 'DEA', type: 'line', data: dea, showSymbol: false, lineStyle: { color: '#f59e0b', width: 1.5 } },
    ]
  });
}

async function drawCandleForPeriod(period) {
  if (!currentStock) return;
  const cutMap  = { '3m': 66, '6m': 130, '1y': 260 };
  const n       = cutMap[period] || 66;
  const code    = currentStock.code;
  const mkt     = currentStock.isOTC ? 'otc' : 'tse';

  // 若現有歷史資料不足，先去拉更長的資料
  let rows = currentStock.historyLong || currentStock.history || [];
  if (rows.length < n) {
    try {
      const months = period === '1y' ? 13 : period === '6m' ? 7 : 4;
      const res  = await fetch(`${PROXY_BASE}/api/historyrange?symbol=${code}&type=${mkt}&months=${months}`);
      const json = await res.json();
      const data = json?.data || [];
      if (data.length) {
        rows = data.map(d => ({
          date:  d.date,
          open:  d.open,
          high:  d.max,
          low:   d.min,
          close: d.close,
          vol:   d.Trading_Volume
        }));
        currentStock.historyLong = rows;
      }
    } catch { /* 使用現有資料 */ }
  }

  const sliced = rows.slice(-n);
  if (!sliced.length) return;
  drawCandle(sliced);
  drawVolume(sliced);
  drawRSI(sliced);
  drawMACD(sliced);
}

// ─────────────────────────────────────────────
// 7. 技術指標摘要
// ─────────────────────────────────────────────
function renderTechSummary(rows) {
  const closes = rows.map(r => r.close);
  const n = closes.length;
  if (!n) return;
  const cur  = closes[n - 1];
  const ma5  = calcMA(closes, 5)[n - 1];
  const ma20 = calcMA(closes, 20)[n - 1];
  const ma60 = calcMA(closes, 60)[n - 1];
  const rsi  = calcRSI(closes)[n - 1];
  const { dif, dea } = calcMACD(closes);

  const indicators = [
    { name: 'RSI(14)', value: rsi?.toFixed(1), signal: rsi > 70 ? 'sell' : rsi < 30 ? 'buy' : 'neutral', label: rsi > 70 ? '超買賣出' : rsi < 30 ? '超賣買進' : '中性' },
    { name: 'MA5',  value: ma5?.toFixed(2),  signal: cur > ma5  ? 'buy' : 'sell', label: cur > ma5  ? '均線上方' : '均線下方' },
    { name: 'MA20', value: ma20?.toFixed(2), signal: cur > ma20 ? 'buy' : 'sell', label: cur > ma20 ? '多頭趨勢' : '空頭趨勢' },
    { name: 'MA60', value: ma60?.toFixed(2), signal: cur > ma60 ? 'buy' : 'sell', label: cur > ma60 ? '長線偏多' : '長線偏空' },
    { name: 'MACD', value: dif[n - 1]?.toFixed(3), signal: dif[n - 1] > dea[n - 1] ? 'buy' : 'sell', label: dif[n - 1] > dea[n - 1] ? '金叉(多)' : '死叉(空)' },
  ];

  const el = $('techSummary');
  if (!el) return;
  el.innerHTML = indicators.map(ind =>
    `<div class="indicator-item">
       <div><div class="ind-name">${ind.name}</div><div class="ind-value">${ind.value ?? '--'}</div></div>
       <span class="ind-signal signal-${ind.signal}">${ind.label}</span>
     </div>`
  ).join('');
}

// ─────────────────────────────────────────────
// 8. 新聞情緒 & 指標人物
// ─────────────────────────────────────────────
const POS_WORDS = ['上漲','漲停','創新高','利多','獲利','突破','買進','看漲','大漲','飆漲','亮眼','強勁','成長','樂觀','看好'];
const NEG_WORDS = ['下跌','跌停','低點','利空','虧損','衰退','賣出','看跌','大跌','崩跌','看壞','悲觀','風險','裁員','警告'];

// ── 指標人物資料庫 ──────────────────────────────
// accuracy: 歷史預測準確率（依公開媒體報導整理，僅供參考）
// domains: 擅長領域關鍵字（用於判斷是否與該股票相關）
// aliases: 新聞中可能出現的別名/簡稱
const KOL_DB = [
  // ── 台灣總體/宏觀 ──
  { name: '謝金河',  aliases: ['謝金河'],           emoji: '💼', domain: '台股總體',   accuracy: 72,
    bio: '財信傳媒董事長，《今周刊》創辦人，長期觀察台股宏觀走向' },
  { name: '吳東諺',  aliases: ['吳東諺'],           emoji: '📊', domain: '台股分析',   accuracy: 68,
    bio: '知名台股分析師，擅長總體經濟與大盤走勢研判' },
  { name: '阮慕驊',  aliases: ['阮慕驊'],           emoji: '📻', domain: '台股/ETF',  accuracy: 66,
    bio: '台灣知名財經主播，長期追蹤台股與ETF市場' },
  { name: '陳鳳馨',  aliases: ['陳鳳馨'],           emoji: '📡', domain: '總體經濟',   accuracy: 65,
    bio: '資深財經主播，擅長台股與國際市場分析' },
  { name: '盧燕俐',  aliases: ['盧燕俐'],           emoji: '💹', domain: '台股',       accuracy: 63,
    bio: '知名財經主持人，長期關注台股及基金投資' },

  // ── 科技/半導體 ──
  { name: '張忠謀',  aliases: ['張忠謀','Morris Chang'], emoji: '🔬', domain: '半導體',  accuracy: 85,
    bio: 'TSMC創辦人，半導體產業最具影響力人物，言論直接影響台積電股價' },
  { name: '劉德音',  aliases: ['劉德音'],           emoji: '💻', domain: '半導體',      accuracy: 80,
    bio: '台積電前董事長，對半導體產業展望具高度公信力' },
  { name: '魏哲家',  aliases: ['魏哲家','C.C. Wei'],  emoji: '⚙️', domain: '半導體',   accuracy: 82,
    bio: '台積電執行長，法說會言論高度影響半導體族群走向' },
  { name: '蔡力行',  aliases: ['蔡力行'],           emoji: '🖥️', domain: '科技',       accuracy: 70,
    bio: '台積電前總裁，科技業資深領導人' },
  { name: '蘇姿丰',  aliases: ['蘇姿丰','Lisa Su'],  emoji: '🔴', domain: 'AMD/半導體', accuracy: 78,
    bio: 'AMD執行長，AI晶片競爭態勢重要指標人物' },
  { name: '黃仁勳',  aliases: ['黃仁勳','Jensen Huang','Jensen'], emoji: '🟢', domain: 'AI/GPU', accuracy: 88,
    bio: 'NVIDIA執行長，AI晶片與GPU市場最具影響力人物，言論牽動全球科技股' },
  { name: '郭台銘',  aliases: ['郭台銘','Terry Guo'],  emoji: '🏭', domain: '電子製造', accuracy: 67,
    bio: '鴻海創辦人，對電子製造與供應鏈走向影響深遠' },
  { name: '楊應超',  aliases: ['楊應超'],           emoji: '📈', domain: '科技/半導體', accuracy: 74,
    bio: '前瑞信科技分析師，台積電研究權威，預測準確率高' },

  // ── 金融/銀行 ──
  { name: '施俊吉',  aliases: ['施俊吉'],           emoji: '🏦', domain: '金融政策',   accuracy: 69,
    bio: '前行政院副院長，熟悉金融政策走向' },
  { name: '楊金龍',  aliases: ['楊金龍'],           emoji: '🏛️', domain: '貨幣政策',   accuracy: 75,
    bio: '中央銀行總裁，升降息政策直接影響銀行、房產、債券市場' },
  { name: '彭淮南',  aliases: ['彭淮南'],           emoji: '💰', domain: '貨幣政策',   accuracy: 78,
    bio: '前央行總裁，台灣貨幣政策奠基人，發言具高度市場影響力' },

  // ── 航運/傳產 ──
  { name: '陽明海運',aliases: ['陽明','YM'],        emoji: '🚢', domain: '航運',       accuracy: 62,
    bio: '陽明海運官方，航運景氣重要指標' },
  { name: '鄭貞茂',  aliases: ['鄭貞茂'],           emoji: '📉', domain: '總體經濟',   accuracy: 66,
    bio: '前國發會副主委，熟悉台灣整體經濟數據' },

  // ── 國際 ──
  { name: '巴菲特',  aliases: ['巴菲特','Warren Buffett','Buffett'], emoji: '🧙', domain: '價值投資', accuracy: 86,
    bio: '股神，旗下波克夏持倉動向全球矚目，長線價值投資最高指標' },
  { name: '彼得林區', aliases: ['彼得林區','Peter Lynch'],           emoji: '📚', domain: '成長股',   accuracy: 83,
    bio: '傳奇基金經理人，成長股投資教父' },
  { name: '索羅斯',  aliases: ['索羅斯','Soros','George Soros'],     emoji: '🌐', domain: '宏觀對沖', accuracy: 75,
    bio: '量子基金創辦人，擅長全球宏觀交易' },
  { name: '葛羅斯',  aliases: ['葛羅斯','Bill Gross'],                emoji: '📜', domain: '債券',     accuracy: 71,
    bio: '前PIMCO債券之王，債市與利率預測具重大影響力' },
  { name: '聯準會',  aliases: ['聯準會','Fed','鮑爾','Powell','FOMC'],emoji: '🏦', domain: '貨幣政策', accuracy: 79,
    bio: '美國聯邦準備理事會，升降息決策牽動全球股匯市' },
  { name: '馬斯克',  aliases: ['馬斯克','Elon Musk','Musk'],          emoji: '🚀', domain: '科技/EV',  accuracy: 58,
    bio: 'Tesla/SpaceX/xAI執行長，言論常引發相關族群劇烈波動' },
  { name: '比爾蓋茲', aliases: ['比爾蓋茲','Bill Gates'],              emoji: '💻', domain: '科技/醫療', accuracy: 70,
    bio: '微軟創辦人，科技與醫療健康領域長線投資具參考價值' },
];

// 根據標題比對指標人物，回傳匹配到的 { kol, highlighted } 陣列
function matchKOL(title) {
  for (const kol of KOL_DB) {
    for (const alias of kol.aliases) {
      if (title.includes(alias)) return kol;
    }
  }
  return null;
}

function accuracyClass(acc) {
  return acc >= 75 ? 'acc-high' : acc >= 60 ? 'acc-mid' : 'acc-low';
}

function analyzeSentiment(text) {
  const p = POS_WORDS.filter(w => text.includes(w)).length;
  const n = NEG_WORDS.filter(w => text.includes(w)).length;
  return p > n ? 'positive' : n > p ? 'negative' : 'neutral';
}

async function loadNews(code, name) {
  let items = [];
  try {
    const res = await fetch(`${PROXY_BASE}/api/news?q=${encodeURIComponent(code + ' ' + name + ' 股票')}`);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    items = Array.from(doc.querySelectorAll('item')).map(el => ({
      title:   el.querySelector('title')?.textContent || '',
      link:    el.querySelector('link')?.textContent || '#',
      pubDate: el.querySelector('pubDate')?.textContent || '',
      source:  el.querySelector('source')?.textContent || 'Google新聞',
    }));
  } catch { }

  // 拆分：指標人物新聞 vs 一般新聞
  const kolItems = [], generalItems = [];
  for (const item of items) {
    const kol = matchKOL(item.title);
    if (kol) kolItems.push({ ...item, kol });
    else     generalItems.push(item);
  }

  renderKOLNews(kolItems);
  renderNews(generalItems.slice(0, 12));
  renderSentimentGauge(items);   // 情緒仍計算全部新聞
}

// 渲染指標人物新聞區塊
function renderKOLNews(items) {
  const section = $('kolSection');
  const list    = $('kolList');
  if (!section || !list) return;

  if (!items.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  list.innerHTML = items.map(item => {
    const kol = item.kol;
    const s   = analyzeSentiment(item.title);
    const bc  = { positive: 'badge-pos', negative: 'badge-neg', neutral: 'badge-neu' }[s];
    const bt  = { positive: '📈 利多', negative: '📉 利空', neutral: '➡️ 中性' }[s];
    const dt  = item.pubDate ? new Date(item.pubDate).toLocaleDateString('zh-TW') : '';
    const acc = kol.accuracy;
    const accCls = accuracyClass(acc);

    // 在標題中把人名高亮
    let highlighted = item.title;
    for (const alias of kol.aliases) {
      if (highlighted.includes(alias)) {
        highlighted = highlighted.replace(alias,
          `<span style="color:var(--accent);font-weight:700">${alias}</span>`);
        break;
      }
    }

    return `<div class="kol-item" onclick="window.open('${item.link}','_blank')">
      <div class="kol-avatar">${kol.emoji}</div>
      <div class="kol-body">
        <div class="kol-name-row">
          <span class="kol-name">${kol.name}</span>
          <span class="kol-accuracy ${accCls}">🎯 準確率 ${acc}%</span>
          <span class="kol-domain">${kol.domain}</span>
        </div>
        <div class="kol-title">${highlighted}</div>
        <div class="kol-meta">
          <span>${item.source}</span>
          <span>${dt}</span>
          <span class="kol-sentiment-badge ${bc}">${bt}</span>
          <span style="color:var(--muted);font-size:10px">${kol.bio}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderNews(items) {
  const el = $('newsList');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<p style="color:var(--muted);padding:20px">暫無相關新聞</p>'; return; }
  el.innerHTML = items.map(item => {
    const s = analyzeSentiment(item.title);
    const bc = { positive: 'badge-pos', negative: 'badge-neg', neutral: 'badge-neu' }[s];
    const bt = { positive: '利多', negative: '利空', neutral: '中性' }[s];
    const dt = item.pubDate ? new Date(item.pubDate).toLocaleDateString('zh-TW') : '';
    return `<div class="news-item" onclick="window.open('${item.link}','_blank')">
      <div class="news-item-title">${item.title}</div>
      <div class="news-item-meta"><span>${item.source}</span><span>${dt}</span>
      <span class="news-sentiment-badge ${bc}">${bt}</span></div></div>`;
  }).join('');
}

function renderSentimentGauge(items) {
  const ss = items.map(i => analyzeSentiment(i.title));
  const pos = ss.filter(s => s === 'positive').length;
  const neg = ss.filter(s => s === 'negative').length;
  const neu = ss.filter(s => s === 'neutral').length;
  const total = ss.length || 1;
  const score = Math.round(((pos - neg) / total) * 50 + 50);

  const dom = $('sentimentGauge');
  if (dom) {
    if (charts.gauge) charts.gauge.dispose();
    charts.gauge = echarts.init(dom, 'dark');
    charts.gauge.setOption({
      backgroundColor: 'transparent',
      series: [{
        type: 'gauge', min: 0, max: 100, startAngle: 200, endAngle: -20,
        axisLine: { lineStyle: { width: 18, color: [[0.3, '#ef4444'], [0.7, '#f59e0b'], [1, '#22c55e']] } },
        pointer: { itemStyle: { color: 'auto' }, length: '60%', width: 6 },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        detail: { formatter: v => v + '', fontSize: 24, fontWeight: 700, color: 'auto', offsetCenter: [0, '40%'] },
        data: [{ value: score }]
      }]
    });
  }

  currentStock.sentimentScore = score;
  const label = score >= 65 ? '🟢 樂觀' : score >= 40 ? '🟡 中性' : '🔴 悲觀';
  setVal('sentimentLabel', label);

  const bd = $('sentimentBreakdown');
  if (bd) {
    const mx = Math.max(pos, neg, neu, 1);
    bd.innerHTML = `
      <h3 style="margin-bottom:14px;font-size:15px">情緒分布（共 ${total} 條新聞）</h3>
      <div class="sent-item"><span class="sent-label">🟢 利多</span>
        <div class="sent-bar-wrap"><div class="sent-bar" style="width:${pos/mx*100}%;background:var(--green)"></div></div>
        <span class="sent-count">${pos}</span></div>
      <div class="sent-item"><span class="sent-label">🔴 利空</span>
        <div class="sent-bar-wrap"><div class="sent-bar" style="width:${neg/mx*100}%;background:var(--red)"></div></div>
        <span class="sent-count">${neg}</span></div>
      <div class="sent-item"><span class="sent-label">⚪ 中性</span>
        <div class="sent-bar-wrap"><div class="sent-bar" style="width:${neu/mx*100}%;background:var(--muted)"></div></div>
        <span class="sent-count">${neu}</span></div>`;
  }
}

// ─────────────────────────────────────────────
// 9. 漲跌機率預測（支援 1–7 日）
// ─────────────────────────────────────────────
let predDays = 5;  // 個股預測頁目前選定的天數

/**
 * 共用計分核心：首頁排行榜與個股預測頁使用同一套邏輯，確保結果一致。
 * @param {number[]} closes  收盤價陣列（由舊到新）
 * @param {number}   days    預測天數 1–7
 * @param {number}   pe      本益比（0 = 無資料）
 * @param {number}   dy      殖利率（0 = 無資料）
 * @param {number}   pb      股價淨值比（0 = 無資料）
 * @param {number}   sent    情緒分 0–100（50 = 中性）
 * @returns {{ upProb: number, factors: Array }}
 */
function calcPrediction(closes, days, pe = 0, dy = 0, pb = 0, sent = 50) {
  const n   = closes.length;
  const cur = closes[n - 1];
  const factors = [];

  // RSI：短天數加權
  const rsi     = calcRSI(closes)[n - 1];
  const rsiW    = days <= 2 ? 1.5 : days <= 4 ? 1.2 : 1;
  const rsiBase = rsi < 30 ? 20 : rsi > 70 ? -20 : rsi < 50 ? 5 : -5;
  const rsiScore = Math.round(rsiBase * rsiW);
  factors.push({ icon: '📊', name: 'RSI 技術指標',
    detail: `RSI(14) = ${rsi?.toFixed(1)}，${rsi < 30 ? '超賣反彈機率高' : rsi > 70 ? '超買回調風險' : '中性區間'}`,
    score: rsiScore });

  // 均線（MA5 / MA20 / MA60）
  const ma5  = calcMA(closes, 5)[n - 1];
  const ma20 = calcMA(closes, 20)[n - 1];
  const ma60 = calcMA(closes, 60)[n - 1];
  let maScore = 0;
  if (cur > ma5)  maScore += 5;
  if (cur > ma20) maScore += 8;
  if (cur > ma60) maScore += 7;
  if (ma5 > ma20) maScore += 5;
  factors.push({ icon: '📈', name: '均線排列',
    detail: `現價${cur > ma20 ? '高於' : '低於'}MA20(${ma20?.toFixed(1)})，${cur > ma60 ? '高於' : '低於'}MA60(${ma60?.toFixed(1)})`,
    score: maScore - 12 });

  // MACD
  const { dif, dea } = calcMACD(closes);
  const macdScore = dif[n - 1] > dea[n - 1] ? 10 : -10;
  factors.push({ icon: '⚡', name: 'MACD 金叉/死叉',
    detail: `DIF=${dif[n-1]?.toFixed(3)}，DEA=${dea[n-1]?.toFixed(3)}，${dif[n-1] > dea[n-1] ? '金叉多頭' : '死叉空頭'}`,
    score: macdScore });

  // 近N日動能（窗口依天數）
  const win    = Math.min(days, closes.length - 1);
  const slopeN = closes.length > win ? (closes[n-1] - closes[n-1-win]) / closes[n-1-win] * 100 : 0;
  const trendScore = slopeN > 3 ? 12 : slopeN > 0 ? 5 : slopeN > -3 ? -5 : -12;
  factors.push({ icon: '📅', name: `近${win}日動能`,
    detail: `近${win}日漲跌：${slopeN.toFixed(2)}%，${slopeN > 0 ? '正動能' : '負動能'}`,
    score: trendScore });

  // 本益比
  let peScore = 0;
  if (pe > 0) peScore = pe < 10 ? 15 : pe < 15 ? 8 : pe < 25 ? 0 : pe < 40 ? -5 : -12;
  factors.push({ icon: '💰', name: '本益比評估',
    detail: `P/E = ${pe ? pe.toFixed(1) : '--'}，${pe < 15 && pe > 0 ? '低估值偏利多' : pe > 35 ? '高估值有風險' : '合理範圍'}`,
    score: peScore });

  // 殖利率
  const dyScore = dy >= 5 ? 10 : dy >= 3 ? 6 : dy > 0 ? 2 : -2;
  factors.push({ icon: '🏦', name: '股息殖利率',
    detail: `殖利率 ${dy.toFixed(2)}%，${dy >= 5 ? '高殖利率支撐' : dy >= 3 ? '殖利率尚可' : '殖利率偏低'}`,
    score: dyScore });

  // 新聞情緒
  const sentScore = sent >= 65 ? 10 : sent <= 35 ? -10 : 0;
  const sentLabel = sent >= 65 ? '樂觀' : sent <= 35 ? '悲觀' : '中性';
  factors.push({ icon: '📰', name: '新聞情緒',
    detail: `市場情緒：${sentLabel}`,
    score: sentScore });

  // 股價淨值比
  const pbScore = pb > 0 && pb < 1 ? 12 : pb < 2 ? 5 : pb < 4 ? 0 : -8;
  factors.push({ icon: '📋', name: '股價淨值比',
    detail: `P/B = ${pb ? pb.toFixed(2) : '--'}，${pb < 1 && pb > 0 ? '低於淨值，具安全邊際' : pb < 2 ? '合理估值' : '偏高估值'}`,
    score: pbScore });

  const total  = factors.reduce((a, f) => a + f.score, 0);
  const max    = factors.length * 20;
  const upProb = Math.max(20, Math.min(80, Math.round((total + max) / (2 * max) * 100)));
  return { upProb, factors };
}

function renderPrediction(days) {
  if (days !== undefined) predDays = days;
  const d = predDays;

  const rows = currentStock.history;
  if (!rows || rows.length < 10) return;
  const closes = rows.map(r => r.close);

  // ── 同步選擇器 active 狀態 ──────────────────
  document.querySelectorAll('.pred-day-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.days) === d);
  });

  // ── 更新標題 ────────────────────────────────
  const titleEl = $('predictionTitle');
  if (titleEl) titleEl.textContent = `未來${d}個工作日漲跌預測`;
  const chartTitleEl = $('predictionChartTitle');
  if (chartTitleEl) chartTitleEl.textContent = `預測走勢示意圖（${d}個工作日）`;

  // 取得基本面參數（個股專用，首頁無此資料預設 0/50）
  const pe   = toFloat(currentStock.perHistory?.[currentStock.perHistory.length - 1]?.PER);
  const dy   = toFloat(currentStock.perHistory?.[currentStock.perHistory.length - 1]?.dividend_yield);
  const pb   = toFloat(currentStock.perHistory?.[currentStock.perHistory.length - 1]?.PBR);
  const sent = currentStock.sentimentScore ?? 50;

  const { upProb, factors } = calcPrediction(closes, d, pe, dy, pb, sent);
  const downProb = 100 - upProb;

  setVal('upProb',   upProb + '%');
  setVal('downProb', downProb + '%');

  const verdict = upProb >= 65
    ? `✅ 綜合多項指標顯示，未來${d}個工作日<strong>上漲機率較高</strong>（${upProb}%）。技術面呈多頭排列，建議留意進場機會。`
    : upProb <= 35
    ? `⚠️ 綜合分析顯示，未來${d}個工作日<strong>下跌機率較高</strong>（${downProb}%）。技術指標偏空，建議謹慎觀望。`
    : `📊 多空力道相當，短期走勢不確定性較高（上漲 ${upProb}% vs 下跌 ${downProb}%）。建議持續觀察量價變化。`;

  const vEl = $('verdictText');
  if (vEl) vEl.innerHTML = verdict;
  const vc = $('verdictCard');
  if (vc) vc.style.borderColor = upProb >= 65 ? 'var(--green)' : upProb <= 35 ? 'var(--red)' : 'var(--yellow)';

  const fEl = $('factorList');
  if (fEl) fEl.innerHTML = factors.map(f => {
    const cls = f.score >= 5 ? 'signal-buy' : f.score <= -5 ? 'signal-sell' : 'signal-neutral';
    return `<div class="factor-item">
      <div class="factor-icon">${f.icon}</div>
      <div class="factor-body">
        <div class="factor-name">${f.name}</div>
        <div class="factor-detail">${f.detail}</div>
        <span class="factor-score ind-signal ${cls}">${f.score >= 0 ? '+' : ''}${f.score} 分</span>
      </div></div>`;
  }).join('');

  // ── 今日操作建議（依下個開盤日預測）──────────────
  renderAdvice(upProb, downProb, d);

  drawPredictionChart(closes, upProb, d);
}

// 根據上漲機率與天數給出今日操作建議
function renderAdvice(upProb, downProb, days) {
  const card    = $('adviceCard');
  const iconEl  = $('adviceIcon');
  const textEl  = $('adviceText');
  const subEl   = $('adviceSub');
  if (!card) return;

  // 1日預測代表「明日開盤方向」，最具直接參考性
  // 天數越長越保守：門檻稍微降低一點
  const buyThreshold  = days <= 2 ? 62 : days <= 4 ? 60 : 58;
  const sellThreshold = days <= 2 ? 38 : days <= 4 ? 40 : 42;

  let icon, text, sub, cls;
  if (upProb >= buyThreshold) {
    icon = '🟢';
    text = '建議買入 / 持有';
    sub  = `${days}個工作日內上漲機率 ${upProb}%，技術指標偏多，可考慮於今日收盤前或下個開盤初建立部位。`;
    cls  = 'advice-buy';
  } else if (downProb >= (100 - sellThreshold)) {
    icon = '🔴';
    text = '建議賣出 / 減碼';
    sub  = `${days}個工作日內下跌機率 ${downProb}%，技術指標偏空，可考慮於今日收盤前或下個開盤初減少持倉。`;
    cls  = 'advice-sell';
  } else {
    icon = '🟡';
    text = '建議觀望 / 不動';
    sub  = `多空訊號不明確（上漲 ${upProb}% vs 下跌 ${downProb}%），建議維持現有部位，等待更清晰的方向訊號。`;
    cls  = 'advice-hold';
  }

  iconEl.textContent = icon;
  textEl.textContent = text;
  subEl.textContent  = sub;
  card.className = `advice-card ${cls}`;
}

function drawPredictionChart(closes, upProb, days) {
  days = days || 5;
  const dom = $('predictionChart');
  if (!dom) return;
  if (charts.prediction) charts.prediction.dispose();
  charts.prediction = echarts.init(dom, 'dark');

  // 取最近 20 筆實際交易日資料（含日期標籤）
  const histRows   = (currentStock.history || []).slice(-20);
  const last20     = histRows.map(r => r.close);
  const histLabels = histRows.map(r => r.date);  // 真實交易日，無假日
  const lastP      = last20[last20.length - 1];
  const bias       = (upProb - 50) / 100;
  const downProb   = 100 - upProb;

  // 三條情境：各自帶不同偏差與機率說明
  const scenarios = [
    { name: `樂觀情境（上漲 ${upProb}%）`,     color: '#ef4444', width: 2,   extra: +0.008 },
    { name: `基準情境（上漲 ${upProb}%）`,      color: '#f59e0b', width: 1.5, extra: 0      },
    { name: `悲觀情境（下跌 ${downProb}%）`,    color: '#22c55e', width: 1,   extra: -0.008 },
  ];

  // 未來交易日標籤：跳過週六(6)、週日(0)
  const futLabels = [];
  const cursor    = new Date();
  while (futLabels.length < days) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      futLabels.push(`${cursor.getMonth()+1}/${cursor.getDate()}`);
    }
  }

  const genPath = (extra) => {
    let p = lastP;
    return Array(days).fill(0).map(() => {
      p = p * (1 + (Math.random() * 0.03 - 0.015 + bias * 0.01 + extra));
      return +p.toFixed(2);
    });
  };

  charts.prediction.setOption({
    backgroundColor: 'transparent', animation: true,
    legend: {
      data: ['歷史收盤', ...scenarios.map(s => s.name)],
      textStyle: { color: '#7b82a0', fontSize: 11 },
      top: 4, left: 'center',
      itemWidth: 14, itemHeight: 10
    },
    tooltip: {
      trigger: 'axis',
      formatter: params => {
        const pts = params.filter(p => p.value != null);
        if (!pts.length) return params[0]?.axisValue || '';
        return pts[0].axisValue + '<br/>' +
          pts.map(p => `${p.marker}${p.seriesName}：<b>${p.value}</b>`).join('<br/>');
      }
    },
    grid: { left: 60, right: 20, top: 56, bottom: 40 },
    xAxis: { type: 'category', data: [...histLabels, ...futLabels], axisLabel: { color: '#7b82a0', fontSize: 10 } },
    yAxis: { scale: true, splitLine: { lineStyle: { color: '#2e3248' } }, axisLabel: { color: '#7b82a0' } },
    series: [
      { name: '歷史收盤', type: 'line', data: last20, showSymbol: false,
        lineStyle: { color: '#4f8ef7', width: 2.5 } },
      ...scenarios.map(s => ({
        name: s.name,
        type: 'line',
        data: [...Array(last20.length).fill(null), ...genPath(s.extra)],
        showSymbol: false,
        lineStyle: { color: s.color, width: s.width, type: 'dashed' },
      }))
    ]
  });
}

// ─────────────────────────────────────────────
// 10. 首頁儀表板（市場狀態 + 夜盤 + 排行）
// ─────────────────────────────────────────────

// 監測股票候選池（市值前50大 + 各類龍頭）
const WATCH_LIST = [
  { code: '2330', name: '台積電',   type: 'tse' },
  { code: '2317', name: '鴻海',     type: 'tse' },
  { code: '2454', name: '聯發科',   type: 'tse' },
  { code: '2412', name: '中華電',   type: 'tse' },
  { code: '2882', name: '國泰金',   type: 'tse' },
  { code: '2881', name: '富邦金',   type: 'tse' },
  { code: '2886', name: '兆豐金',   type: 'tse' },
  { code: '2303', name: '聯電',     type: 'tse' },
  { code: '2308', name: '台達電',   type: 'tse' },
  { code: '2382', name: '廣達',     type: 'tse' },
  { code: '3711', name: '日月光',   type: 'tse' },
  { code: '2357', name: '華碩',     type: 'tse' },
  { code: '2376', name: '技嘉',     type: 'tse' },
  { code: '2409', name: '友達',     type: 'tse' },
  { code: '2002', name: '中鋼',     type: 'tse' },
  { code: '2207', name: '和泰車',   type: 'tse' },
  { code: '2603', name: '長榮',     type: 'tse' },
  { code: '2609', name: '陽明',     type: 'tse' },
  { code: '2615', name: '萬海',     type: 'tse' },
  { code: '0050', name: '台灣50',   type: 'tse' },
  { code: '0056', name: '高股息ETF',type: 'tse' },
  { code: '2395', name: '研華',     type: 'tse' },
  { code: '2327', name: '國巨',     type: 'tse' },
  { code: '2344', name: '華邦電',   type: 'tse' },
  { code: '6505', name: '台塑化',   type: 'tse' },
];

// 夜盤/期貨商品清單（TWSE 期貨代碼）
const FUTURES_LIST = [
  { code: 'TSMC', twCode: '2330', name: '台積電期貨',   type: 'tse' },
  { code: 'TX',   twCode: 'FITX', name: '台指期（近月）', type: 'future' },
  { code: '2317', twCode: '2317', name: '鴻海',          type: 'tse' },
  { code: '2454', twCode: '2454', name: '聯發科',        type: 'tse' },
  { code: '2603', twCode: '2603', name: '長榮',          type: 'tse' },
  { code: '2609', twCode: '2609', name: '陽明',          type: 'tse' },
];

let homeTimers = [];
let rankData   = [];
let isHomePage = true;

// ── 判斷盤別 ──────────────────────────────────
function getSession() {
  // 台灣時間
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  const day  = now.getDay(); // 0=日,6=六
  if (day === 0 || day === 6) return 'closed';
  if (mins >= 9*60 && mins < 13*60+30) return 'day';    // 日盤 09:00~13:30
  if (mins >= 15*60 || mins < 5*60)   return 'night';   // 夜盤 15:00~隔天05:00
  return 'between';  // 盤後/開盤前
}

function updateClock() {
  const now = new Date();
  const tw  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const pad = n => String(n).padStart(2,'0');
  const timeStr = `${pad(tw.getHours())}:${pad(tw.getMinutes())}:${pad(tw.getSeconds())}`;
  const el = $('marketClock');
  if (el) el.textContent = `台灣時間 ${timeStr}`;

  const session = getSession();
  const dot  = $('sessionDot');
  const text = $('sessionText');
  if (dot && text) {
    dot.className  = 'session-dot ' + (session === 'day' ? 'live' : session === 'night' ? 'night' : 'closed');
    text.textContent = session === 'day' ? '🟢 日盤交易中' :
                       session === 'night' ? '🌙 夜盤交易中' :
                       session === 'between' ? '⏸️ 盤間休息' : '🔴 休市';
  }

  // 更新夜盤面板標題
  const panelTitle = $('futuresPanelTitle');
  if (panelTitle) {
    panelTitle.textContent = session === 'day'     ? '☀️ 主要股票即時行情（日盤）' :
                             session === 'night'   ? '🌙 盤後行情快照（台股個股無夜盤）' :
                             session === 'between' ? '📊 盤間行情快照' :
                                                    '📊 最近收盤行情';
  }
}

// ── 即時行情卡片（TWSE 即時 API）──────────────
async function fetchHomeRealtime(code, type) {
  try {
    const res  = await fetch(`${PROXY_BASE}/api/realtime?symbol=${code}&type=${type}`, { cache: 'no-store' });
    const json = await res.json();
    return json?.msgArray?.[0] || null;
  } catch { return null; }
}


// ── 我的持股（localStorage 持久化）──────────────
const PORTFOLIO_KEY = 'twstock_portfolio';

function loadPortfolioCodes() {
  try { return JSON.parse(localStorage.getItem(PORTFOLIO_KEY)) || []; }
  catch { return []; }
}

function savePortfolioCodes(arr) {
  localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(arr));
}

function addPortfolioCode(rawCode) {
  const code = rawCode.trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!code) return;
  const arr = loadPortfolioCodes();
  if (arr.includes(code)) return;
  arr.push(code);
  savePortfolioCodes(arr);
  refreshPortfolioPanel();
}

function removePortfolioCode(code) {
  const arr = loadPortfolioCodes().filter(c => c !== code);
  savePortfolioCodes(arr);
  refreshPortfolioPanel();
}

async function refreshPortfolioPanel() {
  const wrap = $('portfolioGrid');
  if (!wrap) return;
  const codes = loadPortfolioCodes();
  if (!codes.length) {
    wrap.innerHTML = '<div class="portfolio-empty">尚未加入任何持股，請輸入股票代碼後按「＋加入」</div>';
    return;
  }
  // 並發取得即時報價（先嘗試上市，再嘗試上櫃）
  const results = await Promise.all(codes.map(async code => {
    let d = await fetchHomeRealtime(code, 'tse');
    if (!d || !d.n) d = await fetchHomeRealtime(code, 'otc');
    return { code, data: d };
  }));
  wrap.innerHTML = results.map(({ code, data: d }) => {
    if (!d || !d.n) return `
      <div class="portfolio-card portfolio-card-err">
        <div class="portfolio-remove" onclick="removePortfolioCode('${code}')" title="移除">✕</div>
        <div class="futures-name">${code}</div>
        <div class="futures-price" style="font-size:13px;color:var(--muted)">查無資料</div>
      </div>`;
    const cur  = toFloat(livePrice(d) || d.y);
    const prev = toFloat(d.y);
    const chg  = cur - prev;
    const pct  = prev ? (chg / prev * 100) : 0;
    const cls  = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
    const sym  = chg > 0 ? '▲' : chg < 0 ? '▼' : '─';
    return `
      <div class="portfolio-card" onclick="analyzeStock('${code}')">
        <div class="portfolio-remove" onclick="event.stopPropagation();removePortfolioCode('${code}')" title="移除">✕</div>
        <div class="futures-name">${d.n} (${code})</div>
        <div class="futures-price ${cls}">${cur > 0 ? cur.toFixed(2) : '--'}</div>
        <div class="futures-change ${cls}">${sym} ${Math.abs(chg).toFixed(2)} (${Math.abs(pct).toFixed(2)}%)</div>
      </div>`;
  }).join('');
  const hint = $('portfolioRefreshHint');
  if (hint) hint.textContent = `更新：${new Date().toLocaleTimeString('zh-TW')}`;
}


// 台期指夜盤輪詢快照
let taiexPollPoints = [];
let taiexPollTimer  = null;

function startTaiexPoll() {
  if (taiexPollTimer) clearInterval(taiexPollTimer);
  taiexPollPoints = [];
  const poll = async () => {
    try {
      const res  = await fetch(`${PROXY_BASE}/api/taiex`, { cache: 'no-store' });
      const json = await res.json();
      const idx  = json?.index?.msgArray?.[0];
      const fut  = json?.futures?.msgArray?.[0];
      const ts   = Date.now();
      if (idx) {
        const price = toFloat(livePrice(idx) || idx.y);
        if (price > 0) {
          const last = taiexPollPoints[taiexPollPoints.length - 1];
          if (!last || ts - last.ts > 59000) taiexPollPoints.push({ ts, price });
          else last.price = price;
        }
      }
      updateTaiexBadge(idx, fut);
    } catch { }
  };
  poll();
  taiexPollTimer = setInterval(poll, 15000);
}

function stopTaiexPoll() {
  if (taiexPollTimer) { clearInterval(taiexPollTimer); taiexPollTimer = null; }
}

function updateTaiexBadge(idx, fut) {
  if (idx) {
    const cur  = toFloat(livePrice(idx) || idx.y);
    const prev = toFloat(idx.y);
    const chg  = cur - prev;
    const pct  = prev ? chg/prev*100 : 0;
    const cls  = chg > 0 ? 'up' : 'down';
    const sym  = chg > 0 ? '▲' : '▼';
    const el   = $('taiexBadge');
    if (el) {
      el.className = `idx-item ${cls}`;
      el.textContent = `加權 ${cur.toFixed(0)} ${sym}${Math.abs(pct).toFixed(2)}%`;
    }
  }
  if (fut) {
    const cur  = toFloat(livePrice(fut) || fut.y);
    const prev = toFloat(fut.y);
    const chg  = cur - prev;
    const pct  = prev ? chg/prev*100 : 0;
    const cls  = chg > 0 ? 'up' : 'down';
    const sym  = chg > 0 ? '▲' : '▼';
    const el   = $('futuresBadge');
    if (el && el.style) el.style.display = '';
    if (el) {
      el.className = `idx-item ${cls}`;
      el.textContent = `台期指 ${cur > 0 ? cur.toFixed(0) : '--'} ${sym}${Math.abs(pct).toFixed(2)}%`;
    }
  }
}

async function refreshFuturesPanel() {
  const grid = $('futuresGrid');
  if (!grid || !isHomePage) return;

  const session = getSession();

  // 夜盤期間：只顯示台期指走勢
  if (session === 'night') {
    grid.innerHTML = `<div class="futures-card night-card" style="grid-column:1/-1;padding:20px">
      <div class="futures-name">🌙 夜盤期間 — 台指期（近月）即時走勢</div>
      <div id="taiexNightPrice" class="futures-price" style="font-size:28px">載入中...</div>
      <div id="taiexNightChange" class="futures-change">--</div>
      <div style="margin-top:8px;font-size:11px;color:var(--muted)">台股個股無夜盤；台期指每15秒更新</div>
    </div>`;
    // 更新台期指即時數字
    try {
      const res  = await fetch(`${PROXY_BASE}/api/taiex`, { cache: 'no-store' });
      const json = await res.json();
      const fut  = json?.futures?.msgArray?.[0];
      if (fut) {
        const cur  = toFloat(livePrice(fut) || fut.y);
        const prev = toFloat(fut.y);
        const chg  = cur - prev;
        const pct  = prev ? chg/prev*100 : 0;
        const cls  = chg > 0 ? 'up' : 'down';
        const sym  = chg > 0 ? '▲' : '▼';
        const pEl  = $('taiexNightPrice');
        const cEl  = $('taiexNightChange');
        if (pEl) { pEl.textContent = cur > 0 ? cur.toFixed(0) : '--'; pEl.className = `futures-price ${cls}`; }
        if (cEl) { cEl.textContent = `${sym} ${Math.abs(chg).toFixed(0)} (${Math.abs(pct).toFixed(2)}%)`; cEl.className = `futures-change ${cls}`; }
      }
    } catch { }
    const hint = $('futuresRefreshHint');
    if (hint) hint.textContent = `上次更新：${new Date().toLocaleTimeString('zh-TW')}`;
    return;
  }

  // 日盤/休市：顯示主要股票快照
  const cards = await Promise.all(
    FUTURES_LIST.map(async f => {
      const d = await fetchHomeRealtime(f.twCode, f.type === 'future' ? 'tse' : f.type);
      return { ...f, data: d };
    })
  );

  grid.innerHTML = cards.map(f => {
    const d = f.data;
    if (!d) return `<div class="futures-card">
      <div class="futures-name">${f.name}</div>
      <div class="futures-price" style="font-size:14px;color:var(--muted)">資料不可用</div>
    </div>`;
    const cur  = toFloat(livePrice(d) || d.y);
    const prev = toFloat(d.y);
    const chg  = cur - prev;
    const pct  = prev ? (chg / prev * 100) : 0;
    const cls  = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
    const sym  = chg > 0 ? '▲' : chg < 0 ? '▼' : '─';
    return `<div class="futures-card" onclick="analyzeStock('${f.twCode}')">
      <div class="futures-name">${f.name} (${f.twCode})</div>
      <div class="futures-price ${cls}">${cur > 0 ? cur.toFixed(2) : '--'}</div>
      <div class="futures-change ${cls}">${sym} ${Math.abs(chg).toFixed(2)} (${Math.abs(pct).toFixed(2)}%)</div>
    </div>`;
  }).join('');

  const hint = $('futuresRefreshHint');
  if (hint) hint.textContent = `上次更新：${new Date().toLocaleTimeString('zh-TW')}`;
}

// ── 首頁排行榜機率估算：含基本面（PE / PBR / 殖利率）──
async function quickUpProb(code, type, days) {
  days = days || 5;
  try {
    const today   = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}01`;
    // 歷史K線（當月 + 上月）與基本面並發拉取
    const [histCur, histPrev, fundJson] = await Promise.all([
      fetch(`${PROXY_BASE}/api/history?symbol=${code}&date=${dateStr}`).then(r => r.json()),
      fetch(`${PROXY_BASE}/api/history?symbol=${code}&date=${getPrevMonthStr()}`).then(r => r.json()),
      fetch(`${PROXY_BASE}/api/fundamental?symbol=${code}`).then(r => r.json()).catch(() => null),
    ]);
    let rows = [];
    for (const j of [histCur, histPrev]) {
      const raw = j?.data || j?.aaData || [];
      rows.push(...raw.map(r => toFloat(r[6])).filter(v => v > 0));
    }
    if (rows.length < 10) return null;
    // 解析基本面（FinMind TaiwanStockPER 最後一筆）
    const perData = fundJson?.per?.data;
    const last    = perData?.length ? perData[perData.length - 1] : null;
    const pe = last ? toFloat(last.PER)            : 0;
    const dy = last ? toFloat(last.dividend_yield) : 0;
    const pb = last ? toFloat(last.PBR)            : 0;
    const { upProb } = calcPrediction(rows, days, pe, dy, pb, 50);
    return upProb;
  } catch { return null; }
}

function getPrevMonthStr() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
}

let rankDays = 5;  // 首頁排行榜目前選定的天數

async function buildRankList(days) {
  if (days !== undefined) rankDays = days;
  const d = rankDays;

  const upEl    = $('rankUpList');
  const downEl  = $('rankDownList');
  if (!upEl || !downEl) return;

  // 更新排行榜標題
  const upTitle   = $('rankUpTitle');
  const downTitle = $('rankDownTitle');
  if (upTitle)   upTitle.textContent   = `📈 ${d}日上漲機率 TOP 5`;
  if (downTitle) downTitle.textContent = `📉 ${d}日下跌機率 TOP 5`;

  upEl.innerHTML   = '<div class="rank-loading">計算中...</div>';
  downEl.innerHTML = '<div class="rank-loading">計算中...</div>';

  // 並發取前16支（不一次取全部避免太慢）
  const pool = WATCH_LIST.slice(0, 16);
  const results = await Promise.all(
    pool.map(async s => {
      const prob = await quickUpProb(s.code, s.type, d);
      return { ...s, prob };
    })
  );

  const valid = results.filter(r => r.prob !== null);
  valid.sort((a, b) => b.prob - a.prob);
  rankData = valid;

  const top5Up   = valid.slice(0, 5);
  const top5Down = [...valid].sort((a,b) => a.prob - b.prob).slice(0, 5);

  const makeItem = (s, i, isUp) => {
    const noClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : 'rn';
    const prob = isUp ? s.prob : (100 - s.prob);
    const barColor = isUp ? '#ef4444' : '#22c55e';
    return `<div class="rank-item" onclick="analyzeStock('${s.code}')">
      <div class="rank-no ${noClass}">${i+1}</div>
      <div class="rank-info">
        <div class="rank-name">${s.name}</div>
        <div class="rank-code">${s.code}</div>
      </div>
      <div class="rank-bar-wrap">
        <div class="rank-bar" style="width:${prob}%;background:${barColor}"></div>
      </div>
      <div class="rank-prob ${isUp ? 'up' : 'down'}">${prob}%</div>
    </div>`;
  };

  upEl.innerHTML   = top5Up.map((s,i)   => makeItem(s, i, true)).join('');
  downEl.innerHTML = top5Down.map((s,i) => makeItem(s, i, false)).join('');
}

// ── 加權指數 & 台期指 ─────────────────────────
async function fetchTaiex() {
  try {
    const res  = await fetch(`${PROXY_BASE}/api/taiex`, { cache: 'no-store' });
    const json = await res.json();
    updateTaiexBadge(json?.index?.msgArray?.[0], json?.futures?.msgArray?.[0]);
  } catch { }
}

// ── 啟動首頁 ──────────────────────────────────
function startHomePage() {
  isHomePage = true;
  const hd = $('homeDashboard');
  if (hd) hd.style.display = '';

  homeTimers.forEach(t => clearInterval(t));
  homeTimers = [];

  // 時鐘（每秒）
  updateClock();
  homeTimers.push(setInterval(updateClock, 1000));

  // 加權指數 & 期指 badge（日盤30秒、夜盤15秒）
  fetchTaiex();
  const taiexInterval = getSession() === 'night' ? 15000 : 30000;
  homeTimers.push(setInterval(() => { if (isHomePage) fetchTaiex(); }, taiexInterval));

  // 夜盤期間額外啟動台期指即時輪詢
  if (getSession() === 'night') {
    startTaiexPoll();
  }

  // 即時行情面板：日盤 5 秒更新，其他 30 秒
  refreshFuturesPanel();
  const fpInterval = getSession() === 'day' ? 5000 : 30000;
  homeTimers.push(setInterval(() => { if (isHomePage) refreshFuturesPanel(); }, fpInterval));

  // 我的持股：日盤 5 秒更新，其他 30 秒
  refreshPortfolioPanel();
  const pfInterval = getSession() === 'day' ? 5000 : 30000;
  homeTimers.push(setInterval(() => { if (isHomePage) refreshPortfolioPanel(); }, pfInterval));

  // 排行榜（僅啟動時算一次）
  buildRankList();
}

function stopHomePage() {
  isHomePage = false;
  stopTaiexPoll();
  homeTimers.forEach(t => clearInterval(t));
  homeTimers = [];
}

function showHome() {
  stopStockPoll();   // 停止個股輪詢
  stopHomePage();
  const main = $('mainContent');
  main.innerHTML = '';
  const hd = document.createElement('div');
  hd.id = 'homeDashboard';
  // 恢復天數選擇器，並依 rankDays 標記目前選中的按鈕
  const dayBtns = [1,2,3,4,5,6,7].map(d =>
    `<button class="rank-day-btn${d === rankDays ? ' active' : ''}" data-days="${d}">${d}日</button>`
  ).join('');
  hd.innerHTML = `
    <div class="market-status-bar">
      <div class="market-session" id="sessionBadge"><span class="session-dot" id="sessionDot"></span><span id="sessionText">--</span></div>
      <div class="market-clock" id="marketClock">--</div>
      <div class="market-indices" id="marketIndices">
        <span class="idx-item" id="taiexBadge">加權指數 載入中...</span>
        <span class="idx-item" id="futuresBadge" style="display:none">台期指 --</span>
      </div>
    </div>
    <div class="home-futures-panel" id="futuresPanel">
      <div class="panel-title">
        <span id="futuresPanelTitle">🌙 夜盤即時行情</span>
        <span class="refresh-hint" id="futuresRefreshHint"></span>
      </div>
      <div class="futures-grid" id="futuresGrid"><div class="futures-loading">載入中...</div></div>
    </div>
    <div class="home-portfolio-panel" id="portfolioPanel">
      <div class="panel-title">
        <span>💼 我的持股</span>
        <span class="refresh-hint" id="portfolioRefreshHint"></span>
        <div class="portfolio-add-bar">
          <input id="portfolioInput" class="portfolio-input" type="text" placeholder="輸入代碼，例如 2330" maxlength="6" />
          <button class="portfolio-add-btn" id="portfolioAddBtn">＋加入</button>
        </div>
      </div>
      <div class="futures-grid" id="portfolioGrid"><div class="portfolio-empty">尚未加入任何持股，請輸入股票代碼後按「＋加入」</div></div>
    </div>
    <div class="rank-days-bar">
      <span class="rank-days-label">預測天數：</span>
      <div class="rank-days-group" id="rankDaysGroup">${dayBtns}</div>
    </div>
    <div class="home-rank-wrap">
      <div class="rank-panel">
        <div class="rank-title up-title" id="rankUpTitle">📈 ${rankDays}日上漲機率 TOP 5</div>
        <div class="rank-list" id="rankUpList"><div class="rank-loading">計算中...</div></div>
      </div>
      <div class="rank-panel">
        <div class="rank-title down-title" id="rankDownTitle">📉 ${rankDays}日下跌機率 TOP 5</div>
        <div class="rank-list" id="rankDownList"><div class="rank-loading">計算中...</div></div>
      </div>
    </div>
    <div class="home-overview-row">
      <div class="overview-card"><div class="ov-label">今日市場</div><div class="ov-val" id="ovMarket">--</div></div>
      <div class="overview-card"><div class="ov-label">成交量</div><div class="ov-val" id="ovVolume">--</div></div>
      <div class="overview-card"><div class="ov-label">漲家數</div><div class="ov-val up" id="ovUp">--</div></div>
      <div class="overview-card"><div class="ov-label">跌家數</div><div class="ov-val down" id="ovDown">--</div></div>
    </div>`;
  main.appendChild(hd);
  // 重新綁定天數選擇器（DOM 動態重建後需重新綁定）
  $('rankDaysGroup').addEventListener('click', e => {
    const btn = e.target.closest('.rank-day-btn');
    if (!btn) return;
    $('rankDaysGroup').querySelectorAll('.rank-day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    buildRankList(parseInt(btn.dataset.days));
  });
  // 持股加入按鈕
  $('portfolioAddBtn').addEventListener('click', () => {
    addPortfolioCode($('portfolioInput').value);
    $('portfolioInput').value = '';
  });
  $('portfolioInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { addPortfolioCode($('portfolioInput').value); $('portfolioInput').value = ''; }
  });
  startHomePage();
}

// ─────────────────────────────────────────────
// 11. 事件綁定
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('searchBtn').addEventListener('click', () => analyzeStock($('stockInput').value));
  $('stockInput').addEventListener('keydown', e => { if (e.key === 'Enter') analyzeStock($('stockInput').value); });
  document.querySelectorAll('.tag').forEach(tag =>
    tag.addEventListener('click', () => { $('stockInput').value = tag.dataset.code; analyzeStock(tag.dataset.code); })
  );
  $('logoHome').addEventListener('click', showHome);

  // 持股面板（初次載入的靜態 DOM 綁定）
  $('portfolioAddBtn').addEventListener('click', () => {
    addPortfolioCode($('portfolioInput').value);
    $('portfolioInput').value = '';
  });
  $('portfolioInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { addPortfolioCode($('portfolioInput').value); $('portfolioInput').value = ''; }
  });

  // 首頁排行榜天數選擇器（初次載入的靜態 rankDaysGroup 綁定）
  $('rankDaysGroup').addEventListener('click', e => {
    const btn = e.target.closest('.rank-day-btn');
    if (!btn) return;
    $('rankDaysGroup').querySelectorAll('.rank-day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    buildRankList(parseInt(btn.dataset.days));
  });

  // 個股預測天數選擇器（動態建立於 template，用事件委派）
  document.addEventListener('click', e => {
    const btn = e.target.closest('.pred-day-btn');
    if (!btn) return;
    document.querySelectorAll('.pred-day-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderPrediction(parseInt(btn.dataset.days));
  });

  // 首頁啟動
  startHomePage();
});

// analyzeStock 離開首頁時停止 timer，並同步個股預測天數與首頁選定天數一致
const _origAnalyze = analyzeStock;
analyzeStock = async function(code) {
  predDays = rankDays;   // 個股預測天數跟首頁選的一致
  stopHomePage();
  await _origAnalyze(code);
};
