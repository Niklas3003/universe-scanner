// ============================================================
// Universe Scanner
// Runs every Sunday night, scores all tradeable US stocks,
// and publishes the top 150 to universe.json in this repo.
// Bots read their universe from that file via GitHub raw URL.
// ============================================================

const ALPACA_KEY    = process.env.ALPACA_KEY    || "PKXJ72FSRA7CZLC3HOQTV5F3MH";
const ALPACA_SECRET = process.env.ALPACA_SECRET || "Cq6cNHq2bPJgD7EPxk9QZVSd2k3P8SWosaiwjMcfYSKj";
const ALPACA_BASE   = "https://paper-api.alpaca.markets/v2";
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || "Niklas3003/universe-scanner";

// ============================================================
// SCORING PARAMETERS
// ============================================================

const TARGET_SIZE        = 150;  // how many stocks to keep
const MIN_PRICE          = 5;    // ignore penny stocks below $5
const MAX_PRICE          = 5000; // ignore extremely expensive stocks
const MIN_AVG_VOLUME     = 500000; // minimum avg daily volume (liquidity filter)
const MOMENTUM_DAYS      = 20;   // momentum lookback
const VOLUME_DAYS        = 20;   // volume trend lookback
const HISTORY_DAYS       = 60;   // total history needed

// Scoring weights — must sum to 100
const W_MOMENTUM         = 35;   // 20-day price momentum vs S&P 500
const W_VOLUME_GROWTH    = 25;   // is volume increasing (rising interest)
const W_RELATIVE_STRENGTH= 25;   // outperforming S&P 500 over 20 days
const W_VOLATILITY       = 15;   // moderate volatility preferred (not too flat, not too wild)

// ============================================================
// ALPACA — get all tradeable US stocks
// ============================================================

async function getAllTradeableSymbols() {
  console.log("Fetching all tradeable US assets from Alpaca...");
  let symbols = [];
  let pageToken = null;

  do {
    const url = `${ALPACA_BASE}/assets?status=active&asset_class=us_equity${pageToken ? `&page_token=${pageToken}` : ""}`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID":     ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      },
    });
    if (!res.ok) throw new Error(`Alpaca assets: ${res.status}`);
    const assets = await res.json();
    if (!assets.length) break;

    // Filter: tradeable, fractionable, not OTC (OTC stocks have poor data)
    const valid = assets.filter(a =>
      a.tradable &&
      a.fractionable &&
      a.exchange !== "OTC" &&
      a.status === "active" &&
      /^[A-Z]{1,5}$/.test(a.symbol) // clean ticker only, no dots or slashes
    );

    symbols = symbols.concat(valid.map(a => a.symbol));
    pageToken = assets.length === 1000 ? assets[assets.length - 1].id : null;
  } while (pageToken);

  console.log(`  Found ${symbols.length} tradeable symbols`);
  return symbols;
}

// ============================================================
// YAHOO FINANCE — price + volume history
// ============================================================

async function getPriceHistory(symbol, days = HISTORY_DAYS + 10) {
  try {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                 `?period1=${from}&period2=${to}&interval=1d`;
    const res  = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const candles = result.timestamp.map((ts, i) => ({
      ts, close: q.close[i], volume: q.volume[i], high: q.high[i], low: q.low[i],
    })).filter(c => c.close != null && c.volume != null && c.close > 0);
    return candles.length >= MOMENTUM_DAYS ? candles : null;
  } catch { return null; }
}

// ============================================================
// SCORING FUNCTIONS
// ============================================================

function scoreMomentum(candles) {
  // % price change over last MOMENTUM_DAYS days
  const recent = candles.slice(-MOMENTUM_DAYS);
  const start  = recent[0].close;
  const end    = recent[recent.length - 1].close;
  return ((end - start) / start) * 100; // raw % return
}

function scoreVolumeGrowth(candles) {
  // Compare avg volume of last 10 days vs prior 10 days
  const recent = candles.slice(-10);
  const prior  = candles.slice(-20, -10);
  if (!prior.length) return 0;
  const recentAvg = recent.reduce((a, b) => a + b.volume, 0) / recent.length;
  const priorAvg  = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  return priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;
}

function scoreRelativeStrength(candles, spyCandles) {
  // Stock return vs SPY return over MOMENTUM_DAYS
  if (!spyCandles) return 0;
  const stockReturn = scoreMomentum(candles);
  const spyReturn   = scoreMomentum(spyCandles);
  return stockReturn - spyReturn; // positive = outperforming S&P 500
}

function scoreVolatility(candles) {
  // We want moderate volatility — not too flat (no opportunity), not too wild (too risky)
  // Use avg daily range as % of close
  const recent = candles.slice(-MOMENTUM_DAYS);
  const avgRange = recent.reduce((a, b) => a + (b.high - b.low) / b.close, 0) / recent.length * 100;
  // Ideal range: 1-3% daily move. Score peaks at 2%, drops off either side.
  const ideal = 2.0;
  return Math.max(0, 10 - Math.abs(avgRange - ideal) * 3);
}

function avgVolume(candles) {
  const recent = candles.slice(-VOLUME_DAYS);
  return recent.reduce((a, b) => a + b.volume, 0) / recent.length;
}

// Normalize an array of values to 0-100 scale
function normalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 50);
  return values.map(v => ((v - min) / range) * 100);
}

// ============================================================
// MAIN SCANNING LOGIC
// ============================================================

async function scanUniverse() {
  // 1. Get all symbols
  const allSymbols = await getAllTradeableSymbols();

  // 2. Get SPY as benchmark
  console.log("\nFetching SPY benchmark data...");
  const spyCandles = await getPriceHistory("SPY");

  // 3. Score each symbol
  // Process in batches to avoid overwhelming Yahoo Finance
  const BATCH_SIZE = 50;
  const scored     = [];
  let   processed  = 0;

  console.log(`\nScoring ${allSymbols.length} symbols in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async symbol => {
        const candles = await getPriceHistory(symbol);
        if (!candles) return null;

        const currentPrice = candles[candles.length - 1].close;
        const avgVol       = avgVolume(candles);

        // Apply filters
        if (currentPrice < MIN_PRICE)    return null;
        if (currentPrice > MAX_PRICE)    return null;
        if (avgVol < MIN_AVG_VOLUME)     return null;

        // Raw scores
        const rawMomentum = scoreMomentum(candles);
        const rawVolGrowth = scoreVolumeGrowth(candles);
        const rawRelStr    = scoreRelativeStrength(candles, spyCandles);
        const rawVol       = scoreVolatility(candles);

        return {
          symbol,
          currentPrice,
          avgVolume: avgVol,
          rawMomentum,
          rawVolGrowth,
          rawRelStr,
          rawVol,
        };
      })
    );

    const valid = batchResults
      .filter(r => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    scored.push(...valid);
    processed += batch.length;

    if (processed % 200 === 0 || processed >= allSymbols.length) {
      console.log(`  Progress: ${processed}/${allSymbols.length} scanned | ${scored.length} passed filters`);
    }

    // Gentle rate limiting between batches
    await sleep(1000);
  }

  console.log(`\nScored ${scored.length} symbols that passed all filters`);

  // 4. Normalize scores to 0-100 and compute composite score
  if (scored.length === 0) throw new Error("No symbols scored — check data sources");

  const normMomentum = normalize(scored.map(s => s.rawMomentum));
  const normVolGrowth= normalize(scored.map(s => s.rawVolGrowth));
  const normRelStr   = normalize(scored.map(s => s.rawRelStr));
  const normVol      = scored.map(s => s.rawVol); // already 0-10, scale to 0-100
  const normVolScaled= normalize(normVol);

  const finalScored = scored.map((s, i) => ({
    ...s,
    score: (
      normMomentum[i] * (W_MOMENTUM / 100) +
      normVolGrowth[i] * (W_VOLUME_GROWTH / 100) +
      normRelStr[i]   * (W_RELATIVE_STRENGTH / 100) +
      normVolScaled[i] * (W_VOLATILITY / 100)
    ),
  }));

  // 5. Sort and take top N
  finalScored.sort((a, b) => b.score - a.score);
  const top = finalScored.slice(0, TARGET_SIZE);

  console.log("\nTop 20 stocks:");
  top.slice(0, 20).forEach((s, i) => {
    console.log(`  ${String(i+1).padStart(2)}. ${s.symbol.padEnd(6)} score: ${s.score.toFixed(1)} | mom: ${s.rawMomentum.toFixed(1)}% | vol growth: ${s.rawVolGrowth.toFixed(1)}% | rel str: ${s.rawRelStr.toFixed(1)}%`);
  });

  return top;
}

// ============================================================
// PUBLISH TO GITHUB
// Commits universe.json to the repo so bots can fetch it
// ============================================================

async function publishToGitHub(stocks) {
  if (!GITHUB_TOKEN) {
    console.log("\nNo GITHUB_TOKEN — writing universe.json locally only");
    const fs = await import("fs");
    fs.writeFileSync("universe.json", JSON.stringify(buildOutput(stocks), null, 2));
    return;
  }

  const output  = buildOutput(stocks);
  const content = Buffer.from(JSON.stringify(output, null, 2)).toString("base64");
  const path    = "universe.json";
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

  // Get current file SHA (needed to update existing file)
  let sha = null;
  try {
    const existing = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "User-Agent":  "universe-scanner",
      },
    });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }
  } catch { /* file doesn't exist yet, that's fine */ }

  // Commit the file
  const body = {
    message: `Universe update — ${new Date().toISOString().split("T")[0]} — top ${TARGET_SIZE} stocks`,
    content,
    ...(sha ? { sha } : {}),
  };

  const res = await fetch(apiUrl, {
    method:  "PUT",
    headers: {
      Authorization:  `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent":   "universe-scanner",
    },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    console.log(`\n✓ universe.json committed to ${GITHUB_REPO}`);
    console.log(`  URL: https://raw.githubusercontent.com/${GITHUB_REPO}/main/universe.json`);
  } else {
    const err = await res.text();
    throw new Error(`GitHub commit failed: ${err}`);
  }
}

function buildOutput(stocks) {
  return {
    generated:  new Date().toISOString(),
    count:      stocks.length,
    criteria: {
      momentum_weight:          W_MOMENTUM,
      volume_growth_weight:     W_VOLUME_GROWTH,
      relative_strength_weight: W_RELATIVE_STRENGTH,
      volatility_weight:        W_VOLATILITY,
      min_price:                MIN_PRICE,
      min_avg_volume:           MIN_AVG_VOLUME,
    },
    symbols: stocks.map(s => s.symbol),
    details: stocks.map(s => ({
      symbol:       s.symbol,
      score:        parseFloat(s.score.toFixed(2)),
      price:        parseFloat(s.currentPrice.toFixed(2)),
      momentum_pct: parseFloat(s.rawMomentum.toFixed(2)),
      vol_growth_pct: parseFloat(s.rawVolGrowth.toFixed(2)),
      rel_strength_pct: parseFloat(s.rawRelStr.toFixed(2)),
      avg_volume:   Math.round(s.avgVolume),
    })),
  };
}

// ============================================================
// UTILS
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Universe Scanner");
  console.log("Started:", new Date().toISOString());
  console.log("=".repeat(60));

  const stocks = await scanUniverse();
  await publishToGitHub(stocks);

  console.log("\n" + "=".repeat(60));
  console.log(`Done. ${stocks.length} stocks selected for next week.`);
  console.log("=".repeat(60));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
