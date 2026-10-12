const express = require('express');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3000;
const DATA_FILE  = path.join(__dirname, 'cartera-data.json');
const HIST_FILE  = path.join(__dirname, 'historial.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ══════════════════════════════════════════════════
   PERSISTENCIA DE PREFERENCIAS
══════════════════════════════════════════════════ */
function loadPrefs() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) {}
  return {};
}
function savePrefs(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('Error guardando preferencias:', e.message); }
}
app.get('/api/state', (req, res) => res.json(loadPrefs()));
app.post('/api/state', (req, res) => {
  savePrefs({ ...loadPrefs(), ...req.body });
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════
   HISTORIAL DE OPERACIONES
══════════════════════════════════════════════════ */
function loadHistorial() {
  try { if (fs.existsSync(HIST_FILE)) return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); }
  catch (e) {}
  return [];
}
function saveHistorial(entries) {
  fs.writeFileSync(HIST_FILE, JSON.stringify(entries, null, 2), 'utf8');
}
app.get('/api/historial', (req, res) => res.json(loadHistorial()));
app.post('/api/historial', (req, res) => {
  const entries = loadHistorial();
  const entry = {
    id:      Date.now(),
    sym:     (req.body.sym || '').toUpperCase().trim(),
    type:    req.body.type || 'compra',
    entry:   parseFloat(req.body.entry) || null,
    exit:    parseFloat(req.body.exit) || null,
    amount:  parseFloat(req.body.amount) || null,
    qty:     parseFloat(req.body.qty) || null,
    dateIn:  req.body.dateIn || null,
    dateOut: req.body.dateOut || null,
    note:    req.body.note || '',
    pct:     (req.body.entry && req.body.exit) ? ((req.body.exit - req.body.entry) / req.body.entry * 100) : null,
    pnl:     (req.body.entry && req.body.exit && req.body.amount) ? (req.body.amount * (req.body.exit - req.body.entry) / req.body.entry) : null,
    days:    (req.body.dateIn && req.body.dateOut) ? Math.round((new Date(req.body.dateOut) - new Date(req.body.dateIn)) / 86400000) : null,
  };
  entries.unshift(entry);
  saveHistorial(entries);
  res.json({ ok: true, entry });
});
app.delete('/api/historial/:id', (req, res) => {
  const entries = loadHistorial().filter(e => e.id !== parseInt(req.params.id));
  saveHistorial(entries);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════
   ALMACÉN DE HISTORIAL OHLCV EN DISCO
   Backfill completo (5 años) una sola vez por símbolo, y de ahí en más
   siempre repregunta la vela reciente para reflejar el precio intradiario
   actual — nada de polling automático en segundo plano (todo se dispara con F5).
══════════════════════════════════════════════════ */
const MARKET_FILE = path.join(__dirname, 'market-history.json');
function loadMarketStore() {
  try { if (fs.existsSync(MARKET_FILE)) return JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8')); }
  catch (e) {}
  return {};
}
function saveMarketStore(store) {
  try { fs.writeFileSync(MARKET_FILE, JSON.stringify(store), 'utf8'); }
  catch (e) { console.error('Error guardando historial de mercado:', e.message); }
}
const marketStore = loadMarketStore(); // { [sym]: {closes,opens,highs,lows,volumes,dates} }

/* ── Nombre completo del símbolo (ej. "Apple Inc.") ──
   El endpoint de velas (v8/finance/chart) dejó de incluir longName/shortName en meta (lo removió
   Yahoo en algún momento — está documentado por varios desarrolladores que dependían de eso).
   v1/finance/search sí lo tiene, es público (no requiere crumb/cookie) y se cachea en disco para
   siempre — el nombre de una empresa prácticamente no cambia, no hace falta repreguntar. */
const NAME_FILE = path.join(__dirname, 'symbol-names.json');
function loadNameStore() {
  try { if (fs.existsSync(NAME_FILE)) return JSON.parse(fs.readFileSync(NAME_FILE, 'utf8')); }
  catch (e) {}
  return {};
}
function saveNameStore(store) {
  try { fs.writeFileSync(NAME_FILE, JSON.stringify(store), 'utf8'); }
  catch (e) {}
}
const nameStore = loadNameStore(); // { [sym]: name }

async function fetchSymbolName(sym) {
  if (nameStore[sym]) return nameStore[sym];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
    'Accept': 'application/json',
  };
  for (const base of ['query1', 'query2']) {
    try {
      const url = `https://${base}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=5&newsCount=0`;
      const res = await fetch(url, { headers, timeout: 8000 });
      if (!res.ok) continue;
      const json = await res.json();
      const quotes = json?.quotes || [];
      const exact = quotes.find(q => q.symbol?.toUpperCase() === sym.toUpperCase());
      const pick = exact || quotes[0];
      const name = pick?.longname || pick?.shortname || null;
      if (name) { nameStore[sym] = name; saveNameStore(nameStore); return name; }
    } catch (e) {}
  }
  return null;
}

/* ── Yahoo Finance fetch — todos los campos alineados por el mismo índice (evita desfasajes) ── */
async function fetchFromYahoo(sym, range = '1y') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (const base of ['query1', 'query2']) {
    for (const r of [range, '6mo', '3mo']) {
      const url = `https://${base}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${r}&interval=1d&_=${Date.now()}`;
      try {
        const res = await fetch(url, { headers, timeout: 12000 });
        if (!res.ok) continue;
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result) continue;
        const q = result.indicators?.quote?.[0];
        const ts = result.timestamp;
        if (!q || !ts) continue;
        const closes = [], opens = [], highs = [], lows = [], volumes = [], dates = [];
        for (let i = 0; i < ts.length; i++) {
          if (q.close?.[i] == null) continue; // se filtra por un único índice, así todos los arrays quedan alineados
          closes.push(q.close[i]);
          opens.push(q.open?.[i] ?? q.close[i]);
          highs.push(q.high?.[i] ?? q.close[i]);
          lows.push(q.low?.[i] ?? q.close[i]);
          volumes.push(q.volume?.[i] ?? 0);
          dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
        }
        if (closes.length < 5) continue;
        return { closes, opens, highs, lows, volumes, dates };
      } catch (e) {}
    }
  }
  return null;
}

/* ── Combina historial existente + datos frescos, por fecha, sin duplicar ── */
function mergeSeries(existing, fresh) {
  const byDate = new Map();
  if (existing) existing.dates.forEach((d, i) => byDate.set(d, {
    close: existing.closes[i], open: existing.opens[i], high: existing.highs[i], low: existing.lows[i], volume: existing.volumes[i],
  }));
  fresh.dates.forEach((d, i) => byDate.set(d, {
    close: fresh.closes[i], open: fresh.opens[i], high: fresh.highs[i], low: fresh.lows[i], volume: fresh.volumes[i],
  }));
  const dates = [...byDate.keys()].sort();
  const closes = [], opens = [], highs = [], lows = [], volumes = [];
  dates.forEach(d => { const row = byDate.get(d); closes.push(row.close); opens.push(row.open); highs.push(row.high); lows.push(row.low); volumes.push(row.volume); });
  return { closes, opens, highs, lows, volumes, dates };
}

/* ── Punto único de acceso a datos de un símbolo: backfill completo (5y) la primera vez que se ve
     el símbolo; de ahí en más SIEMPRE repregunta la vela reciente (5d) para reflejar el precio
     intradiario actual — el usuario espera que F5 traiga el valor oficial, no uno congelado desde
     la primera consulta del día. No hay polling automático de fondo, pero sí refetch en cada pedido
     explícito (F5 / carga de página / refresh por símbolo). ── */
async function getSeries(sym) {
  sym = sym.toUpperCase();
  const existing = marketStore[sym];
  const fresh = await fetchFromYahoo(sym, existing ? '5d' : '5y'); // 5y: alcanza para SMA200 semanal (~200 velas = ~4 años)
  if (!fresh) return existing || null;
  const merged = existing ? mergeSeries(existing, fresh) : fresh;
  marketStore[sym] = merged;
  saveMarketStore(marketStore);
  return merged;
}

/* ══════════════════════════════════════════════════
   INDICADORES CALCULADOS EN EL SERVIDOR
══════════════════════════════════════════════════ */
function ema(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [val];
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const offset = ema12.length - ema26.length;
  const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
  const signalLine = ema(macdLine, 9);
  const sigOffset = macdLine.length - signalLine.length;
  const last = macdLine.length - 1;
  const lastSig = signalLine.length - 1;
  const prev = last - 1;
  const prevSig = lastSig - 1;
  return {
    macd:      macdLine[last],
    signal:    signalLine[lastSig],
    hist:      macdLine[last] - signalLine[lastSig],
    prevHist:  macdLine[prev] - signalLine[prevSig],
    bullCross: macdLine[last] >= signalLine[lastSig] && macdLine[prev] < signalLine[prevSig],
    bearCross: macdLine[last] <= signalLine[lastSig] && macdLine[prev] > signalLine[prevSig],
    aboveZero: macdLine[last] > 0,
  };
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcOBV(closes, volumes) {
  let obv = 0;
  const series = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    series.push(obv);
  }
  const last10 = series.slice(-10);
  const obvTrend = last10.length > 1 ? (last10.at(-1) > last10[0] ? 1 : -1) : 0;
  const prices = closes.slice(-11);
  const priceTrend = prices.length > 1 ? (prices.at(-1) > prices[0] ? 1 : -1) : 0;
  let obvDiv = null;
  if (obvTrend === 1 && priceTrend === -1)
    obvDiv = { type: 'bullish', label: 'OBV▲ Precio▼', desc: 'Acumulacion silenciosa — el volumen no confirma la baja del precio.' };
  else if (obvTrend === -1 && priceTrend === 1)
    obvDiv = { type: 'bearish', label: 'OBV▼ Precio▲', desc: 'Distribucion — el volumen no confirma la suba del precio.' };
  return { val: obv, trend: obvTrend, div: obvDiv };
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return null;
  const prev = closes[closes.length - period - 1];
  const cur  = closes.at(-1);
  return prev > 0 ? ((cur - prev) / prev * 100) : null;
}

function calc52Week(closes) {
  if (closes.length < 5) return null;
  const window = closes.slice(-252);
  const high = Math.max(...window), low = Math.min(...window);
  const price = closes.at(-1);
  return { high, low, fromHigh: (price - high) / high * 100, fromLow: (price - low) / low * 100 };
}

function calcScore(closes, volumes) {
  if (closes.length < 26) return { score: null, timing: null };
  const rsiVal  = calcRSI(closes, 14) ?? 50;
  const macd    = calcMACD(closes);
  const macdPos = macd ? (macd.macd > macd.signal ? 1 : -1) : 0;
  const volAvg  = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volCur  = volumes.at(-1);
  const volR    = volAvg > 0 ? volCur / volAvg : 1;
  const rsiScore  = rsiVal < 30 ? 80 : rsiVal > 70 ? 25 : 50;
  const macdScore = macdPos > 0 ? 70 : 30;
  const volScore  = Math.min(100, volR * 50);
  const score = rsiScore * 0.3 + macdScore * 0.4 + volScore * 0.3;
  let timing = 0;
  const k = calcStochRSI(closes)?.k ?? 50;
  if (k < 20 && macdPos > 0) timing += 40; else if (k < 20) timing += 25; else timing += 20;
  if (macdPos > 0) timing += 30; else timing += 10;
  if (volR > 1) timing += 20; else timing += 10;
  return { score: Math.round(score), timing: Math.round(timing), rsi: rsiVal, macd: macdPos };
}

function calcStochRSI(closes, period = 14) {
  if (closes.length < period * 2) return { k: null };
  const rsiArr = [];
  for (let i = period; i <= closes.length; i++) {
    rsiArr.push(calcRSI(closes.slice(0, i), period));
  }
  const valid = rsiArr.filter(v => v != null);
  if (valid.length < period) return { k: null };
  const window = valid.slice(-period);
  const min = Math.min(...window), max = Math.max(...window);
  const rawK = max === min ? 0 : (valid.at(-1) - min) / (max - min) * 100;
  return { k: rawK };
}

function calcTrend(closes, period = 10) {
  if (closes.length < period) return { direction: 0, label: 'Lateral' };
  const slice = closes.slice(-period);
  const n = slice.length;
  const xMean = (n - 1) / 2;
  const yMean = slice.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  slice.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
  const slope = den ? num / den : 0;
  const slopePct = slope / yMean * 100;
  if (slopePct > 0.3) return { direction: 1, label: `+${slopePct.toFixed(2)}%/d` };
  if (slopePct < -0.3) return { direction: -1, label: `${slopePct.toFixed(2)}%/d` };
  return { direction: 0, label: 'Lateral' };
}

function calcGap(closes, opens) {
  if (closes.length < 2 || !opens?.length) return null;
  const prevClose = closes.at(-2);
  const todayOpen = opens.at(-1);
  const gapPct = (todayOpen - prevClose) / prevClose * 100;
  if (Math.abs(gapPct) < 0.5) return { gapPct, type: 'PLANO', signal: 'neutral' };
  const rsi = calcRSI(closes, 14);
  const isUp = gapPct > 0;
  if (isUp) {
    if (rsi && rsi > 70) return { gapPct, type: 'FADE (OB)', signal: 'sell' };
    return { gapPct, type: 'GAP GO ▲', signal: 'buy' };
  } else {
    if (rsi && rsi < 30) return { gapPct, type: 'REBOTE? (OS)', signal: 'watch' };
    return { gapPct, type: 'GAP GO ▼', signal: 'sell' };
  }
}

function fmtNum(n) {
  if (n == null) return null;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

function computeAllIndicators(ohlcv) {
  const { closes, opens, highs, lows, volumes } = ohlcv;
  const price  = closes.at(-1);
  const prev   = closes.at(-2) ?? price;
  const change = ((price - prev) / prev) * 100;
  const rsi    = calcRSI(closes, 14);
  const macd   = calcMACD(closes);
  const sma20  = calcSMA(closes, 20);
  const sma50  = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const obv    = calcOBV(closes, volumes);
  const stoch  = calcStochRSI(closes);
  const trend  = calcTrend(closes);
  const sc     = calcScore(closes, volumes);
  const gap    = calcGap(closes, opens);
  const roc    = calcROC(closes, 10);
  const w52    = calc52Week(closes);
  const volAvg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volR   = volAvg > 0 ? volumes.at(-1) / volAvg : null;

  return {
    price, change,
    rsi:     rsi != null ? +rsi.toFixed(2) : null,
    macd:    macd ? {
      macd:      +macd.macd.toFixed(4),
      signal:    +macd.signal.toFixed(4),
      hist:      +macd.hist.toFixed(4),
      prevHist:  +macd.prevHist.toFixed(4),
      bullCross: macd.bullCross,
      bearCross: macd.bearCross,
      aboveZero: macd.aboveZero,
    } : null,
    sma20:   sma20  != null ? +sma20.toFixed(4)  : null,
    sma50:   sma50  != null ? +sma50.toFixed(4)  : null,
    sma200:  sma200 != null ? +sma200.toFixed(4) : null,
    obv:     { val: fmtNum(obv.val), trend: obv.trend, div: obv.div },
    stoch:   { k: stoch.k != null ? +stoch.k.toFixed(2) : null },
    trend:   { direction: trend.direction, label: trend.label },
    score:   sc.score,
    timing:  sc.timing,
    gap:     gap ? { gapPct: +gap.gapPct.toFixed(2), type: gap.type, signal: gap.signal } : null,
    volRatio: volR != null ? +volR.toFixed(2) : null,
    roc:     roc != null ? +roc.toFixed(2) : null,
    w52:     w52,
    // Raw price data (last 60 points) for in-browser chart
    closes:  closes.slice(-60),
    volumes: volumes.slice(-60),
    opens:   opens.slice(-60),
    highs:   highs.slice(-60),
    lows:    lows.slice(-60),
  };
}

/* ══════════════════════════════════════════════════
   ENDPOINT PRINCIPAL — /api/indicators/:sym
══════════════════════════════════════════════════ */
app.get('/api/indicators/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const ohlcv = await getSeries(sym);
  if (!ohlcv) return res.status(502).json({ error: `Sin datos para ${sym}` });
  res.json(computeAllIndicators(ohlcv));
});

app.post('/api/refresh/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  delete marketStore[sym]; // fuerza un backfill completo de nuevo para este símbolo
  saveMarketStore(marketStore);
  const ohlcv = await getSeries(sym);
  if (!ohlcv) return res.status(502).json({ error: `Sin datos para ${sym}` });
  res.json(computeAllIndicators(ohlcv));
});

/* ══════════════════════════════════════════════════
   ROTACIÓN DE MERCADOS
══════════════════════════════════════════════════ */
const ROTATION_SYMS = ['SPY','QQQ','XLK','XLF','XLE','XLV','XLI','XLC','XLY','XLP','XLU','XLRE','XLB','GLD','TLT'];
app.get('/api/rotation', async (req, res) => {
  const results = {};
  for (const sym of ROTATION_SYMS) {
    const ohlcv = await getSeries(sym);
    if (ohlcv) results[sym] = computeAllIndicators(ohlcv);
    await new Promise(r => setTimeout(r, 300)); // getSeries ahora siempre consulta a Yahoo, pausamos siempre
  }
  res.json(results);
});

/* ══════════════════════════════════════════════════
   PROXY YAHOO RAW (fallback para el HTML)
══════════════════════════════════════════════════ */
app.get('/api/yahoo', async (req, res) => {
  const { sym } = req.query;
  if (!sym) return res.status(400).json({ error: 'sym requerido' });
  const symU = sym.toUpperCase();
  const ohlcv = await getSeries(symU);
  if (!ohlcv) return res.status(502).json({ error: 'Sin datos' });
  const name = await fetchSymbolName(symU);
  // timestamp a mediodía UTC para evitar problemas de huso horario al convertir de vuelta a fecha
  const timestamp = ohlcv.dates.map(d => Math.floor(new Date(d + 'T12:00:00Z').getTime() / 1000));
  res.json({
    chart: { result: [{ timestamp, meta: { longName: name }, indicators: { quote: [{ close: ohlcv.closes, open: ohlcv.opens, high: ohlcv.highs, low: ohlcv.lows, volume: ohlcv.volumes }] } }], error: null }
  });
});

app.get('/api/cache-status', (req, res) => {
  const status = {};
  Object.entries(marketStore).forEach(([sym, d]) => {
    status[sym] = { lastDate: d.dates?.at(-1) || null, points: d.closes?.length || 0 };
  });
  res.json(status);
});

/* ══════════════════════════════════════════════════
   START
   Sin refresco automático en background — todo se actualiza on-demand
   cuando el cliente pide datos (F5 / recarga de página).
══════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   Cartera Dashboard — Servidor Node  ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  → http://localhost:${PORT}`);
  console.log('  → Historial OHLCV persistido en market-history.json');
  console.log('  → Sin polling automático — se actualiza al pedir datos (F5)');
  console.log('  → Ctrl+C para detener');
  console.log('');
});
