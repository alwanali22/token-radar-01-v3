import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateImpliedValue,
  fitSizeCurve,
  generateFarmSteps,
  ageDays,
  rankable,
  categoryMedians,
  convictionLegs,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(): void {
  const inputArg = arg('input', '/input');
  const inputPath = inputArg.endsWith('snapshot.json')
    ? inputArg
    : join(inputArg, 'snapshot.json');
  const outputBase = arg('output', process.env.MAKEFUN_OUTPUT_DIR || '/output');

  if (!existsSync(inputPath)) {
    fail(`Error: input not found: ${inputPath}`);
  }

  let snapshot: any;
  try {
    snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (error) {
    fail(`Error: invalid snapshot JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { protocols, watchlist, as_of } = snapshot;
  if (
    !Array.isArray(protocols) ||
    !Array.isArray(watchlist) ||
    typeof as_of !== 'string' ||
    protocols.some((p: any) =>
      !p ||
      typeof p.slug !== 'string' ||
      typeof p.name !== 'string' ||
      typeof p.category !== 'string' && p.category !== null ||
      !Array.isArray(p.chains) ||
      typeof p.tvl_usd !== 'number'
    )
  ) {
    fail('Error: snapshot is missing valid protocols, watchlist, or as_of data');
  }

  const curve = fitSizeCurve(
    protocols.filter(
      (p: any) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
    ),
  );

  const watchlistProtocols = protocols.filter(
    (p: any) => watchlist.includes(p.slug) && rankable(p),
  );
  const otherRankable = protocols.filter(
    (p: any) => !watchlist.includes(p.slug) && rankable(p),
  );
  const excluded = protocols.filter(
    (p: any) =>
      p.mcap_usd === null &&
      p.gecko_id === null &&
      p.symbol === null &&
      !rankable(p),
  ).length;

  const liveForMedians = protocols.filter(
    (p: any) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const medians = categoryMedians(liveForMedians);

  const allRows = [...watchlistProtocols, ...otherRankable]
    .map((p: any) => {
      const factors = calculateImpliedValue(p, as_of, curve);
      return {
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        age_days: ageDays(as_of, p.listed_at),
        watchlist: watchlist.includes(p.slug),
        rank: 0,
        implied_value_usd: factors.implied,
        size_multiple: factors.sizeMultiple,
        growth_mult: factors.growthMult,
        maturity_mult: factors.maturityMult,
        farm_steps: generateFarmSteps(p, as_of),
      };
    })
    .sort(
      (a: any, b: any) =>
        b.implied_value_usd - a.implied_value_usd ||
        a.slug.localeCompare(b.slug),
    )
    .map((row: any, index: number) => ({ ...row, rank: index + 1 }));

  const logTvls = allRows.map((row: any) => Math.log10(row.tvl_usd));
  const logMin = Math.min(...logTvls);
  const logMax = Math.max(...logTvls);
  for (const row of allRows) {
    const legs = convictionLegs(
      {
        slug: row.slug,
        name: row.name,
        category: row.category,
        chains: row.chains,
        tvl_usd: row.tvl_usd,
        change_7d: row.change_7d,
        mcap_usd: null,
        listed_at: null,
        gecko_id: null,
        symbol: null,
      },
      row.age_days,
      row.size_multiple,
      logMin,
      logMax,
      medians,
    );
    row.conviction = legs.total;
    row.conviction_legs = legs;
    const entry = row.category === null ? undefined : medians.get(row.category);
    row.cat_median = entry ? entry.median : null;
    row.cat_peers = entry ? entry.peers : 0;
  }

  if (allRows.length < 100) fail(`Too few rows: ${allRows.length}`);

  const watchlistSlugs = new Set(
    allRows.filter((row: any) => row.watchlist).map((row: any) => row.slug),
  );
  if (
    watchlist.length !== 40 ||
    watchlistSlugs.size !== 40 ||
    !watchlist.every((slug: string) => watchlistSlugs.has(slug))
  ) {
    fail('Invalid watchlist coverage: expected 40 of 40');
  }

  if (allRows.some((row: any, index: number) => row.rank !== index + 1)) {
    fail('Invalid ranks');
  }

  for (let i = 0; i < allRows.length - 1; i++) {
    if (allRows[i].implied_value_usd < allRows[i + 1].implied_value_usd) {
      fail('Implied value not monotonic');
    }
  }

  if (
    allRows.some(
      (row: any) =>
        !Array.isArray(row.farm_steps) ||
        row.farm_steps.length !== 6 ||
        row.farm_steps.some(
          (step: unknown) =>
            typeof step !== 'string' || step.length < 20 || step.length > 600,
        ),
    )
  ) {
    fail('Invalid farm steps');
  }

  const liveAll = protocols
    .filter(
      (p: any) =>
        p.mcap_usd !== null &&
        p.mcap_usd > 0 &&
        p.tvl_usd > 0,
    )
    .map((p: any) => ({
      slug: p.slug,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      category: p.category,
    }));

  const liveProtocols = protocols
    .filter(
      (p: any) =>
        typeof p.mcap_usd === 'number' &&
        Number.isFinite(p.mcap_usd) &&
        p.mcap_usd > 0,
    )
    .sort((a: any, b: any) => b.mcap_usd - a.mcap_usd);
  const liveForData = liveProtocols.slice(0, 24);
  if (liveForData.length !== 24) {
    fail(`Live list not 24: ${liveForData.length}`);
  }

  const slugs = new Set(allRows.map((row: any) => row.slug));
  if (slugs.size !== allRows.length) fail('Duplicate slugs');

  const categoryRows = new Map<string, number>();
  for (const row of allRows) {
    if (row.category === null) continue;
    categoryRows.set(row.category, (categoryRows.get(row.category) ?? 0) + 1);
  }
  const categories = [...categoryRows.entries()]
    .map(([category, board_rows]) => {
      const entry = medians.get(category);
      return {
        category,
        board_rows,
        live_peers: entry ? entry.peers : 0,
        median_multiple: entry ? entry.median : null,
      };
    })
    .sort(
      (a, b) => b.board_rows - a.board_rows || a.category.localeCompare(b.category),
    );

  mkdirSync(outputBase, { recursive: true });
  writeFileSync(
    join(outputBase, 'board.json'),
    JSON.stringify({ rows: allRows.slice(0, 250) }, null, 2),
  );

  writeFileSync(
    join(outputBase, 'data.js'),
    `window.RADAR = ${JSON.stringify(
      {
        rows: allRows.slice(0, 250),
        live: liveForData,
        liveAll: liveAll,
        model: {
          as_of,
          formula: 'TVL * sizeMultiple(TVL) * 0.75 * growthMult * maturityMult',
          curve: {
            intercept: curve.intercept,
            slope: curve.slope,
            n: curve.n,
            clampMin: curve.clampMin,
            clampMax: curve.clampMax,
          },
          haircut: 0.75,
          conviction: {
            formula:
              'scale (25) + momentum (20) + maturity (20) + peers (20) + agreement (15)',
            legs: [
              {
                name: 'scale',
                weight: 25,
                description:
                  '25 * (log10(TVL) - logMin) / (logMax - logMin) over the board rows; bigger TVL means more live comps nearby in size, so a tighter multiple estimate.',
              },
              {
                name: 'momentum',
                weight: 20,
                description:
                  'change_7d clamped to [-30, +30]: round(10 + change / 3); null change_7d scores 10.',
              },
              {
                name: 'maturity',
                weight: 20,
                description:
                  'round(20 * min(age_days ?? 365, 1095) / 1095); longer-running protocols score higher.',
              },
              {
                name: 'peers',
                weight: 20,
                description:
                  'Live peers (mcap > 0, tvl > 0) in the row category: 0 -> 0, 1-2 -> 7, 3-5 -> 13, 6+ -> 20.',
              },
              {
                name: 'agreement',
                weight: 15,
                description:
                  'd = |log10(row sizeMultiple) - log10(category median multiple)|: d <= 0.10 -> 15, <= 0.25 -> 11, <= 0.40 -> 7, else 3; no category peers -> 8.',
              },
            ],
          },
          categories,
        },
        counts: {
          total: protocols.length,
          watchlist: watchlist.length,
          board: allRows.length,
          early: otherRankable.length,
          live: liveForData.length,
          excluded,
        },
      },
      null,
      2,
    )};`,
  );

  ['dashboard', 'screenshots'].forEach((dir) => {
    const fromDir = join(here, dir);
    const toDir = join(outputBase, dir);
    mkdirSync(toDir, { recursive: true });
    if (!existsSync(fromDir)) return;

    readdirSync(fromDir).forEach((file) => {
      if (file.startsWith('.')) return;
      const filePath = join(fromDir, file);
      if (statSync(filePath).isFile()) {
        copyFileSync(filePath, join(toDir, file));
      }
    });
  });

  writeFileSync(
    join(outputBase, 'dossier.json'),
    buildDossier(outputBase, { text_max_bytes: 65536 }),
  );
}

run();
