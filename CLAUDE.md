# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

A single-process Node.js trading-signal agent. It periodically scans a stock
watchlist, computes technical indicators, asks Claude for a trade decision, and
when the decision is a high-confidence BUY it sends a WhatsApp alert (via Twilio)
and — optionally — places a live order through the Interactive Brokers (IBKR)
Client Portal Gateway. It is built to be deployed on Railway as a long-running
web service.

User-facing documentation (`README.md`) is written in **Spanish**, and so are the
Claude prompt, the WhatsApp message body, and most log lines. Keep that
convention when editing user-visible strings.

## Layout

The entire application is three files at the repo root — there is no `src/`,
build step, test suite, or framework scaffolding.

| File | Purpose |
|------|---------|
| `server.js` | The whole app: Express server, cron scheduler, market-data fetch, indicator math, Claude analysis, Twilio alerts, IBKR order placement. |
| `package.json` | Dependencies and npm scripts (`start`, `dev`). |
| `README.md` | Spanish deploy guide for Railway + env-var reference. |

> Note: `README.md` references a `.env.example` file, but it is **not present** in
> the repo. Configuration is done entirely through environment variables (see
> below). If you add local-dev tooling, creating `.env.example` would be a
> reasonable improvement.

## Running

```bash
npm install
npm start        # node server.js
npm run dev      # nodemon server.js (requires nodemon, not in deps)
```

Requires **Node >= 18** (declared in `package.json` `engines`). The server binds
to `process.env.PORT` (default `3000`). On startup it runs one scan after a 3s
delay, then relies on the cron schedule.

There are **no tests, no linter, and no CI config** in the repo. "Verifying"
a change means running `node server.js` locally with env vars set and hitting
the HTTP endpoints, or deploying to Railway and watching logs.

## Configuration (environment variables)

All config comes from `process.env`, read once at the top of `server.js`.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ANTHROPIC_API_KEY` | yes | — | Claude API key. |
| `TWILIO_SID` | yes | — | Twilio account SID. |
| `TWILIO_TOKEN` | yes | — | Twilio auth token. |
| `TWILIO_FROM` | yes | — | WhatsApp sender, e.g. `whatsapp:+14155238886`. |
| `TWILIO_TO` | yes | — | WhatsApp recipient. |
| `MIN_CONFIDENCE` | no | `90` | Min Claude confidence (%) to trigger an alert. |
| `SCAN_INTERVAL_MIN` | no | `30` | Cron interval in minutes. |
| `WATCHLIST` | no | `SPY,QQQ,NVDA,AAPL,MSFT,AMZN,META,TSLA,GOOGL,AMD,JPM,GLD` | Comma-separated tickers. |
| `IBKR_URL` | no | — | IBKR Client Portal Gateway base URL. If set with `IBKR_ACCOUNT`, live orders are placed. |
| `IBKR_ACCOUNT` | no | — | IBKR account id. |
| `PORT` | no | `3000` | Set automatically by Railway. |

Live IBKR trading is **off unless both `IBKR_URL` and `IBKR_ACCOUNT` are set**.
Treat any change touching `placeIBKROrder` as high-risk — it can submit real money
orders.

## How it works (control flow in `server.js`)

1. **Schedule** — `cron.schedule('*/<SCAN_INTERVAL_MIN> * * * 1-5', runScan)`
   runs Mon–Fri. `runScan()` additionally gates on `isMarketOpen()` (NY time,
   09:30–16:00, weekdays). The forced path (`runScanForced` → `runScanInternal(true)`)
   skips the market-open check.
2. **Per ticker** in `runScanInternal`:
   - `fetchMarketData(ticker)` — pulls 3 months of daily candles from the public
     Yahoo Finance chart endpoint (`query1.finance.yahoo.com`) and computes price,
     % change, SMA20/SMA50, RSI(14), a MACD-histogram approximation, volume ratio,
     and 52-week high/low stats.
   - `analyzeWithClaude(md)` — sends the indicators to Claude
     (`claude-sonnet-4-20250514`), with a Spanish system prompt demanding a strict
     JSON response; the reply is stripped of code fences and `JSON.parse`d.
   - If `confidence >= MIN_CONFIDENCE` **and** the action contains `COMPRAR`
     (BUY), it sends a WhatsApp via `sendWhatsApp(buildMessage(...))`, records it
     in `alertsSent`, and (if IBKR is configured) places an order.
   - Sleeps 1s between tickers to be gentle on the data source.
3. **State** is kept in module-level variables only: `scanCount`, `alertsSent`,
   `lastScanResults`. There is **no database** — all state is lost on restart.

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Status JSON: scan count, alert count, last scan summary, market-open flag, watchlist. |
| POST | `/scan` | Trigger a normal scan (still respects market-open gate). Returns immediately. |
| GET | `/scan/force` | Trigger a scan ignoring the market-open gate. |
| GET | `/alerts` | All alerts sent this process lifetime. |

Note the README mentions a `GET /scan`, but the code defines `POST /scan` and
`GET /scan/force`. If you touch routing, reconcile the README with the code.

## Conventions & gotchas

- **Language**: user-visible text (prompts, WhatsApp body, logs, README) is
  Spanish. Code identifiers are English. Keep both.
- **Single file**: prefer keeping logic in `server.js` unless a change is large
  enough to justify splitting; there is no module structure to follow yet.
- **No secret committing**: all credentials come from env vars. Never hardcode
  keys, tokens, account ids, or phone numbers. The README contains an example
  partial Twilio SID — do not treat sample values as real config.
- **Indicators are approximations**: `macdHist` is a rough heuristic, RSI uses a
  simple (not Wilder-smoothed) average, and SMA50 falls back to available length.
  Don't assume textbook-exact values.
- **External dependencies that can fail**: Yahoo Finance (unauthenticated, can
  rate-limit or change shape), Anthropic, Twilio, and IBKR. Per-ticker errors are
  caught and logged so one failure doesn't abort the whole scan — preserve that
  resilience.
- **Model id**: the Claude model is pinned to `claude-sonnet-4-20250514` in
  `analyzeWithClaude`. If asked to upgrade the model, change it there.

## Deployment

Designed for **Railway** (see `README.md`): connect the GitHub repo, set the env
vars in the Railway dashboard, and Railway auto-detects Node and runs
`npm start`. Optional IBKR auto-execution requires separately running the IBKR
Client Portal Gateway (manual auth every ~24h).

## Git workflow

- Active development branch for current work: `claude/claude-md-docs-vlrqtt`.
- Default branch: `main`.
- Push with `git push -u origin <branch>` and open a PR (draft) for review;
  do not push directly to `main`.
