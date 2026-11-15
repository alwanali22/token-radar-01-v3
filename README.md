# Token Radar 01

Ranks pre-token protocols by model-implied value using a size-fitted multiple, growth, and maturity.

## Model

`implied_value_usd = round(TVL * sizeMultiple(TVL) * 0.75 * growthMult * maturityMult)`

The size curve is fitted from the snapshot's own live tokens: n=128, slope -0.48, corr -0.41. Five-fold backtest median error is 0.56 in log10 versus 0.72 for a flat median multiple.

## Conviction (v3)

Each board row also carries a Conviction score, 0–100, that says how much
evidence backs its implied value — it never changes the value itself. It is
the sum of five integer legs, each computed only from the snapshot's own
figures, the fitted curve, and the live peers:

- **scale (25):** `round(25 * (log10(TVL) - logMin) / (logMax - logMin))`
  over the 198 board rows. Bigger TVL means more live comps nearby in size,
  so a tighter multiple estimate.
- **momentum (20):** `round(10 + clamp(change_7d, -30, +30) / 3)`; a null
  `change_7d` scores 10.
- **maturity (20):** `round(20 * min(age_days ?? 365, 1095) / 1095)`.
- **peers (20):** live peers (`mcap > 0`, `tvl > 0`) in the row's category:
  0 → 0, 1–2 → 7, 3–5 → 13, 6+ → 20.
- **agreement (15):** `d = |log10(row sizeMultiple) - log10(category median
  multiple)|`: d ≤ 0.10 → 15, ≤ 0.25 → 11, ≤ 0.40 → 7, else 3; no category
  peers → 8.

Category medians are supporting context, not a multiplier: for each named
category on the board, the median `mcap / TVL` across that category's live
tokens (even count → mean of the two central multiples), with the peer count.
Each row carries `cat_median` (full precision, null when its category has no
live peers) and `cat_peers`. `DATA.model` in `data.js` documents the formula
and lists every category with its board rows, live peers, and median multiple.

Local verification: implied values are byte-identical to v2 (top 5 unchanged);
Conviction ranges 15–74 (median 40.5); the top 10 by Conviction share only 1
row with the top 10 by implied value, so the two rankings genuinely differ.

## Run

