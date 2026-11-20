'use strict';
/* Peer Radar dashboard: renders window.RADAR_DATA (written by main.ts beside
   this page) as a sortable, filterable board with a detail view per protocol.
   No network, no fetch: everything on screen comes from that one script. */

const DATA = window.RADAR_DATA;
const rows = DATA.rows;
const boardEl = document.getElementById('board');
const detailEl = document.getElementById('detail');

const money = (n) => {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n;
};
const pct = (n) => (n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

document.getElementById('snapshot-note').textContent =
  'Snapshot ' + DATA.as_of + ' · ' + DATA.source;
document.getElementById('foot-note').textContent =
  'Board built from the sealed snapshot of ' + DATA.as_of + ' (' + DATA.protocol_count +
  ' protocols). Implied values are the ' + DATA.model_name + " model's own claim. " +
  'Protocols are described as recording no token, per the snapshot record.';

document.getElementById('stats').innerHTML = [
  [DATA.board_count, 'pre-token protocols ranked'],
  [DATA.watchlist_count + '/' + DATA.watchlist_count, 'watchlist protocols covered'],
  [DATA.global_live_count, 'live peers behind the multiples'],
  ['×' + DATA.global_multiple.toFixed(2), 'global median mcap / TVL'],
].map(([v, label]) => '<div class="stat"><b>' + v + '</b><span>' + label + '</span></div>').join('');

document.getElementById('category-multiples').innerHTML =
  '<table><tr><th>Category</th><th>Live peers</th><th>Median mcap / TVL</th></tr>' +
  DATA.categories.map((c) =>
    '<tr><td>' + esc(c.category) + '</td><td>' + c.live_count + '</td><td>×' + c.median_multiple.toFixed(2) + '</td></tr>').join('') +
  '</table>';

document.getElementById('live-rows').innerHTML = DATA.live.slice(0, 12).map((p) =>
  '<div class="live-item">' + esc(p.name) + ' — ' + money(p.mcap_usd) + ' mcap' +
  '<span class="sub">' + esc(p.category || 'Uncategorised') + ' · TVL ' + money(p.tvl_usd) +
  ' · ×' + (p.multiple === null ? '—' : p.multiple.toFixed(2)) + ' of TVL</span></div>').join('');

/* ------------------------------------------------ filters and sorting */

const categories = [...new Set(rows.map((r) => r.category || 'Uncategorised'))].sort();
const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
const catSel = document.getElementById('f-category');
const chainSel = document.getElementById('f-chain');
catSel.innerHTML = '<option value="">All categories</option>' + categories.map((c) => '<option>' + esc(c) + '</option>').join('');
chainSel.innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');

const state = { q: '', category: '', chain: '', watch: false, sort: 'rank' };

function visibleRows() {
  let out = rows.filter((r) => {
    if (state.watch && !r.on_watchlist) return false;
    if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    }
    return true;
  });
  const by = {
    rank: (a, b) => a.rank - b.rank,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    growth: (a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity),
    age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
  }[state.sort];
  return out.sort(by);
}

function renderBoard() {
  const list = visibleRows();
  document.getElementById('row-count').textContent = list.length + ' of ' + rows.length + ' protocols shown';
  boardEl.innerHTML = list.map((r) =>
    '<button class="row" data-slug="' + esc(r.slug) + '">' +
    '<span class="rk">#' + r.rank + '</span>' +
    '<span><span class="nm">' + esc(r.name) + '</span>' +
    (r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '') +
    '<span class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ') || 'no chain listed') + '</span></span>' +
    '<span class="num">TVL ' + money(r.tvl_usd) + '</span>' +
    '<span class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down') + '">7d ' + pct(r.change_7d) + '</span>' +
    '<span class="num">' + (r.age_days === null ? 'age n/a' : r.age_days + ' days') + '</span>' +
    '<span class="num">×' + r.multiple.toFixed(2) + ' peer multiple</span>' +
    '<span class="val">' + money(r.implied_value_usd) + '<span class="sub">implied value</span></span>' +
    '</button>').join('');
  for (const el of boardEl.querySelectorAll('.row')) {
    el.addEventListener('click', () => openDetail(el.getAttribute('data-slug')));
  }
}

/* ------------------------------------------------ detail view */

function openDetail(slug, scroll = true) {
  const r = rows.find((x) => x.slug === slug);
  if (!r) return;
  const factor = (value, label) => '<div class="factor"><b>' + value + '</b><span>' + label + '</span></div>';
  detailEl.innerHTML =
    '<button class="close" id="d-close">Close</button>' +
    '<h2>#' + r.rank + ' · ' + esc(r.name) + (r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
    '<p>' + esc(r.category || 'Uncategorised') + ' · records no token in the snapshot · tracked for ' +
    (r.age_days === null ? 'an unreported time' : r.age_days + ' days') +
    ' · live on ' + esc(r.chains.join(', ') || 'no chain listed') + '</p>' +
    '<div class="factors">' +
    factor(money(r.tvl_usd), 'TVL in the snapshot') +
    factor('×' + r.multiple.toFixed(2), r.basis === 'category'
      ? 'blended peer multiple (' + r.category_peers + ' live peers in its category)'
      : 'global peer multiple (its category has only ' + r.category_peers + ' live peer(s), too few to trust alone)') +
    factor('×' + r.growth_factor.toFixed(2), 'growth factor from its 7-day change of ' + pct(r.change_7d)) +
    factor('×' + r.maturity_factor.toFixed(2), 'maturity factor for its age') +
    factor('×' + r.breadth_factor.toFixed(2), 'breadth factor for ' + r.chains.length + ' chain(s)') +
    factor(money(r.implied_value_usd), 'implied value = TVL × the four factors') +
    '</div>' +
    '<h3>Farm plan</h3><ol>' +
    r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') +
    '</ol>';
  detailEl.hidden = false;
  document.getElementById('d-close').addEventListener('click', () => {
    detailEl.hidden = true;
    history.replaceState(null, '', location.pathname);
  });
  if (scroll) detailEl.scrollIntoView({ block: 'start' });
}

for (const [id, key] of [['q', 'q'], ['f-category', 'category'], ['f-chain', 'chain'], ['f-sort', 'sort']]) {
  document.getElementById(id).addEventListener('input', (e) => {
    state[key] = e.target.value;
    renderBoard();
  });
}
document.getElementById('f-watch').addEventListener('change', (e) => {
  state.watch = e.target.checked;
  renderBoard();
});

/* Deep links for screenshots and sharing: #protocol=<slug> opens a detail,
   #category=<name> starts filtered, #watchlist=1 starts on the watchlist. */
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('category')) {
  state.category = hash.get('category');
  catSel.value = state.category;
}
if (hash.get('watchlist') === '1') {
  state.watch = true;
  document.getElementById('f-watch').checked = true;
}
renderBoard();
if (hash.get('protocol')) openDetail(hash.get('protocol'), false);
