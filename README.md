# Polymarket Copy Trading Bot

Copy trades from any Polymarket wallet. Automatically.

---

## Quick Start

```bash
git clone https://github.com/Alchemist-X/copy-trading-polymarket.git
cd copy-trading-polymarket
npm install
```

Create `.env`:

```env
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
FUNDER_ADDRESS=0xYOUR_POLYMARKET_PROXY_WALLET
SIGNATURE_TYPE=1
```

Follow someone, then start:

```bash
npx tsx src/index.ts add 0xSOME_TRADER_ADDRESS
npx tsx src/index.ts start
```

That's it. You're copy trading.

---

## Controls

The dashboard runs in your terminal. Here's what you can do:

| Key | Action |
|-----|--------|
| `1` | Activity tab -- scrolling trade feed |
| `2` | Monitor tab -- watched addresses |
| `%` | Edit copy percentage |
| `L` | Edit size limits |
| `Space` | Pause / Resume all |
| `q` | Quit |

---

## Dashboard

```
════════════════════════════════════════════════════════════════
 ● RUNNING  USDC: $68.85  Latency: 45ms  Cycle: 42/1200ms
 Addr: 3 active 0 paused  |  Trades: 23 det 18 exec 3 skip 2 fail
════════════════════════════════════════════════════════════════
  1 Activity    2 Monitor

 17:23:01 DETECT [@whaletrader] BUY $100.00  Will Trump win 2028?
 17:23:01 COPY   BUY $50.00 @ 0.42  Will Trump win 2028?
 17:24:15 DETECT [@degen] BUY $20.00 -> SKIP (minTrigger)
 17:25:30 DETECT [@alpha] SELL $500.00  Bitcoin above 200k?
 17:25:31 COPY   SELL $250.00 @ 0.73  Bitcoin above 200k?

════════════════════════════════════════════════════════════════
 [q]Quit  [1]Activity  [2]Monitor  [%]Edit Copy%  [L]Limits  [Space]Pause
```

Real-time features:
- **Latency ping** every 5s (green < 100ms, yellow < 500ms, red > 500ms)
- **USDC balance** from Polygon chain, refreshed every 30s
- **DETECT / COPY / SKIP / FAIL** labels to distinguish source trades from your copies

---

## Commands

| Command | What it does |
|---------|-------------|
| `add <address or username>` | Follow a trader |
| `list` | Show all followed addresses |
| `edit <address>` | Change copy settings |
| `pause <address\|all>` | Pause tracking |
| `resume <address\|all>` | Resume tracking |
| `remove <address>` | Unfollow |
| `start` | Launch the engine + dashboard |
| `start --dry-run` | Simulate without real trades |
| `history` | View past executions |
| `status` | Engine status snapshot |
| `verify <address>` | Check if address is a valid Polymarket trader |
| `import <file>` | Bulk import from CSV or JSON |
| `logs` | View engine logs |

All commands: `npx tsx src/index.ts <command>`

You can use Polymarket **usernames** (e.g. `Hunter-Biden`) anywhere an address is expected. The system resolves them automatically.

---

## Copy Modes

| Mode | How it works | Example |
|------|-------------|---------|
| **Percentage** | Copy X% of their trade | They bet $1000, you copy $100 (10%) |
| **Fixed** | Always bet the same amount | They bet anything, you copy $25 |
| **Range** | Percentage with min/max bounds | 10% clamped to $5-$100 |
| **Counter** | Any mode above, but reversed | They BUY, you SELL |

---

## Filters

Set during `add` or `edit`:

| Filter | Purpose | Example |
|--------|---------|---------|
| `minTrigger` | Skip small test bets | `10` = ignore < $10 |
| `maxOdds` | Skip expensive contracts | `0.85` = ignore > 85c |
| `maxPerMarket` | Cap exposure per market | `200` = max $200/market |
| `maxDaysOut` | Skip far-out markets | `30` = within 30 days |

**Sell strategies**: `same_pct` (mirror), `fixed`, `custom_pct`, or `ignore` (never follow sells).

---

## How It Works

```
Poll Activity API (per address, incremental)
  → Detect new trade (dedup by tx hash, in-memory + file)
  → Apply filters (minTrigger, maxOdds, etc.)
  → Calculate copy amount (percentage/fixed/range)
  → Check slippage (default max 5%)
  → Execute FOK market order via CLOB API
  → Record result to history
```

- Monitors up to **1000 addresses** concurrently via `p-limit`
- Priority tiers: **fast** (10s), **normal** (30s), **slow** (60s)
- Every failure gets a structured `FailureCode` (18 types across 5 stages) for precise debugging

---

## Configuration

### `.env` variables

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Your wallet private key |
| `FUNDER_ADDRESS` | Polymarket proxy wallet (Settings > Proxy Wallet on polymarket.com) |
| `SIGNATURE_TYPE` | `0` = EOA, `1` = proxy (typical), `2` = Gnosis Safe |

### `start` options

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | off | Log trades without executing |
| `--concurrency <n>` | 15 | Parallel API requests |
| `--verbose` | off | Detailed logging |
| `--no-dashboard` | off | Log-only mode, no TUI |

---

## Testing

This repo uses a three-layer workflow:

1. Fast local checks on every change
2. Module regression checks for risky logic
3. Release-gated live E2E with small real funds

Fast checks:

```bash
npm run typecheck
npm run smoke:commands
npm run smoke:logs
```

If you changed runtime behavior, also run:

```bash
npx tsx src/index.ts start --dry-run --no-dashboard
```

Testing docs:

- `docs/testing-workflow.md` - full workflow and release gate
- `docs/test-runs/latest.md` - latest rolling test result
- `docs/test-runs/report-template.md` - per-change delivery template
- `docs/ui-mockups.md` - dashboard state baseline

UI rule:

- Every terminal/dashboard change should ship with screenshots
- Use state IDs `A` through `H` from `docs/ui-mockups.md`
- Attach the screenshots in a markdown test report

---

## Data Files

Stored in `data/` (gitignored):

| File | Contents |
|------|----------|
| `addresses.json` | Followed addresses + config |
| `state.json` | Poll cursors, seen tx hashes |
| `history.json` | Execution history (max 10k) |

Logs in `logs/`:

| File | Contents |
|------|----------|
| `engine-YYYY-MM-DD.log` | Daily engine log (JSONL, 30-day retention) |
| `commands.log` | CLI command history |
| `errors.log` | Errors only |

---

## Project Structure

```
src/
├── index.ts                 # Entry point + CLI registration
├── cli/
│   ├── dashboard.ts         # ANSI dashboard with tabs + keyboard controls
│   └── commands.ts          # CLI command handlers
├── core/
│   ├── monitor.ts           # Trade monitor (concurrent polling, dedup, events)
│   ├── executor.ts          # Order execution (FOK, slippage, retry)
│   ├── copy-logic.ts        # Copy amount calculation (4 modes)
│   └── filters.ts           # Trade filter chain
├── lib/
│   ├── client.ts            # CLOB client init
│   ├── polymarket-api.ts    # Activity/Gamma/Price APIs + USDC balance + latency
│   ├── store.ts             # JSON persistence
│   └── logger.ts            # Console + file logging
└── types/
    └── index.ts             # TypeScript types
```

## Tech Stack

`@polymarket/clob-client` / `ethers` / `commander` / `chalk` / `p-limit` / `dotenv`

## License

MIT
