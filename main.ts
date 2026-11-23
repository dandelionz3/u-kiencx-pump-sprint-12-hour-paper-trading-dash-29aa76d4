// Dash sniper — a launch sniper for the agent-fun/replay/v2 pump.fun replay.
//
// The shape of the edge: almost every fresh coin craters within seconds, but a
// small minority runs several multiples. So the bot only ever buys a launch
// whose opening tape looks like real people piling in — the creator put real
// money in at creation, several unrelated wallets bought early, buys outweigh
// sells, and the creator has not dumped — and then it babysits the position:
// bank half at the first big pop, cut the rest fast when it sags, trail the
// winners, and never let a dead coin sit. Everything here is a pure function
// of the batches the harness feeds in: no clock, no randomness, no I/O, no
// reads outside the batch. Hello, batch, orders, slot: one batch in, at most
// one reply of orders per slot, and the reply only ever touches coins the
// batches have shown us.
//
// A coin's price comes from its virtual reserves (quote / tokens). What a
// position is worth is what selling it would pay after the curve's cut, less
// one tx fee; what it cost is the SOL spent plus the tx fees already paid.
// Every decision is worth-versus-cost in basis points.

import { BPS, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** All knobs in one place: lamports, basis points, or slots. */
const K = {
  /** Buy window: youngest / oldest age (slots since CreateEvent) for a first buy. */
  minAge: 0,
  maxAge: 10,
  /** Target size per coin; each reply is still capped at 1% of real SOL. */
  stake: 100_000_000n,
  /** Smallest buy worth paying a tx fee for. */
  minBuy: 5_000_000n,
  /** Real SOL sitting in the curve when we decide. */
  minRealSol: 50_000_000n,
  maxRealSol: 30_000_000_000n,
  /** The creator's own buys in the create slot. */
  minDevBuy: 200_000_000n,
  maxDevBuy: 2_500_000_000n,
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: 5,
  maxBuyers: 999,
  /** Lamports sold by others over lamports bought, at most, in bps. */
  maxSellRatioBps: 10_000n,
  /** Current price over create price, at most, in bps — never chase a top. */
  maxRunupBps: 20_000n,
  /** Recent-flow window (slots); the tape must not be net selling in it. */
  flowWindow: 10,
  minFlow: 0n,
  minFlowBuyers: 0,
  /** Skip a coin whose creator already sold. */
  skipDevSold: true,
  /** Slippage allowed on buys, bps. */
  buySlippageBps: 10_000,
  /** First pop: sell this share once worth this far over cost (bps). */
  tp1Bps: 5_000n,
  tp1ShareBps: 5_000n,
  /** After the first pop, the remainder stops out this far under cost (bps). */
  slAfterTp1Bps: 0n,
  /** Full exit once worth this far over cost (bps). */
  tpBps: 3_500n,
  /** Full exit once worth this far under cost (bps). */
  slBps: 1_500n,
  /** Trail: once up this far (bps), exit on a pullback of this much (bps). */
  trailArmBps: 3_000n,
  trailBps: 1_500n,
  /** Give up after this many slots held. */
  maxHold: 300,
  /** Exit when the creator sells while we hold. */
  exitOnDevSell: true,
  /** Exit when no trade has touched the coin for this many slots. */
  staleSlots: 500,
} as const;

/** Curve fees taken on every sale: 95 bps protocol + 30 bps creator. */
const SELL_FEE_BPS = 125n;

interface Trade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

/** Everything we track about one coin's opening tape. */
interface Tape {
  mint: Pubkey;
  born: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldOthers: bigint;
  devSold: boolean;
  lastTrade: number;
  recent: Trade[];
  decided: boolean;
  done: boolean;
}

/** Everything we track about one open position. */
interface Open {
  opened: number;
  feesPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  banked: boolean;
}

/** What selling `tokens` against (vq, vt) pays after the curve's cut. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * SELL_FEE_BPS + BPS - 1n) / BPS;
}

const tapes = new Map<Pubkey, Tape>();
const opens = new Map<Pubkey, Open>();
const exiting = new Set<Pubkey>();

/** Fold this batch's chain events into the tapes. */
function absorb(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapes.set(e.mint, {
        mint: e.mint,
        born: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        buyers: new Set(),
        bought: 0n,
        soldOthers: 0n,
        devSold: false,
        lastTrade: e.slot,
        recent: [],
        decided: false,
        done: false,
      });
    } else if (e.event === 'TradeEvent') {
      const t = tapes.get(e.mint);
      if (t === undefined) continue;
      const sol = BigInt(e.sol_amount);
      t.lastTrade = e.slot;
      t.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
      const dev = e.user === t.creator;
      if (e.is_buy) {
        t.bought += sol;
        if (dev && e.slot === t.born) t.devBuy += sol;
        else if (!dev) t.buyers.add(e.user);
      } else if (dev) {
        t.devSold = true;
      } else {
        t.soldOthers += sol;
      }
    } else {
      const t = tapes.get(e.mint);
      if (t !== undefined) {
        t.done = true;
        t.decided = true;
      }
    }
  }
}

/** Net flow and distinct buyers inside the recent window; drops stale ticks. */
function recentFlow(t: Tape, slot: number): { net: bigint; buyers: number } {
  const from = slot - K.flowWindow;
  let cut = 0;
  while (cut < t.recent.length && t.recent[cut]!.slot <= from) cut++;
  if (cut > 0) t.recent.splice(0, cut);
  let net = 0n;
  const buyers = new Set<Pubkey>();
  for (const tr of t.recent) {
    if (tr.buy) {
      net += tr.sol;
      if (tr.user !== t.creator) buyers.add(tr.user);
    } else {
      net -= tr.sol;
    }
  }
  return { net, buyers: buyers.size };
}

function pendingSide(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

/** Reconcile fills with our books: harness closes drop the position, buys open one. */
function reconcile(state: BotState, batch: Batch, txFee: bigint): void {
  for (const f of batch.fills) {
    if (f.client_id.startsWith('_')) {
      opens.delete(f.mint);
      exiting.delete(f.mint);
      continue;
    }
    const o = opens.get(f.mint);
    if (o !== undefined && f.status !== 'rejected') o.feesPaid += BigInt(f.tx_fee_lamports);
    if (f.side === 'buy' && f.status === 'filled' && o === undefined) {
      opens.set(f.mint, {
        opened: f.slot,
        feesPaid: BigInt(f.tx_fee_lamports),
        best: 0n,
        devSoldAtOpen: tapes.get(f.mint)?.devSold ?? false,
        banked: false,
      });
    }
  }
  for (const mint of [...exiting]) {
    if (!pendingSide(state, mint, 'sell')) exiting.delete(mint);
  }
  for (const mint of [...opens.keys()]) {
    if (!state.positions.has(mint) && !exiting.has(mint) && !pendingSide(state, mint, 'buy')) {
      opens.delete(mint);
    }
  }
}

/** Current mark for a mint: this batch's mark, else the curve's latest reserves. */
function markFor(state: BotState, batch: Batch, mint: Pubkey): { vq: bigint; vt: bigint } | undefined {
  for (const m of batch.marks) {
    if (m.mint === mint) return { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) };
  }
  const c = state.curves.get(mint);
  if (c === undefined) return undefined;
  return { vq: c.virtual_quote_reserves, vt: c.virtual_token_reserves };
}

/** Walk every open position and emit the exits it has earned. */
function exits(state: BotState, batch: Batch, orders: OrderInput[], txFee: bigint): void {
  const cap = state.hello.caps.max_orders_per_batch;
  for (const [mint, pos] of state.positions) {
    if (orders.length >= cap) break;
    if (exiting.has(mint)) continue;
    const t = tapes.get(mint);
    let o = opens.get(mint);
    if (o === undefined) {
      o = { opened: state.slot, feesPaid: txFee, best: 0n, devSoldAtOpen: t?.devSold ?? false, banked: false };
      opens.set(mint, o);
    }
    const mk = markFor(state, batch, mint);
    if (mk === undefined) continue;
    const worth = sellValue(pos.token_amount, mk.vq, mk.vt) - txFee;
    const cost = pos.cost_lamports + o.feesPaid;
    if (worth > o.best) o.best = worth;
    let leave = false;
    if (cost > 0n) {
      // Bank half once, then the rest rides with a breakeven stop.
      if (!o.banked && worth * BPS >= cost * (BPS + K.tp1Bps)) {
        const part = (pos.token_amount * K.tp1ShareBps) / BPS;
        if (part > 0n && part < pos.token_amount) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
          exiting.add(mint);
          o.banked = true;
          o.best = 0n;
          continue;
        }
      }
      if (worth * BPS >= cost * (BPS + K.tpBps)) leave = true;
      const stop = o.banked ? K.slAfterTp1Bps : K.slBps;
      if (worth * BPS <= cost * (BPS - stop)) leave = true;
      if (o.best * BPS >= cost * (BPS + K.trailArmBps) && worth * BPS <= o.best * (BPS - K.trailBps)) {
        leave = true;
      }
    }
    if (state.slot - o.opened >= K.maxHold) leave = true;
    if (t !== undefined) {
      if (K.exitOnDevSell && t.devSold && !o.devSoldAtOpen) leave = true;
      if (state.slot - t.lastTrade >= K.staleSlots) leave = true;
    }
    if (!leave) continue;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    exiting.add(mint);
    if (t !== undefined) t.decided = true;
  }
}

/** Walk the fresh tapes and buy the ones that still look organic. */
function entries(state: BotState, batch: Batch, orders: OrderInput[], txFee: bigint): void {
  const cap = state.hello.caps.max_orders_per_batch;
  let free = state.freeCashLamports() - txFee * BigInt(orders.length);
  let open = state.committedPositionCount();
  for (const t of tapes.values()) {
    if (orders.length >= cap) break;
    if (t.decided || t.done) continue;
    const age = state.slot - t.born;
    if (age > K.maxAge) {
      t.decided = true;
      continue;
    }
    if (age < K.minAge) continue;
    if (open >= state.hello.caps.max_open_positions) continue;
    const curve = state.curves.get(t.mint);
    if (curve === undefined || curve.complete) continue;
    if (t.devSold && K.skipDevSold) {
      t.decided = true;
      continue;
    }
    const rq = curve.real_quote_reserves;
    if (rq < K.minRealSol || rq > K.maxRealSol) continue;
    if (t.devBuy < K.minDevBuy || t.devBuy > K.maxDevBuy) continue;
    if (t.buyers.size < K.minBuyers || t.buyers.size > K.maxBuyers) continue;
    if (t.bought > 0n && t.soldOthers * BPS > t.bought * K.maxSellRatioBps) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    const runup = (vq * t.vt0 * BPS) / (vt * t.vq0);
    if (runup > K.maxRunupBps) continue;
    const fl = recentFlow(t, state.slot);
    if (fl.net < K.minFlow || fl.buyers < K.minFlowBuyers) continue;
    const capBuy = state.maxBuyLamports(t.mint);
    const amount = K.stake < capBuy ? K.stake : capBuy;
    if (amount < K.minBuy) continue;
    if (free < amount + txFee) continue;
    orders.push({ side: 'buy', mint: t.mint, quote_lamports: amount, max_slippage_bps: K.buySlippageBps });
    free -= amount + txFee;
    t.decided = true;
    open += 1;
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  absorb(batch);
  const orders: OrderInput[] = [];
  const txFee = state.txFeeLamports();
  reconcile(state, batch, txFee);
  exits(state, batch, orders, txFee);
  entries(state, batch, orders, txFee);
  return orders;
}

await runBot({ onBatch });
