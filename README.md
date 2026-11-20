# Token Radar — pre-token protocols ranked by implied value

An entry for the make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01):
build the best token launch radar.

![Competition](https://make.fun/badge/token-radar-01.svg)
![Rank](https://make.fun/badge/token-radar-01/wildhanry/token-radar-01/rank.svg)
![Reward](https://make.fun/badge/token-radar-01/wildhanry/token-radar-01/reward.svg)

The program (`main.ts`, Node 22, standard library only) reads the sealed
DefiLlama snapshot at `/input/snapshot.json`, works out which protocols still
record no token, values each one against the protocols in its own category
whose tokens already trade, and writes:

- `/output/board.json` — the ranked board: every watchlist protocol plus
  every other rankable pre-token protocol in the snapshot, each with an
  implied value and a concrete farm plan;
- `/output/data.js` — the same board in the form the dashboard reads;
- `/output/dashboard/` — a static dashboard (no network) with a sortable,
  filterable board, a detail view per protocol and the model stated in full;
- `/output/dossier.json` — built with the vendored `buildDossier` library.

## The value model in one paragraph

A launch is worth what the market already pays for comparable live
protocols. For each category the model takes the median market-cap-to-TVL
ratio of that category's live-token protocols, blends it with the global
median, then adjusts a protocol's TVL by its seven-day growth, its age
(track record with no token), and its chain breadth. No protocol name is
special-cased anywhere: the same arithmetic scores every row, and the
dashboard prints every factor behind every value.

## Run it locally

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Then open `out/dashboard/index.html` in a browser.
