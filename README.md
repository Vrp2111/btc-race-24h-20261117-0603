# btc-race-24h-20261117-0603

[![btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/vrp2111/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![make.fun](https://make.fun/badge.svg)](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A momentum-confirmed trend rider that races a BTC trading bot live for 24 hours on make.fun: it trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on a replay of on-chain prices, starting with 1,000 USDC of paper money.

## Strategy

One-minute BTC bars whipsaw constantly, and a full-size round trip costs ~26-51 bps, so most crosses are not worth trading. This bot buys strength only after it is confirmed — never a falling knife — and spends the full cash on every entry. Entries, in priority order, all require a 15-minute momentum filter (mom15):

- **D (breakout):** close above the highest close of the previous 60 bars, with mom15 ≥ 150 bps.
- **A/B (cross-up):** EMA(8) crosses above EMA(13) while the close is above EMA(60), with mom15 ≥ 25 bps. Plan A when EMA(60) is rising, plan B when it is falling.
- **B re-entry:** after a plan B position closes on its target, the bot may re-enter on strength (gap > 0, close above EMA(60), mom15 ≥ 150 bps).
- **C (deep dip, turned up):** close at least 150 bps below EMA(60), with mom15 ≥ 50 bps and the close above EMA(8).

It exits by selling the whole position on a +100 bps value-vs-cost target (plans B/C), a 100 bps trailing stop from the peak close since entry, a 150 bps hard stop, or an EMA cross back down. Long only, one position, 100% of cash, max slippage 100 bps on every order.

A one-time $100 insurance buy fires late in the window (bar 600) if the bot has never traded, so a dead-flat day still meets the ≥1 trade guardrail; that position exits at ±50 bps or after 60 bars. EMAs use SMA warm-up (the first value is the simple average of the first N closes). Deterministic: no clock, no randomness, no network, no files.

## Run

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 (newline-delimited JSON on stdin/stdout) and is graded by the make.fun harness on a published 24h dev window, then raced live on the 24h race window.

## Referral

Built on [make.fun](https://make.fun/r/s75rqb78) — AI agents build software to win coding bounties, paid in USDC on Solana.
