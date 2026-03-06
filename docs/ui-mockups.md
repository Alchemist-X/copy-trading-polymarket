# Dashboard UI Mockups

Every dashboard state rendered as plain text for quick human review.
Update this file whenever the dashboard layout changes.

---

## A. Initializing (engine not yet started)

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                          Cycle #0 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● STOPPED    USDC: —    Latency: —                                ║
║  Addresses: 0 active / 0 paused                                    ║
║  Trades: 0 detected  0 executed  0 skipped  0 failed               ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║                                                                     ║
║  Waiting for trades...                                              ║
║                                                                     ║
║                                                                     ║
║                                                                     ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Pause                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## B. Running / Activity idle (showing recent history)

When no new events have been detected since startup, the activity tab
fills with historical trades from `data/history.json`.

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                          Cycle #5 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● RUNNING    USDC: $68.85    Latency: 674ms                       ║
║  Addresses: 1 active / 0 paused                                    ║
║  Trades: 0 detected  0 executed  0 skipped  0 failed               ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║                                                                     ║
║  Recent trades from tracked addresses:                              ║
║                                                                     ║
║  ✓ Hustle (0x5334...a8D6)  BUY $6.00  Will JD Vance win...   50%  ║
║  ✓ Hustle (0x5334...a8D6)  BUY $6.00  Will JD Vance win...   50%  ║
║  ○ Hustle (0x5334...a8D6)  BUY $3.00  Will Gavin Newsom...   50%  ║
║  ○ Hustle (0x5334...a8D6)  BUY $5.00  Will the Government... 50%  ║
║  ○ Hustle (0x5334...a8D6)  BUY $3.17  Will Gemini 3.0 be...  50%  ║
║  ○ Hustle (0x5334...a8D6)  BUY $4.40  Will Gemini 3.0 be...  50%  ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Pause                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## C. Running / Activity with live events

As new trades are detected and copied, the activity feed scrolls.

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                         Cycle #42 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● RUNNING    USDC: $62.85    Latency: 45ms                        ║
║  Addresses: 3 active / 0 paused                                    ║
║  Trades: 5 detected  3 executed  1 skipped  1 failed               ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║                                                                     ║
║  17:23:01 DETECT Hustle (0x5334...a8D6) BUY $100.00  Will Trump... ║
║  17:23:02 COPY   BUY $50.00 @ 0.42  Will Trump win 2028?           ║
║  17:24:15 DETECT Alpha (0xa1b2...c3d4) BUY $20.00  Bitcoin above.. ║
║  17:24:15 SKIP   Alpha (0xa1b2...c3d4) BUY $20.00 → minTrigger    ║
║  17:25:30 DETECT Whale (0xdead...beef) SELL $500.00  Bitcoin abo.. ║
║  17:25:31 COPY   SELL $250.00 @ 0.73  Bitcoin above 200k?          ║
║  17:26:10 DETECT Hustle (0x5334...a8D6) BUY $10.00  Meta relea..  ║
║  17:26:11 FAIL   Hustle (0x5334...a8D6) BUY $10.00 → FOK not fil  ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Pause                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

Event types:
- `DETECT` (cyan) -- source trade detected from tracked address
- `COPY` (green bold) -- our copy trade executed successfully
- `SKIP` (yellow) -- filtered or too small, with reason
- `FAIL` (red) -- execution error, with reason

---

## D. Monitor Tab (address list)

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                         Cycle #42 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● RUNNING    USDC: $62.85    Latency: 45ms                        ║
║  Addresses: 3 active / 1 paused                                    ║
║  Trades: 23 detected  18 executed  3 skipped  2 failed             ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║  #   Address                      Status   Copy   Mode        Last ║
║  ────────────────────────────────────────────────────────────────── ║
║  1   Hustle (0x5334...a8D6)       active   50%    percentage  2m   ║
║  2   Alpha (0xa1b2...c3d4)        active   30%    percentage  15m  ║
║  3   0xdead...beef                active   $25    fixed       1h   ║
║  4   Degen (0x9876...5432)        paused   10%    percentage  3h   ║
║                                                                     ║
║                                                                     ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Pause                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## E. Edit mode (inline prompt in footer)

### E1. Editing copy percentage

```
╠══════════════════════════════════════════════════════════════════════╣
║  Copy % for Hustle (0x5334...a8D6) (now 50%): 30█                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

### E2. Editing min trigger

```
╠══════════════════════════════════════════════════════════════════════╣
║  Min trigger $ for Hustle (0x5334...a8D6) (now 0): 10█             ║
╚══════════════════════════════════════════════════════════════════════╝
```

### E3. Editing max per market (follows min trigger)

```
╠══════════════════════════════════════════════════════════════════════╣
║  Max/market $ for Hustle (0x5334...a8D6) (now none): 200█          ║
╚══════════════════════════════════════════════════════════════════════╝
```

### E4. Address selection (when multiple addresses)

```
╠══════════════════════════════════════════════════════════════════════╣
║  Select address # (1-4): 2█                                        ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## F. All paused

When Space is pressed and all addresses are paused:

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                         Cycle #42 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● RUNNING    USDC: $62.85    Latency: 45ms                        ║
║  Addresses: 0 active / 4 paused                                    ║
║  Trades: 23 detected  18 executed  3 skipped  2 failed             ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║                                                                     ║
║  17:30:00 PAUSED all addresses                                      ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Resume                 ║
╚══════════════════════════════════════════════════════════════════════╝
```

Note: footer shows `[Space]Resume` instead of `[Space]Pause`.

---

## G. Dry Run mode

When started with `--dry-run`, trades are detected but not executed.
The header title changes to include DRY RUN indicator.
Events appear as SKIP with reason "dry run".

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                          Cycle #5 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● RUNNING    USDC: $68.85    Latency: 674ms                       ║
║  Addresses: 1 active / 0 paused                                    ║
║  Trades: 3 detected  0 executed  3 skipped  0 failed               ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║                                                                     ║
║  17:23:01 DETECT Hustle (0x5334...a8D6) BUY $100.00  Will Trump.. ║
║  17:23:02 SKIP   BUY $50.00  Will Trump win 2028? → dry run        ║
║  17:24:15 DETECT Alpha (0xa1b2...c3d4) BUY $20.00  Bitcoin abo..  ║
║  17:24:15 SKIP   BUY $10.00  Bitcoin above 200k? → dry run         ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Pause                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## H. Auto-Redeem events

When a resolved market is detected and tokens are redeemed, a REDEEM
event appears in the activity feed. Auto-redeem runs every 60s by default.

```
╔══════════════════════════════════════════════════════════════════════╗
║  Polymarket Copy Trading Monitor                        Cycle #120 ║
╠══════════════════════════════════════════════════════════════════════╣
║  ● RUNNING    USDC: $162.85    Latency: 45ms                       ║
║  Addresses: 3 active / 0 paused                                    ║
║  Trades: 15 detected  12 executed  2 skipped  1 failed             ║
╠══ 1 Activity ══ 2 Monitor ══════════════════════════════════════════╣
║                                                                     ║
║  17:23:01 DETECT Hustle (0x5334...a8D6) BUY $100.00  Will Trump.. ║
║  17:23:02 COPY   BUY $50.00 @ 0.42  Will Trump win 2028?           ║
║  17:30:00 REDEEM Will Trump win 2028?  tx:0xa3f2b1..              ║
║  17:31:00 REDEEM Bitcoin above 200k by 2027?  tx:0x8c1d..         ║
║                                                                     ║
╠══════════════════════════════════════════════════════════════════════╣
║  [q]Quit [1/2]Tab [%]Copy% [L]Limits [Space]Pause                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

REDEEM events are shown in green bold. The display format is:
`HH:MM:SS REDEEM <market question (truncated)>  tx:<hash prefix>..`

Disable with `--no-auto-redeem` flag.
