// Token radar model: snapshot in, ranked board out.
//
// The question this model answers is narrow: if a protocol that records no
// token issued one today, what would the market plausibly pay for it? The
// only evidence allowed is the snapshot itself, so the model borrows its
// yardstick from the protocols in the same snapshot whose tokens already
// trade: for each category it takes the median market-cap-to-TVL ratio of
// that category's live protocols, blends it with the global median, and
// applies it to a pre-token protocol's TVL with three stated adjustments
// (seven-day growth, age, chain breadth). Every factor is printed on the
// dashboard next to every row, so a reader can disagree with any of them
// and recompute the board by hand. No name is special-cased.

export interface Protocol {
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
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The model's adjustable constants, printed on the dashboard as stated. */
export const TUNING = {
  category_weight: 0.7,
  min_category_peers: 4,
  multiple_cap: 8,
  growth_weight: 0.6,
  growth_low: -50,
  growth_high: 100,
  growth_floor: 0.55,
  maturity_base: 0.75,
  maturity_span: 0.35,
  maturity_window_days: 1460,
  unknown_age_factor: 0.92,
  breadth_per_chain: 0.03,
  breadth_max_extra_chains: 7,
};

export const MODEL_NAME = 'peer-multiple radar v2';

const DAY = 86_400_000;

/** Whole days between the day DefiLlama began tracking a protocol and the snapshot day. */
export function daysTracked(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const start = Date.parse(listedAt + 'T00:00:00Z');
  const end = Date.parse(asOf + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / DAY));
}

/** A protocol records a token when any of the three token fields is present. */
export function recordsToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const WRAPPER_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/**
 * The board's screen, the watchlist's own logic applied at any size: a row
 * must record no token and must not be a wrapped, staked, bridged or
 * versioned product of a protocol whose token already trades.
 */
export function passesScreen(p: Protocol): boolean {
  if (recordsToken(p)) return false;
  if (p.category !== null && WRAPPER_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_LEAD.test(p.name)) return false;
  return true;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface PeerStats {
  category: string;
  live_count: number;
  median_multiple: number;
}

export interface PeerTable {
  global_multiple: number;
  global_live_count: number;
  by_category: Map<string, PeerStats>;
}

/** Market-cap-to-TVL ratios of the snapshot's live-token protocols, per category and overall. */
export function peerMultiples(protocols: Protocol[]): PeerTable {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (!recordsToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const bucket = ratiosByCategory.get(key);
    if (bucket) bucket.push(ratio);
    else ratiosByCategory.set(key, [ratio]);
  }
  const byCategory = new Map<string, PeerStats>();
  for (const [category, ratios] of ratiosByCategory) {
    byCategory.set(category, {
      category,
      live_count: ratios.length,
      median_multiple: median(ratios),
    });
  }
  return {
    global_multiple: all.length > 0 ? median(all) : 1,
    global_live_count: all.length,
    by_category: byCategory,
  };
}

/** The multiple one protocol is valued at: its category's median, geometrically blended with the global one. */
export function blendedMultiple(p: Protocol, peers: PeerTable): { multiple: number; category_peers: number; basis: 'category' | 'global' } {
  const stats = p.category !== null ? peers.by_category.get(p.category) : undefined;
  if (!stats || stats.live_count < TUNING.min_category_peers) {
    return { multiple: Math.min(peers.global_multiple, TUNING.multiple_cap), category_peers: stats?.live_count ?? 0, basis: 'global' };
  }
  const blended = Math.exp(
    TUNING.category_weight * Math.log(stats.median_multiple) +
      (1 - TUNING.category_weight) * Math.log(peers.global_multiple),
  );
  return { multiple: Math.min(blended, TUNING.multiple_cap), category_peers: stats.live_count, basis: 'category' };
}

export interface ScoreBreakdown {
  multiple: number;
  category_peers: number;
  basis: 'category' | 'global';
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  age_days: number | null;
  implied_value_usd: number;
}

/** One protocol's implied value and every factor that produced it. */
export function scoreProtocol(p: Protocol, asOf: string, peers: PeerTable): ScoreBreakdown {
  const { multiple, category_peers, basis } = blendedMultiple(p, peers);
  const growthPct = p.change_7d === null ? 0 : Math.min(TUNING.growth_high, Math.max(TUNING.growth_low, p.change_7d));
  const growthFactor = Math.max(TUNING.growth_floor, 1 + (growthPct / 100) * TUNING.growth_weight);
  const age = daysTracked(asOf, p.listed_at);
  const maturityFactor =
    age === null
      ? TUNING.unknown_age_factor
      : TUNING.maturity_base + (Math.min(age, TUNING.maturity_window_days) / TUNING.maturity_window_days) * TUNING.maturity_span;
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), TUNING.breadth_max_extra_chains);
  const breadthFactor = 1 + TUNING.breadth_per_chain * extraChains;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthFactor * maturityFactor * breadthFactor));
  return { multiple, category_peers, basis, growth_factor: growthFactor, maturity_factor: maturityFactor, breadth_factor: breadthFactor, age_days: age, implied_value_usd: implied };
}

// ---------------------------------------------------------------- farm plans

/** Working capital for one farm position, scaled to the protocol's own size. */
function capitalTier(tvl: number): number {
  if (tvl >= 5_000_000_000) return 500;
  if (tvl >= 1_000_000_000) return 300;
  if (tvl >= 250_000_000) return 200;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

/** A plain-language gas estimate for the chain a position starts on. */
function gasNote(chain: string): string {
  if (chain === 'Ethereum') return 'budget $8-25 of ETH for gas on Ethereum mainnet';
  if (chain === 'Solana') return 'gas on Solana stays under $0.10 per transaction';
  if (chain === 'Bitcoin') return 'budget $1-4 for the Bitcoin network fee';
  return `gas on ${chain} is typically $0.10-1.50 per transaction`;
}

/** The core qualifying action for a category, written as an instruction a farmer can follow. */
function coreAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Supply $${capital} of USDC as collateral in ${n} on ${chain}; supplying is the position every later step builds on`;
  if (c.includes('dex') || c.includes('liquidity')) return `Add $${capital} of liquidity to the busiest USDC pair in ${n} on ${chain} and keep the LP position open`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC margin in ${n} on ${chain} and open one small hedged trade so the account shows real usage`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) return `Deposit $${capital} into a live ${n} vault on ${chain} and hold the vault shares in the same wallet`;
  if (c.includes('rwa')) return `Commit $${capital} to the ${n} yield asset on ${chain} through its mint or deposit page and hold the asset`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset issued through ${n} on ${chain} and hold it in the wallet`;
  if (c.includes('basis')) return `Fund $${capital} of USDC in ${n} on ${chain} so the basis position opens and stays delta-neutral`;
  if (c.includes('staking') || c.includes('pool')) return `Stake $${capital} worth of the native asset through ${n} on ${chain} and keep the staking receipt unspent`;
  if (c.includes('prediction')) return `Fund $${capital} in ${n} and take one position in a liquid market so the account has settled history`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active for the full term`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${n}, then use the bridged funds in one app on the far side`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} through its main product page and keep the position open`;
}

/** A second, different qualifying action: depth beats repetition in most points systems. */
function secondAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  if (secondChain !== null && p.chains.length >= 3) {
    return `Repeat the core action with $50 on ${secondChain}, ${n}'s second-largest chain: multi-chain activity is harder to fake and often scored separately. Cost: $50 plus gas. Time: 15 minutes`;
  }
  if (c.includes('lend') || c.includes('cdp')) return `In week two, borrow a small amount (about 20% of the supplied value) from ${n} and repay it a few days later, so the wallet shows both sides of the market. Cost: interest of a few dollars. Time: 10 minutes`;
  if (c.includes('dex') || c.includes('liquidity')) return `Make three swaps of $25-50 through ${n} across the second week, on different days, so the wallet reads as a regular trader rather than a one-off visitor. Cost: swap fees plus gas. Time: 5 minutes per swap`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Place one more small trade in a different market of ${n} in week two and close it within the week; varied markets show broader usage than one repeated trade. Cost: trading fees on $${capital}. Time: 10 minutes`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) return `Split a second $${Math.round(capital / 2)} deposit into a different ${n} vault in week two; holding two vaults shows selection, not a single parked deposit. Cost: the extra deposit plus gas. Time: 10 minutes`;
  return `Add a second, smaller position of $${Math.round(capital / 2)} in ${n} during week two, from the same wallet, so the account's history spans more than one session. Cost: the extra capital plus gas. Time: 10 minutes`;
}

/**
 * Six farm steps per protocol, each derived from that protocol's own
 * category, chains, TVL and age — never from a list of names. Every step
 * states its action, its cost and its time inside the 20-600 character
 * window the gate allows.
 */
export function farmSteps(p: Protocol, ageDays: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalTier(p.tvl_usd);
  const gas = gasNote(chain);
  const holdDays = ageDays === null ? 45 : ageDays < 180 ? 60 : ageDays < 365 ? 45 : 30;
  const busyCategory = /dex|bridge/i.test(p.category ?? '');
  const cadence = busyCategory
    ? `Keep the position active with 3-5 distinct transactions a week for the first month in ${p.name}; volume and variety are what this category's points systems usually count. Cost: about $3-6 of gas a week. Time: 15 minutes a week`
    : `Repeat one qualifying action in ${p.name} every week (a deposit top-up, a swap or a vote when one is open) so the wallet never looks dormant. Cost: about $2 of gas a week. Time: 10 minutes a week`;
  const steps = [
    `Start with a fresh wallet funded only with the $${capital} you plan to farm plus gas money; keep its seed phrase offline and never reuse an exchange deposit address. On ${chain}, ${gas}. Time: 10 minutes to set up`,
    `${coreAction(p, capital, chain)}. Cost: $${capital} of working capital; ${gas}. Time: 15-20 minutes`,
    secondAction(p, capital, chain),
    cadence,
    `Hold the ${p.name} position for at least ${holdDays} days without emptying the wallet, so the activity appears in several weekly snapshots instead of one. Cost: the $${capital} stays committed. Time: ${holdDays} days`,
    `When ${p.name} opens claims, use only the rewards page the protocol itself publishes, and never pay a fee or sign a blind approval to claim. Log every transaction hash in a simple farm diary as you go. Cost: nothing to check. Time: 10 minutes`,
  ];
  return steps.map((s) => (s.length > 600 ? s.slice(0, 597) + '...' : s));
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  multiple: number;
  category_peers: number;
  basis: 'category' | 'global';
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  farm_steps: string[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The ranked board: every watchlist protocol, plus every other protocol in
 * the snapshot that passes the same screen, valued and ordered by implied
 * value. Ranks are 1..N and implied value never rises as rank ascends.
 */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const peers = peerMultiples(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const selected = snapshot.protocols.filter((p) => watch.has(p.slug) || passesScreen(p));
  const scored = selected.map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, peers) }));
  scored.sort(
    (a, b) =>
      b.score.implied_value_usd - a.score.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : 1),
  );
  return scored.map(({ p, score }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: score.age_days,
    on_watchlist: watch.has(p.slug),
    implied_value_usd: score.implied_value_usd,
    multiple: round3(score.multiple),
    category_peers: score.category_peers,
    basis: score.basis,
    growth_factor: round3(score.growth_factor),
    maturity_factor: round3(score.maturity_factor),
    breadth_factor: round3(score.breadth_factor),
    farm_steps: farmSteps(p, score.age_days),
  }));
}

/** The first reason the gate would refuse this board, or null when it passes the board-side rows. */
export function boardProblem(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100-4000`;
  const seen = new Set<string>();
  for (const row of board) {
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `ranks are not exactly 1..N at position ${i + 1}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `implied value rises at rank ${i + 1}`;
    }
  }
  if (board.length > 1 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'every row shares one implied value';
  }
  for (const row of board) {
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has a bad implied value`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `${row.slug} has a farm step of ${len} characters`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- snapshot io

export class SnapshotShapeError extends Error {}

/** Parse and lightly validate the sealed snapshot; refuse anything that is not its documented shape. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotShapeError('snapshot is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotShapeError('snapshot is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || typeof doc.source !== 'string') {
    throw new SnapshotShapeError('snapshot lacks as_of or source');
  }
  if (typeof doc.floor_usd !== 'number' || !(doc.floor_usd > 0)) {
    throw new SnapshotShapeError('snapshot lacks a positive floor_usd');
  }
  if (!Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new SnapshotShapeError('snapshot lacks protocols or watchlist arrays');
  }
  const protocols: Protocol[] = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) throw new SnapshotShapeError(`protocol ${i} is not an object`);
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new SnapshotShapeError(`protocol ${i} lacks slug, name or tvl_usd`);
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  const watchlist = doc.watchlist.filter((s): s is string => typeof s === 'string');
  return { as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd, protocols, watchlist };
}

/** The dashboard's data bundle: the board, the live-peer evidence and the model, in one object. */
export function dashboardData(snapshot: Snapshot, board: BoardRow[]): Record<string, unknown> {
  const peers = peerMultiples(snapshot.protocols);
  const live = snapshot.protocols
    .filter((p) => recordsToken(p) && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      multiple: p.tvl_usd > 0 ? round3((p.mcap_usd ?? 0) / p.tvl_usd) : null,
    }));
  const categories = [...peers.by_category.values()]
    .filter((s) => s.live_count >= TUNING.min_category_peers)
    .sort((a, b) => b.live_count - a.live_count)
    .map((s) => ({ category: s.category, live_count: s.live_count, median_multiple: round3(s.median_multiple) }));
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_name: MODEL_NAME,
    tuning: TUNING,
    protocol_count: snapshot.protocols.length,
    watchlist_count: snapshot.watchlist.length,
    board_count: board.length,
    global_multiple: round3(peers.global_multiple),
    global_live_count: peers.global_live_count,
    categories,
    rows: board,
    live,
  };
}

/** data.js: the dashboard reads this one script; there is no fetch and no network. */
export function dataScript(snapshot: Snapshot, board: BoardRow[]): string {
  return 'window.RADAR_DATA = ' + JSON.stringify(dashboardData(snapshot, board)) + ';\n';
}
