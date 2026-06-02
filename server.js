const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ── CONFIG DESDE VARIABLES DE ENTORNO (Railway) ────────────────────────────
const {
  ANTHROPIC_API_KEY,
  TWILIO_SID,
  TWILIO_TOKEN,
  TWILIO_FROM,       // whatsapp:+14155238886
  TWILIO_TO,         // whatsapp:+50766713170
  IBKR_URL,          // https://localhost:5000 o URL del gateway
  IBKR_ACCOUNT,
  MIN_CONFIDENCE = '90',
  SCAN_INTERVAL_MIN = '30',
  WATCHLIST = 'SPY,QQQ,NVDA,AAPL,MSFT,AMZN,META,TSLA,GOOGL,AMD,JPM,GLD'
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

let scanCount = 0;
let alertsSent = [];
let lastScanResults = [];

// ── MARKET DATA (Yahoo Finance) ────────────────────────────────────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

async function fetchMarketData(ticker) {
  const t = ticker.toUpperCase().trim();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=3mo`;
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
  if (!data.chart.result) throw new Error(`No data for ${t}`);
  const meta = data.chart.result[0].meta;
  const q = data.chart.result[0].indicators.quote[0];
  const closes = q.close.filter(x => x != null);
  const volumes = q.volume.filter(x => x != null);
  const highs = q.high.filter(x => x != null);
  const lows = q.low.filter(x => x != null);
  const price = parseFloat(meta.regularMarketPrice.toFixed(2));
  const prevClose = parseFloat(meta.chartPreviousClose.toFixed(2));
  const change = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sma50 = closes.slice(-Math.min(50, closes.length)).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? Math.abs(d) : 0);
  }
  const ag = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const al = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const rsi = parseFloat((100 - 100 / (1 + (al === 0 ? 100 : ag / al))).toFixed(1));
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const macd = e12[e12.length - 1] - e26[e26.length - 1];
  const macdHist = parseFloat((macd - macd * 0.9).toFixed(2));
  const vol10avg = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volRatio = parseFloat((volumes[volumes.length - 1] / vol10avg).toFixed(2));
  return {
    ticker: t, price, change, volRatio,
    sma20: parseFloat(sma20.toFixed(2)),
    sma50: parseFloat(sma50.toFixed(2)),
    rsi, macdHist,
    high52w: parseFloat(Math.max(...highs).toFixed(2)),
    low52w: parseFloat(Math.min(...lows).toFixed(2)),
    pctFrom52h: parseFloat(((price - Math.max(...highs)) / Math.max(...highs) * 100).toFixed(1))
  };
}

// ── CLAUDE ANALYSIS ────────────────────────────────────────────────────────
async function analyzeWithClaude(md) {
  const sys = `Eres un agente cuantitativo. Responde SOLO con JSON válido sin markdown:
{"action":"COMPRAR"|"MANTENER"|"VENDER"|"SALIR","confidence":1-100,"entry_price":number|null,"stop_loss":number|null,"target_price":number|null,"timeframe":"corto plazo"|"mediano plazo"|"largo plazo","rationale":"max 2 oraciones en español","ibkr_order_type":"MKT"|"LMT"|"STP","ibkr_order_detail":"string","risk_reward":number|null}`;
  const msg = `${md.ticker} | $${md.price} | ${md.change}% hoy | RSI:${md.rsi} | SMA20:$${md.sma20} | SMA50:$${md.sma50} | MACDhist:${md.macdHist} | VolRatio:${md.volRatio}x | 52wH:$${md.high52w} | ${md.pctFrom52h}% vs 52wH`;
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: sys,
    messages: [{ role: 'user', content: msg }]
  });
  const text = res.content.map(i => i.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ── IBKR ORDER EXECUTION ───────────────────────────────────────────────────
async function getConid(ticker) {
  const { data } = await axios.get(
    `${IBKR_URL}/v1/api/iserver/secdef/search?symbol=${ticker}&name=true&secType=STK`,
    { timeout: 10000 }
  );
  if (!data[0] || !data[0].conid) throw new Error(`No conid for ${ticker}`);
  return data[0].conid;
}

async function placeIBKROrder(ticker, action, orderType, price, qty = 1) {
  const side = action.includes('COMPRAR') ? 'BUY' : 'SELL';
  const conid = await getConid(ticker);
  const body = {
    orders: [{
      acctId: IBKR_ACCOUNT,
      conid,
      orderType,
      side,
      quantity: qty,
      price: parseFloat(price),
      tif: 'DAY'
    }]
  };
  const { data } = await axios.post(
    `${IBKR_URL}/v1/api/iserver/account/${IBKR_ACCOUNT}/orders`,
    body,
    { timeout: 10000 }
  );
  return data;
}

// ── WHATSAPP ALERT ─────────────────────────────────────────────────────────
function buildMessage(md, analysis) {
  const emoji = analysis.action.includes('COMPRAR') ? '🟢' :
    (analysis.action.includes('VENDER') || analysis.action.includes('SALIR')) ? '🔴' : '🟡';
  return `${emoji} *SEÑAL IBKR — ${md.ticker}*
Acción: *${analysis.action}*
Confianza: ${analysis.confidence}%
Precio: $${md.price} (${md.change >= 0 ? '+' : ''}${md.change}%)
Entry: ${analysis.entry_price ? '$' + analysis.entry_price.toFixed(2) : '—'}
Stop: ${analysis.stop_loss ? '$' + analysis.stop_loss.toFixed(2) : '—'}
Target: ${analysis.target_price ? '$' + analysis.target_price.toFixed(2) : '—'}
R/R: ${analysis.risk_reward ? analysis.risk_reward.toFixed(1) + 'x' : '—'}
RSI: ${md.rsi} | Vol: ${md.volRatio}x
Orden: ${analysis.ibkr_order_type} — ${analysis.ibkr_order_detail}
${analysis.rationale}
— Agente IBKR ${new Date().toLocaleString()}`;
}

async function sendWhatsApp(message) {
  return await twilioClient.messages.create({
    from: TWILIO_FROM,
    to: TWILIO_TO,
    body: message
  });
}

// ── MARKET HOURS CHECK (ET) ───────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hour = et.getHours();
  const min = et.getMinutes();
  const totalMin = hour * 60 + min;
  return totalMin >= 570 && totalMin <= 960; // 9:30am - 4:00pm ET
}

// ── MAIN SCAN ─────────────────────────────────────────────────────────────
async function runScan() {
  if (!isMarketOpen()) {
    console.log(`[${new Date().toISOString()}] Mercado cerrado — scan omitido`);
    return;
  }

  scanCount++;
  const tickers = WATCHLIST.split(',').map(t => t.trim());
  const minConf = parseInt(MIN_CONFIDENCE);
  console.log(`[${new Date().toISOString()}] Scan #${scanCount} iniciado — ${tickers.length} tickers`);

  const results = [];

  for (const ticker of tickers) {
    try {
      const md = await fetchMarketData(ticker);
      const analysis = await analyzeWithClaude(md);
      const shouldAlert = analysis.confidence >= minConf && analysis.action.includes('COMPRAR');

      results.push({ ticker, md, analysis, alerted: shouldAlert });
      console.log(`  ${ticker}: ${analysis.action} ${analysis.confidence}%${shouldAlert ? ' ← ALERTA' : ''}`);

      if (shouldAlert) {
        const msg = buildMessage(md, analysis);
        await sendWhatsApp(msg);
        alertsSent.push({ ticker, action: analysis.action, confidence: analysis.confidence, time: new Date() });
        console.log(`  → WhatsApp enviado para ${ticker}`);

        // Auto-ejecutar en IBKR si está configurado
        if (IBKR_URL && IBKR_ACCOUNT) {
          try {
            const orderResult = await placeIBKROrder(
              ticker,
              analysis.action,
              analysis.ibkr_order_type || 'LMT',
              analysis.entry_price || md.price,
              1
            );
            console.log(`  → Orden IBKR ejecutada:`, orderResult);
            await sendWhatsApp(`✅ Orden ejecutada en IBKR: ${analysis.ibkr_order_type} ${ticker} @ $${analysis.entry_price || md.price}`);
          } catch (e) {
            console.error(`  → Error IBKR para ${ticker}:`, e.message);
          }
        }
      }

      // Pequeña pausa entre tickers
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  Error en ${ticker}:`, e.message);
    }
  }

  lastScanResults = results;
  console.log(`[${new Date().toISOString()}] Scan #${scanCount} completo`);
}

// ── CRON JOB ──────────────────────────────────────────────────────────────
const intervalMin = parseInt(SCAN_INTERVAL_MIN);
// Corre cada N minutos, lunes a viernes
cron.schedule(`*/${intervalMin} * * * 1-5`, () => {
  runScan().catch(e => console.error('Error en scan:', e.message));
});

console.log(`Scanner configurado: cada ${intervalMin} minutos, lunes a viernes, horario de mercado NY`);

// ── API ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Agente IBKR activo',
    scanCount,
    alertsSent: alertsSent.length,
    lastScan: lastScanResults.length ? lastScanResults.map(r => ({
      ticker: r.ticker,
      action: r.analysis.action,
      confidence: r.analysis.confidence,
      price: r.md.price,
      alerted: r.alerted
    })) : 'Sin scans aún',
    marketOpen: isMarketOpen(),
    nextScanInterval: `${intervalMin} minutos`,
    watchlist: WATCHLIST.split(',')
  });
});

app.post('/scan', async (req, res) => {
  res.json({ message: 'Scan iniciado' });
  runScan().catch(e => console.error(e.message));
});

app.get('/alerts', (req, res) => {
  res.json({ total: alertsSent.length, alerts: alertsSent });
});

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Agente IBKR corriendo en puerto ${PORT}`);
  // Scan inicial al arrancar
  setTimeout(() => runScan().catch(e => console.error(e.message)), 3000);
});
