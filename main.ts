// BTC race #2 — trend-rider momentum bot (btc-race-24h-20261117-0603).
//
// Idea: buy strength only after it is confirmed, never a falling knife.
// Entry is an EMA8/EMA13 cross-up above EMA60 with a 15-minute momentum
// filter, or a 60-bar breakout, or a deep dip that has already turned up.
// Every entry spends the full cash; every exit sells the whole position.
// A one-time $100 insurance buy fires late in the window if the bot has
// never traded, so a dead-flat day still meets the >=1 trade guardrail.
//
// All numbers are the measured design (see BUILD-REPORT.md): mom_x 25 bps,
// target +100 bps (plans B/C), trailing stop 100 bps, hard stop -150 bps.
// Deterministic: no clock, no randomness, no network, no files.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// Entry filters (basis points).
const MOM_CROSS_BPS = 25; // 15-min momentum needed at a cross-up
const MOM_BREAKOUT_BPS = 150; // 15-min momentum needed at a breakout
const MOM_REENTRY_BPS = 150; // 15-min momentum needed for a B re-entry
const MOM_DIP_BPS = 50; // 15-min momentum needed for a deep-dip buy
const DIP_DIST_BPS = -150; // how far below EMA60 a dip must be

// Exits (basis points).
const TARGET_BPS = 100; // value-vs-cost target, plans B/C only
const TRAIL_BPS = 100; // trailing stop from the peak close since entry
const STOP_BPS = 150; // hard stop, value-vs-cost

// One-time insurance trade (only if zero fills by bar 1200).
const INS_ARM_BAR = 1200;
const INS_NOTIONAL_UNITS = 100_000_000n; // $100 of USDC
const INS_TARGET_BPS = 50;
const INS_STOP_BPS = 50;
const INS_MAX_HOLD_BARS = 60;

// Prices arrive at price_scale 5 (integer USDC x 1e5); work in dollars.
const PRICE_SCALE = 1e5;

/** An EMA whose first value is the simple average of its first N closes. */
class Ema {
  readonly span: number;
  readonly alpha: number;
  #warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
    this.alpha = 2 / (span + 1);
  }

  update(close: number): number | null {
    if (this.value !== null) {
      this.value += this.alpha * (close - this.value);
      return this.value;
    }
    this.#warm.push(close);
    if (this.#warm.length === this.span) {
      let sum = 0;
      for (const c of this.#warm) sum += c;
      this.value = sum / this.span;
    }
    return this.value;
  }
}

const closes: number[] = [];
const ema60Hist: number[] = [];
const ema8 = new Ema(8);
const ema13 = new Ema(13);
const ema60 = new Ema(60);

let prevGap: number | null = null;
let plan: string | null = null; // 'A' | 'B' | 'C' | 'D' | 'INS' while holding
let peakClose = 0; // highest close since entry
let holdBars = 0; // bars held in the current position
let reentry = false; // plan B hit its target: it may re-enter on strength
let exitWasTarget = false; // the sell now in flight was decided by a B target hit
let scoredBars = 0; // non-warmup bars with a CBBTC bar
let fills = 0; // filled orders seen so far
let insuranceDone = false;

function mom15(): number | null {
  if (closes.length < 16) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 16]!;
  return ((now / then) - 1) * 10000;
}

function slope60(): number | null {
  if (ema60Hist.length < 61) return null;
  const now = ema60Hist[ema60Hist.length - 1]!;
  const then = ema60Hist[ema60Hist.length - 61]!;
  return ((now / then) - 1) * 10000;
}

function breakout(close: number): boolean {
  if (closes.length < 61) return false;
  let top = -Infinity;
  for (let i = closes.length - 61; i < closes.length - 1; i++) {
    if (closes[i]! > top) top = closes[i]!;
  }
  return close > top;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const f of batch.fills) {
      if (f.status === 'filled') fills++;
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    const close = Number(bar.c) / PRICE_SCALE;
    closes.push(close);
    const e8 = ema8.update(close);
    const e13 = ema13.update(close);
    const e60 = ema60.update(close);
    if (e60 !== null) ema60Hist.push(e60);
    const gap = e8 !== null && e13 !== null ? e8 - e13 : null;

    // Warm-up bars only build history; no order decided on one may fill.
    if (state.warmingUp) {
      if (gap !== null) prevGap = gap;
      return [];
    }
    scoredBars++;

    const pos = state.positions.get(SYMBOL);
    const qty = pos === undefined ? 0n : pos.qty;

    if (qty > 0n) {
      // Holding: check the exits.
      if (close > peakClose) peakClose = close;
      holdBars++;
      const cost = Number(pos!.cost) / 1e6; // USDC
      const val = Number(state.value(SYMBOL, qty)) / 1e6; // USDC at latest close
      const targetBps = plan === 'INS' ? INS_TARGET_BPS : TARGET_BPS;
      const stopBps = plan === 'INS' ? INS_STOP_BPS : STOP_BPS;
      const targetHit =
        (plan === 'B' || plan === 'C' || plan === 'INS') &&
        val >= cost * (1 + targetBps / 10000);
      const trailHit = close <= peakClose * (1 - TRAIL_BPS / 10000);
      const stopHit = val <= cost * (1 - stopBps / 10000);
      const crossDown = prevGap !== null && gap !== null && gap < 0 && prevGap >= 0;
      const maxHoldHit = plan === 'INS' && holdBars >= INS_MAX_HOLD_BARS;
      if (targetHit || trailHit || stopHit || crossDown || maxHoldHit) {
        // Keep the plan until the fill lands (qty drops to 0); a rejected
        // sell must be retried. Remember whether this sell was a B target
        // hit, but only arm the re-entry once the position is really flat:
        // a rejected target sell that later exits on the trailing stop is
        // not a target exit and must not chain a re-entry.
        exitWasTarget = plan === 'B' && targetHit;
        if (gap !== null) prevGap = gap;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (gap !== null) prevGap = gap;
      return [];
    }

    // Flat. A position that just closed clears its plan here and arms the
    // B re-entry only if the sell that closed it was a target hit.
    if (plan !== null) {
      reentry = exitWasTarget;
      exitWasTarget = false;
      plan = null;
      peakClose = 0;
      holdBars = 0;
    }

    // Insurance: one small buy late in the window if nothing ever traded.
    if (!insuranceDone && fills === 0 && scoredBars >= INS_ARM_BAR) {
      insuranceDone = true;
      plan = 'INS';
      peakClose = close;
      holdBars = 0;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: INS_NOTIONAL_UNITS, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Momentum entries, in priority order: breakout, cross-up, B re-entry, dip.
    const m15 = mom15();
    const s60 = slope60();
    const dist60 = e60 !== null ? ((close / e60) - 1) * 10000 : null;
    let next: string | null = null;
    if (m15 !== null && m15 >= MOM_BREAKOUT_BPS && breakout(close)) {
      next = 'D';
    } else if (
      prevGap !== null && gap !== null && gap > 0 && prevGap <= 0 &&
      e60 !== null && close > e60 && m15 !== null && m15 >= MOM_CROSS_BPS
    ) {
      next = s60 !== null && s60 >= 0 ? 'A' : 'B';
    } else if (
      reentry && gap !== null && gap > 0 &&
      e60 !== null && close > e60 && m15 !== null && m15 >= MOM_REENTRY_BPS
    ) {
      next = 'B';
    } else if (
      dist60 !== null && dist60 <= DIP_DIST_BPS &&
      m15 !== null && m15 >= MOM_DIP_BPS && e8 !== null && close > e8
    ) {
      next = 'C';
    }

    if (next !== null && state.cash > 0n) {
      plan = next;
      peakClose = close;
      holdBars = 0;
      reentry = false;
      if (gap !== null) prevGap = gap;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    if (gap !== null) prevGap = gap;
    return [];
  },
});
