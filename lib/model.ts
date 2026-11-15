export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

export interface FactorBreakdown {
  tvl: number;
  sizeMultiple: number;
  growthMult: number;
  maturityMult: number;
  implied: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  size_multiple: number;
  growth_mult: number;
  maturity_mult: number;
  conviction: number;
  conviction_legs: ConvictionLegs;
  cat_median: number | null;
  cat_peers: number;
  farm_steps: string[];
}

export interface ConvictionLegs {
  scale: number;
  momentum: number;
  maturity: number;
  peers: number;
  agreement: number;
  total: number;
}

export interface CategoryMedian {
  median: number;
  peers: number;
}

export interface LivePeer {
  category: string | null;
  tvl_usd: number;
  mcap_usd: number | null;
}

export interface SizeCurve {
  intercept: number;
  slope: number;
  n: number;
  clampMin: number;
  clampMax: number;
}

const FALLBACK_INTERCEPT = 3.0247;
const FALLBACK_SLOPE = -0.4777;
const CLAMP_MIN = 0.02;
const CLAMP_MAX = 0.8;

export function fitSizeCurve(live: SnapshotProtocol[]): SizeCurve {
  const points: Array<{ x: number; y: number }> = [];

  for (const protocol of live) {
    const tvl = protocol.tvl_usd;
    const mcap = protocol.mcap_usd;

    if (
      typeof tvl !== "number" ||
      typeof mcap !== "number" ||
      !Number.isFinite(tvl) ||
      !Number.isFinite(mcap) ||
      tvl <= 0 ||
      mcap <= 0
    ) {
      continue;
    }

    points.push({
      x: Math.log10(tvl),
      y: Math.log10(mcap / tvl),
    });
  }

  const n = points.length;
  if (n < 10) {
    return {
      intercept: FALLBACK_INTERCEPT,
      slope: FALLBACK_SLOPE,
      n,
      clampMin: CLAMP_MIN,
      clampMax: CLAMP_MAX,
    };
  }

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;

  let covariance = 0;
  let varianceX = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    covariance += dx * (point.y - meanY);
    varianceX += dx * dx;
  }

  const slope = varianceX === 0 ? 0 : covariance / varianceX;
  return {
    intercept: meanY - slope * meanX,
    slope,
    n,
    clampMin: CLAMP_MIN,
    clampMax: CLAMP_MAX,
  };
}

export function sizeMultiple(tvl: number, curve: SizeCurve): number {
  if (!Number.isFinite(tvl) || tvl <= 0) {
    return curve.clampMin;
  }

  const fitted = 10 ** (curve.intercept + curve.slope * Math.log10(tvl));
  return Math.min(curve.clampMax, Math.max(curve.clampMin, fitted));
}

export function growthMultiplier(change7d: number | null): number {
  const change = typeof change7d === "number" && Number.isFinite(change7d)
    ? change7d
    : 0;
  return 1 + Math.min(30, Math.max(-30, change)) / 100;
}

export function maturityMultiplier(ageDaysVal: number | null): number {
  const age = typeof ageDaysVal === "number" && Number.isFinite(ageDaysVal)
    ? ageDaysVal
    : 365;
  return 0.7 + 0.3 * Math.min(age, 1095) / 1095;
}

export function ageDays(asOf: string | Date, listedAt: string | null): number | null {
  if (!listedAt) {
    return null;
  }

  const asOfTime = new Date(asOf).getTime();
  const listedTime = new Date(listedAt).getTime();
  if (!Number.isFinite(asOfTime) || !Number.isFinite(listedTime)) {
    return null;
  }

  return Math.max(0, Math.floor((asOfTime - listedTime) / 86_400_000));
}

export function calculateImpliedValue(
  p: SnapshotProtocol,
  asOf: string | Date,
  curve: SizeCurve,
): FactorBreakdown {
  const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
  const multiple = sizeMultiple(tvl, curve);
  const growthMult = growthMultiplier(p.change_7d);
  const maturityMult = maturityMultiplier(ageDays(asOf, p.listed_at));
  const implied = Math.max(1, Math.round(tvl * multiple * 0.75 * growthMult * maturityMult));

  return {
    tvl,
    sizeMultiple: multiple,
    growthMult,
    maturityMult,
    implied,
  };
}

// Median multiple per category over the live tokens (mcap > 0, tvl > 0).
// Median of raw mcap/TVL multiples: odd count takes the middle value, even
// count takes the mean of the two central values. Categories with no live
// peers are absent from the map, so callers treat a missing entry as
// "no median". Live peers and board rows are disjoint sets (a board row
// records no token), so no row ever counts itself as a peer.
export function categoryMedians(live: LivePeer[]): Map<string, CategoryMedian> {
  const byCategory = new Map<string, number[]>();
  for (const protocol of live) {
    if (protocol.category === null) {
      continue;
    }
    const tvl = protocol.tvl_usd;
    const mcap = protocol.mcap_usd;
    if (
      typeof tvl !== "number" ||
      typeof mcap !== "number" ||
      !Number.isFinite(tvl) ||
      !Number.isFinite(mcap) ||
      tvl <= 0 ||
      mcap <= 0
    ) {
      continue;
    }
    const list = byCategory.get(protocol.category);
    if (list) {
      list.push(mcap / tvl);
    } else {
      byCategory.set(protocol.category, [mcap / tvl]);
    }
  }

  const result = new Map<string, CategoryMedian>();
  const categories = [...byCategory.keys()].sort();
  for (const category of categories) {
    const values = byCategory.get(category)!.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 === 1
      ? values[mid]
      : (values[mid - 1] + values[mid]) / 2;
    result.set(category, { median, peers: values.length });
  }
  return result;
}

export function convictionLegs(
  p: SnapshotProtocol,
  ageDaysVal: number | null,
  sizeMultipleValue: number,
  logMin: number,
  logMax: number,
  medians: Map<string, CategoryMedian>,
): ConvictionLegs {
  let scale: number;
  if (
    !Number.isFinite(p.tvl_usd) ||
    p.tvl_usd <= 0 ||
    !Number.isFinite(logMin) ||
    !Number.isFinite(logMax)
  ) {
    scale = 0;
  } else if (logMax - logMin <= 0) {
    // Degenerate board (all rows the same TVL): no size signal to rank on,
    // so every row takes the neutral midpoint of the leg instead of dividing
    // by zero. Never triggers on the shipped snapshot (log range 6.70-9.44).
    scale = 13;
  } else {
    scale = Math.round(
      (25 * (Math.log10(p.tvl_usd) - logMin)) / (logMax - logMin),
    );
  }
  scale = Math.min(25, Math.max(0, scale));

  let momentum: number;
  if (typeof p.change_7d === "number" && Number.isFinite(p.change_7d)) {
    momentum = Math.round(10 + Math.min(30, Math.max(-30, p.change_7d)) / 3);
  } else {
    momentum = 10;
  }
  momentum = Math.min(20, Math.max(0, momentum));

  const age = ageDaysVal === null ? 365 : ageDaysVal;
  const maturity = Math.round(
    (20 * Math.min(Math.max(age, 0), 1095)) / 1095,
  );

  const entry = p.category === null ? undefined : medians.get(p.category);
  const peersCount = entry ? entry.peers : 0;
  const peers = peersCount === 0
    ? 0
    : peersCount <= 2
      ? 7
      : peersCount <= 5
        ? 13
        : 20;

  let agreement: number;
  if (
    !entry ||
    !Number.isFinite(sizeMultipleValue) ||
    sizeMultipleValue <= 0 ||
    !Number.isFinite(entry.median) ||
    entry.median <= 0
  ) {
    agreement = 8;
  } else {
    const d = Math.abs(
      Math.log10(sizeMultipleValue) - Math.log10(entry.median),
    );
    agreement = d <= 0.1 ? 15 : d <= 0.25 ? 11 : d <= 0.4 ? 7 : 3;
  }

  const total = Math.min(
    100,
    Math.max(0, scale + momentum + maturity + peers + agreement),
  );
  return { scale, momentum, maturity, peers, agreement, total };
}

export function rankable(p: SnapshotProtocol): boolean {
  if (
    p.mcap_usd !== null ||
    p.gecko_id !== null ||
    p.symbol !== null
  ) {
    return false;
  }

  const excludedCategories = new Set([
    "Bridge",
    "Canonical Bridge",
    "Liquid Staking",
    "Liquid Restaking",
    "Restaked BTC",
    "CEX",
  ]);
  if (excludedCategories.has(p.category)) {
    return false;
  }

  const name = p.name.trim();
  if (/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(name)) {
    return false;
  }
  if (/\b(?:wrapped|staked|staking)\b/i.test(name)) {
    return false;
  }
  if (/^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(name)) {
    return false;
  }

  return true;
}

function cappedStep(text: string): string {
  if (text.length <= 600) {
    return text;
  }
  return `${text.slice(0, 597).trimEnd()}...`;
}

export function generateFarmSteps(p: SnapshotProtocol, asOf: string | Date): string[] {
  const primaryChain = p.chains?.[0] || "its main chain";
  const capital = p.tvl_usd >= 5_000_000_000
    ? 250
    : p.tvl_usd >= 1_000_000_000
      ? 150
      : p.tvl_usd >= 100_000_000
        ? 100
        : 50;

  const age = ageDays(asOf, p.listed_at);
  const holdDays = age !== null && age > 1095
    ? 60
    : age !== null && age > 500
      ? 45
      : 30;

  const mechanisms: Record<string, string> = {
    Lending: "supply a stablecoin or blue-chip asset to the lending market",
    Dexs: "provide liquidity in a pool on the primary chain",
    Perps: "open a small margined position",
    "Risk Curators": "deposit into the curator vault",
    RWA: "mint the tokenised asset",
    Stablecoin: "mint the stablecoin against collateral",
    CDP: "open a collateralised debt position",
    Yield: "deposit into the yield vault",
    Restaking: "restake through the restaking vault",
    "Staking Pool": "stake into the staking pool",
    Insurance: "buy cover for a position",
    "Prediction Market": "place a prediction",
    "Governance Incentives": "vote or delegate governance power",
    "Basis Trading": "open a basis trade",
    "Collateral Markets": "post collateral to the market",
    CeDeFi: "deposit into the CeDeFi vault",
    "Onchain Capital Allocator": "deposit into the allocator vault",
    Payments: "settle a payment through the protocol",
    Chain: "use the chain dApps",
  };
  const mechanism = mechanisms[p.category] ?? "interact with the protocol";

  return [
    `Set up a dedicated wallet for ${p.name} on ${primaryChain}. Cost: $0. Time: 5 minutes.`,
    `Fund it with $${capital} for the farm. Cost: $${capital} plus gas. Time: 10 minutes.`,
    `On ${primaryChain}, ${mechanism} with $${capital} of capital. Cost: $${capital} plus gas. Time: 15 minutes.`,
    `Hold the position for ${holdDays} days. Cost: opportunity cost of $${capital} locked for ${holdDays} days. Time: ${holdDays} days.`,
    `Check your position and any points or eligibility on the official ${p.name} dashboard (${p.slug}) at least weekly. Cost: $0. Time: 5 minutes a week.`,
    `Withdraw or harvest from ${p.name} when the token launches or the position no longer earns. Cost: gas on ${primaryChain}. Time: 10 minutes.`,
  ].map(cappedStep);
}
