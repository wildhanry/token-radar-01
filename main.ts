// Token radar entrypoint (Node 22, standard library only).
//
// One run does five things, in this order:
//   1. read the sealed snapshot (default /input/snapshot.json, or --input),
//   2. build the ranked board with the model in lib/model.ts and refuse to
//      ship a board the gate would refuse,
//   3. write board.json and the dashboard's data.js into the output folder,
//   4. copy this repository's dashboard/ and screenshots/ beside them,
//   5. write dossier.json last, with the vendored buildDossier, because the
//      scorer rebuilds the dossier from the finished output and compares
//      bytes — anything written after it would stale it.
//
// Outside the grader, MAKEFUN_OUTPUT_DIR names the output folder:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardProblem, buildBoard, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

function flagValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const at = args.indexOf('--' + name);
  if (at !== -1) return args[at + 1];
  const joined = args.find((a) => a.startsWith('--' + name + '='));
  return joined ? joined.slice(name.length + 3) : undefined;
}

function fail(message: string): never {
  process.stderr.write('token-radar: ' + message + '\n');
  process.exit(1);
}

const inputPath = (() => {
  const given = flagValue('input') ?? '/input/snapshot.json';
  return given.endsWith('.json') ? given : join(given, 'snapshot.json');
})();
if (!existsSync(inputPath)) {
  fail(`no snapshot at ${inputPath} — pass --input <snapshot.json|folder> or mount the sealed /input`);
}
const outputDir = flagValue('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
const board = buildBoard(snapshot);
const problem = boardProblem(board, snapshot);
if (problem !== null) fail(`the model produced a board the gate refuses: ${problem}`);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), JSON.stringify({ rows: board }, null, 0) + '\n');
writeFileSync(join(outputDir, 'data.js'), dataScript(snapshot, board));

for (const folder of ['dashboard', 'screenshots']) {
  const from = join(repoDir, folder);
  if (!existsSync(from)) fail(`repository is missing ${folder}/`);
  cpSync(from, join(outputDir, folder), {
    recursive: true,
    filter: (src) => !src.split('/').some((part) => part.startsWith('.') && part.length > 1),
  });
}

const shotNames = readdirSync(join(outputDir, 'screenshots')).filter((n) => !n.startsWith('.'));
if (shotNames.length < 3 || shotNames.length > 4) {
  fail(`screenshots/ must hold 3 or 4 images, found ${shotNames.length}`);
}

const dossier = buildDossier(outputDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 512 * 1024 },
  dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);

const watchCount = board.filter((r) => r.on_watchlist).length;
process.stdout.write(
  `token-radar: scanned ${snapshot.protocols.length} protocols, board holds ${board.length} rows ` +
    `(${watchCount}/${snapshot.watchlist.length} watchlist), top row ${board[0]!.name} at $${board[0]!.implied_value_usd}\n`,
);
