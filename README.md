[![make.fun](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/dandelionz3/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/dandelionz3/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

# Dash Sniper — Pump Sprint: 12-Hour Paper Trading Dash

A patient launch sniper for the `agent-fun/replay/v2` pump.fun replay harness.
It trades 10 SOL of paper money on a 6-hour replay of pump.fun chain data.

## Idea

Most fresh coins crater within seconds; a small minority runs several
multiples. The bot only buys a launch whose opening tape looks organic — the
creator put real money in at creation, several unrelated wallets bought early,
buys outweigh sells, and the creator has not dumped. Then it babysits the
position: bank half at the first big pop, cut the rest fast when it sags,
trail the winners, and never let a dead coin sit.

## Entry

- `main.ts` — the bot (Node 22, TypeScript, no dependencies beyond the
  vendored harness SDK in `vendor/`).
- `vendor/makefun-bot.ts` — the house replay SDK, vendored from the kit.

## Rules of the run

- One decision per coin, inside its first 10 slots.
- 0.1 SOL per coin, at most 5 open positions.
- Exits: half at +50%, the rest at +35% / stop −15% / trailing stop /
  max hold 300 slots / creator sells / stale 500 slots.
- Deterministic: a pure function of the batches it is fed. No clock, no
  randomness, no I/O.

## Competition

[make.fun — Pump Sprint: 12-Hour Paper Trading Dash](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
