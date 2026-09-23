/**
 * Live Jev eval over the messy corpus: the bucket decision only.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... TYPESAFE_DEFAULT_MODEL=jev-1.13.0 bun run eval:jev
 *   EVAL_BASELINE=1 bun run eval:jev          # also re-run the Anthropic classifier
 *
 * Bun auto-loads .env. Hits the real APIs.
 *
 * What it measures, and why each knob exists:
 * - JEV_RUNS (default 3): the corpus is run N times so run-to-run agreement
 *   can be reported. Part II of the blog series claimed non-determinism as an
 *   LLM property; this is the test of that claim for a System One model.
 * - JEV_NOULS (default 1): also ask the three decision-order Nouls and derive
 *   a bucket from them in code. Secondary column; the Choice is the metric.
 * - EVAL_BASELINE (default 0): re-run the Anthropic classifier in the same
 *   harness. Runs BASELINE_RUNS times (default: same as JEV_RUNS) at
 *   concurrency 1, so per-call latency is comparable and not inflated by
 *   queuing. Token usage is captured so cost can be compared both ways.
 * - JEV_ADVERSARIAL (default 1): run the small adversarial fixture once and
 *   report it in its own block. Never mixed into the 20-row number.
 * - JEV_OUT (default eval-jev-results.json): JSON artifact path.
 *
 * Model pinning: the run aborts if the model id reported by TypeSafe changes
 * between calls, so a jev-latest rollover cannot masquerade as non-determinism.
 *
 * This is measurement, not a guard: there is no agreement floor. Exit code is
 * non-zero only when a call errored or the model changed mid-run.
 */
import { execSync } from 'node:child_process';
import { corpus, type CorpusEntry, type ExpectedClass } from '../tests/fixtures/raw-inputs';
import { adversarialCorpus } from '../tests/fixtures/adversarial-inputs';
import { createRealJevClient, type JevClient } from '../src/jev/client';
import { decideBucket, type JevDecision } from '../src/jev/triage';
import { BUCKETS, criteriaSha256, type Bucket, type NoulKey } from '../src/jev/questions';
import { classifyReportWithMeta, ClassifyError } from '../src/classifier/classify';
import { createRealClient, DEFAULT_MODEL, type MessagesUsage } from '../src/llm/client';

// ---------------------------------------------------------------------------
// Pricing. USD per token. Sources are cited so the blog post can too.
// ---------------------------------------------------------------------------

// docs.typesafe.ai/models: $42 per billion input tokens, output tokens free.
const JEV_USD_PER_INPUT_TOKEN = 42 / 1e9;

// platform.claude.com/docs/en/about-claude/pricing, read 2026-09-22.
// USD per million tokens. The classifier marks its system block with a
// 5-minute ephemeral cache_control, so cache writes use the 5m rate.
const ANTHROPIC_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; cacheWrite5m: number; cacheRead: number; output: number }
> = {
  'claude-sonnet-4-6': { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
};

// The three rows Part II of the blog series reported as Sonnet misses. Their
// Jev distributions are printed regardless of whether the baseline is re-run.
const PUBLISHED_BASELINE_MISSES = ['a-05', 'v-04', 'n-05'] as const;

const CONFIDENCE_THRESHOLDS = [0.6, 0.7, 0.8, 0.9] as const;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a positive integer, got ${raw}`);
    process.exit(2);
  }
  return n;
};
const envFlag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

const typesafeKey = process.env['TYPESAFE_API_KEY'];
if (!typesafeKey) {
  console.error('TYPESAFE_API_KEY is required for the Jev eval. Aborting.');
  process.exit(2);
}

const jevRuns = envInt('JEV_RUNS', 3);
const includeNouls = envFlag('JEV_NOULS', true);
const runAdversarial = envFlag('JEV_ADVERSARIAL', true);
const outPath = process.env['JEV_OUT'] ?? 'eval-jev-results.json';
const baselineEnabled = envFlag('EVAL_BASELINE', false);
const baselineRuns = envInt('BASELINE_RUNS', jevRuns);
const baselineModel = process.env['ANTHROPIC_MODEL'] ?? DEFAULT_MODEL;

const anthropicKey = process.env['ANTHROPIC_API_KEY'];
if (baselineEnabled && !anthropicKey) {
  console.error('EVAL_BASELINE=1 needs ANTHROPIC_API_KEY. Aborting.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Types for the artifact
// ---------------------------------------------------------------------------

interface JevRow {
  id: string;
  expected: ExpectedClass;
  choice: Bucket | null;
  agree: boolean;
  confidence: number | null;
  probabilities: Record<Bucket, number> | null;
  nouls?: Record<NoulKey, number>;
  derivedBucket?: Bucket;
  derivedAgree?: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  error?: string;
}

interface AdversarialRow extends JevRow {
  steersToward: ExpectedClass;
  /** True when the embedded instruction got its way. */
  moved: boolean;
}

interface BaselineRow {
  id: string;
  expected: ExpectedClass;
  got: ExpectedClass | null;
  agree: boolean;
  latencyMs: number;
  usage: MessagesUsage | null;
  error?: string;
}

interface LatencyStats {
  mean: number;
  median: number;
  p95: number;
  n: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const gitCommit = (): string | null => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const errorMessage = (e: unknown): string => {
  if (e instanceof ClassifyError) return `[${e.stage}] ${e.message}`;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
};

const latencyStats = (values: number[]): LatencyStats => {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx] ?? 0;
  };
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { mean, median: at(0.5), p95: at(0.95), n: sorted.length };
};

const fmtProb = (v: number): string =>
  v >= 0.995 ? '1.0' : `.${Math.round(v * 100).toString().padStart(2, '0')}`;

const fmtProbs = (p: Record<Bucket, number> | null): string =>
  p ? BUCKETS.map((b) => fmtProb(p[b])).join('/') : '-';

const fmtMs = (ms: number): string => Math.round(ms).toString();

const emptyConfusion = (): Record<Bucket, Record<Bucket, number>> => {
  const out = {} as Record<Bucket, Record<Bucket, number>>;
  for (const expected of BUCKETS) {
    out[expected] = {} as Record<Bucket, number>;
    for (const got of BUCKETS) out[expected][got] = 0;
  }
  return out;
};

const confusionOf = (rows: JevRow[]): Record<Bucket, Record<Bucket, number>> => {
  const m = emptyConfusion();
  for (const row of rows) {
    if (row.choice) m[row.expected][row.choice] += 1;
  }
  return m;
};

const confidenceDial = (rows: JevRow[]) =>
  CONFIDENCE_THRESHOLDS.map((threshold) => {
    const covered = rows.filter((r) => r.confidence !== null && r.confidence >= threshold);
    const agreed = covered.filter((r) => r.agree).length;
    return {
      threshold,
      covered: covered.length,
      coveredFraction: rows.length ? covered.length / rows.length : 0,
      agreementOnCovered: covered.length ? agreed / covered.length : null,
    };
  });

const bucketAbbrev = BUCKETS.map((b) => b[0]).join('/');

// ---------------------------------------------------------------------------
// Jev runs
// ---------------------------------------------------------------------------

let reportedModel: string | null = null;
let modelChanged = false;

const checkModel = (model: string): void => {
  if (reportedModel === null) {
    reportedModel = model;
  } else if (reportedModel !== model) {
    modelChanged = true;
    throw new Error(
      `Reported Jev model changed mid-run: ${reportedModel} -> ${model}. Pin TYPESAFE_DEFAULT_MODEL.`,
    );
  }
};

const toRow = (entry: CorpusEntry, decision: JevDecision): JevRow => ({
  id: entry.id,
  expected: entry.expectedClass,
  choice: decision.bucket,
  agree: decision.bucket === entry.expectedClass,
  confidence: decision.confidence,
  probabilities: decision.probabilities,
  ...(decision.nouls ? { nouls: decision.nouls } : {}),
  ...(decision.derivedBucket
    ? {
        derivedBucket: decision.derivedBucket,
        derivedAgree: decision.derivedBucket === entry.expectedClass,
      }
    : {}),
  latencyMs: decision.latencyMs,
  inputTokens: decision.usage.input_tokens,
  outputTokens: decision.usage.output_tokens,
  model: decision.model,
});

const errorRow = (entry: CorpusEntry, e: unknown, latencyMs: number): JevRow => ({
  id: entry.id,
  expected: entry.expectedClass,
  choice: null,
  agree: false,
  confidence: null,
  probabilities: null,
  latencyMs,
  inputTokens: 0,
  outputTokens: 0,
  model: null,
  error: errorMessage(e),
});

async function runJevOnce(
  entries: readonly CorpusEntry[],
  client: JevClient,
): Promise<JevRow[]> {
  const rows: JevRow[] = [];
  for (const entry of entries) {
    const started = performance.now();
    try {
      const decision = await decideBucket(entry.input, client, { includeNouls });
      checkModel(decision.model);
      const row = toRow(entry, decision);
      process.stderr.write(row.agree ? '.' : '!');
      rows.push(row);
    } catch (e) {
      process.stderr.write('x');
      rows.push(errorRow(entry, e, performance.now() - started));
      if (modelChanged) throw e;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const HEADER =
  `${'id'.padEnd(6)} ${'expected'.padEnd(36)} ${'got'.padEnd(36)} agree conf  probs(${bucketAbbrev})` +
  (includeNouls ? '  derived' : '') +
  '    ms   tok';

const printRow = (r: JevRow): void => {
  const marker = r.agree ? 'ok ' : '   ';
  const derived = includeNouls ? `  ${r.derivedAgree ? 'ok' : (r.derivedBucket ? '!!' : '-')}     ` : '';
  const line =
    `${marker}${r.id.padEnd(6)} ${r.expected.padEnd(36)} ${(r.choice ?? 'ERROR').padEnd(36)} ` +
    `${String(r.agree).padEnd(5)} ${r.confidence === null ? '  -  ' : r.confidence.toFixed(2)}  ` +
    `${fmtProbs(r.probabilities).padEnd(19)}${derived}${fmtMs(r.latencyMs).padStart(5)} ${String(r.inputTokens).padStart(5)}`;
  console.log(line);
  if (r.error) console.log(`       ${r.error}`);
};

const rowsDiffer = (a: JevRow, b: JevRow): boolean => {
  if (a.choice !== b.choice) return true;
  if (!a.probabilities || !b.probabilities) return a.probabilities !== b.probabilities;
  return BUCKETS.some((k) => a.probabilities![k] !== b.probabilities![k]);
};

const printConfusion = (m: Record<Bucket, Record<Bucket, number>>): void => {
  console.log(`\nConfusion matrix (rows = expected, cols = got), last run; cols in order ${bucketAbbrev}:`);
  for (const expected of BUCKETS) {
    const cells = BUCKETS.map((got) => String(m[expected][got]).padStart(3)).join(' ');
    console.log(`  ${expected.padEnd(36)} ${cells}`);
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const jev = createRealJevClient({ apiKey: typesafeKey });
const startedAt = new Date();

console.log(
  `Jev eval: ${corpus.length} reports x ${jevRuns} run${jevRuns === 1 ? '' : 's'}, ` +
    `requested model=${jev.requestedModel}, nouls=${includeNouls ? 'on' : 'off'}, ` +
    `criteria sha256=${criteriaSha256().slice(0, 12)}\n`,
);

const jevRunRows: JevRow[][] = [];
for (let run = 1; run <= jevRuns; run += 1) {
  process.stderr.write(`Jev run ${run}/${jevRuns} `);
  const rows = await runJevOnce(corpus, jev);
  process.stderr.write(' done.\n');
  jevRunRows.push(rows);

  const first = jevRunRows[0];
  if (run === 1 || !first) {
    console.log(`Run ${run}`);
    console.log(HEADER);
    console.log('-'.repeat(HEADER.length));
    for (const r of rows) printRow(r);
  } else {
    const changed = rows.filter((r, i) => {
      const prior = first[i];
      return prior ? rowsDiffer(prior, r) : true;
    });
    console.log(`\nRun ${run}: ${changed.length === 0 ? 'identical to run 1' : `${changed.length} row(s) differ from run 1`}`);
    for (const r of changed) printRow(r);
  }
}

const lastRun = jevRunRows[jevRunRows.length - 1] ?? [];
const allJevRows = jevRunRows.flat();
const okJevRows = allJevRows.filter((r) => !r.error);

// Repeatability
const changedRows: { id: string; choices: (Bucket | null)[]; maxDelta: number }[] = [];
let maxProbDelta = 0;
corpus.forEach((entry, i) => {
  const perRun = jevRunRows.map((rows) => rows[i]).filter((r): r is JevRow => r !== undefined);
  const choices = perRun.map((r) => r.choice);
  let rowMax = 0;
  for (const k of BUCKETS) {
    const values = perRun.map((r) => r.probabilities?.[k] ?? NaN).filter((v) => !Number.isNaN(v));
    if (values.length > 1) rowMax = Math.max(rowMax, Math.max(...values) - Math.min(...values));
  }
  maxProbDelta = Math.max(maxProbDelta, rowMax);
  if (new Set(choices).size > 1 || rowMax > 0) {
    changedRows.push({ id: entry.id, choices, maxDelta: rowMax });
  }
});
const identicalChoices = changedRows.every((c) => new Set(c.choices).size === 1);
const identicalProbabilities = changedRows.length === 0;

const agreementPerRun = jevRunRows.map((rows) => rows.filter((r) => r.agree).length);
const derivedAgreementPerRun = includeNouls
  ? jevRunRows.map((rows) => rows.filter((r) => r.derivedAgree).length)
  : null;
const jevLatency = latencyStats(okJevRows.map((r) => r.latencyMs));
const totalJevInput = okJevRows.reduce((a, r) => a + r.inputTokens, 0);
const totalJevOutput = okJevRows.reduce((a, r) => a + r.outputTokens, 0);
const jevCostPer1000 = okJevRows.length
  ? (totalJevInput / okJevRows.length) * 1000 * JEV_USD_PER_INPUT_TOKEN
  : null;
const confusionLastRun = confusionOf(lastRun);
const dial = confidenceDial(lastRun);

console.log('\nSummary');
console.log(
  `  agreement per run:          ${agreementPerRun.map((n) => `${n}/${corpus.length}`).join('  ')}`,
);
if (derivedAgreementPerRun) {
  console.log(
    `  derived-from-nouls per run: ${derivedAgreementPerRun.map((n) => `${n}/${corpus.length}`).join('  ')}`,
  );
}
console.log(
  `  repeatability:              choices identical across runs: ${identicalChoices}; ` +
    `probabilities identical: ${identicalProbabilities}; max abs prob delta: ${maxProbDelta.toFixed(4)}`,
);
if (changedRows.length) {
  for (const c of changedRows) {
    console.log(`    ${c.id}: ${c.choices.map((x) => x ?? 'ERROR').join(' | ')}  (max delta ${c.maxDelta.toFixed(4)})`);
  }
}
console.log(
  `  latency ms (n=${jevLatency.n}):        mean ${fmtMs(jevLatency.mean)}, median ${fmtMs(jevLatency.median)}, p95 ${fmtMs(jevLatency.p95)}`,
);
console.log(
  `  tokens:                     input ${totalJevInput}, output ${totalJevOutput} over ${okJevRows.length} calls`,
);
console.log(
  `  cost per 1,000 reports:     ${jevCostPer1000 === null ? 'n/a' : `$${jevCostPer1000.toFixed(4)}`} (input only; output is free)`,
);
console.log(`  reported model:             ${reportedModel ?? 'n/a'}`);

printConfusion(confusionLastRun);

console.log(`\nPublished baseline misses (${PUBLISHED_BASELINE_MISSES.join(', ')}), Jev distribution in last run:`);
for (const id of PUBLISHED_BASELINE_MISSES) {
  const r = lastRun.find((row) => row.id === id);
  if (!r) continue;
  console.log(
    `  ${id}  expected ${r.expected.padEnd(36)} got ${(r.choice ?? 'ERROR').padEnd(36)} conf ${r.confidence?.toFixed(2) ?? '-'}  probs ${fmtProbs(r.probabilities)}`,
  );
}

console.log('\nConfidence dial (last run): rows at or above threshold, and agreement on those rows');
for (const d of dial) {
  console.log(
    `  >= ${d.threshold.toFixed(1)}: ${String(d.covered).padStart(2)}/${lastRun.length} rows (${Math.round(d.coveredFraction * 100)}%), ` +
      `agreement ${d.agreementOnCovered === null ? 'n/a' : `${Math.round(d.agreementOnCovered * 100)}%`}`,
  );
}

// Adversarial block
let adversarialRows: AdversarialRow[] = [];
if (runAdversarial) {
  process.stderr.write('Adversarial fixture ');
  const rows = await runJevOnce(adversarialCorpus, jev);
  process.stderr.write(' done.\n');
  adversarialRows = rows.map((row, i) => {
    const entry = adversarialCorpus[i];
    const steersToward = entry?.steersToward ?? row.expected;
    return {
      ...row,
      steersToward,
      moved: row.choice !== null && row.choice !== row.expected && row.choice === steersToward,
    };
  });
  console.log('\nAdversarial state (not part of the agreement number):');
  for (const r of adversarialRows) {
    console.log(
      `  ${r.id}  expected ${r.expected.padEnd(36)} steers toward ${r.steersToward.padEnd(36)} got ${(r.choice ?? 'ERROR').padEnd(36)} ` +
        `conf ${r.confidence?.toFixed(2) ?? '-'}  moved=${r.moved}`,
    );
  }
}

// Baseline
let baselineRunRows: BaselineRow[][] = [];
let baselineSummary: Record<string, unknown> | null = null;
if (baselineEnabled && anthropicKey) {
  const anthropic = createRealClient(anthropicKey);
  const pricing = ANTHROPIC_PRICING_USD_PER_MTOK[baselineModel] ?? null;
  console.log(
    `\nBaseline: ${corpus.length} reports x ${baselineRuns} run${baselineRuns === 1 ? '' : 's'}, model=${baselineModel}, concurrency=1` +
      (pricing ? '' : ` (no pricing table for ${baselineModel}; cost will be n/a)`),
  );
  for (let run = 1; run <= baselineRuns; run += 1) {
    process.stderr.write(`Baseline run ${run}/${baselineRuns} `);
    const rows: BaselineRow[] = [];
    for (const entry of corpus) {
      const started = performance.now();
      try {
        const out = await classifyReportWithMeta(entry.id, entry.input, anthropic, {
          model: baselineModel,
        });
        const agree = out.report.classification === entry.expectedClass;
        process.stderr.write(agree ? '.' : '!');
        rows.push({
          id: entry.id,
          expected: entry.expectedClass,
          got: out.report.classification,
          agree,
          latencyMs: out.latencyMs,
          usage: out.usage ?? null,
        });
      } catch (e) {
        process.stderr.write('x');
        rows.push({
          id: entry.id,
          expected: entry.expectedClass,
          got: null,
          agree: false,
          latencyMs: performance.now() - started,
          usage: null,
          error: errorMessage(e),
        });
      }
    }
    process.stderr.write(' done.\n');
    baselineRunRows.push(rows);
  }

  const lastBaseline = baselineRunRows[baselineRunRows.length - 1] ?? [];
  const okBaseline = baselineRunRows.flat().filter((r) => !r.error);
  const baselineAgreementPerRun = baselineRunRows.map((rows) => rows.filter((r) => r.agree).length);
  const baselineChanged = corpus
    .map((entry, i) => ({
      id: entry.id,
      gots: baselineRunRows.map((rows) => rows[i]?.got ?? null),
    }))
    .filter((c) => new Set(c.gots).size > 1);
  const baselineLatency = latencyStats(okBaseline.map((r) => r.latencyMs));
  const sum = (pick: (u: MessagesUsage) => number | null | undefined): number =>
    okBaseline.reduce((a, r) => a + (r.usage ? (pick(r.usage) ?? 0) : 0), 0);
  const tokens = {
    input: sum((u) => u.input_tokens),
    cacheWrite: sum((u) => u.cache_creation_input_tokens),
    cacheRead: sum((u) => u.cache_read_input_tokens),
    output: sum((u) => u.output_tokens),
  };
  const baselineCostTotal = pricing
    ? (tokens.input * pricing.input +
        tokens.cacheWrite * pricing.cacheWrite5m +
        tokens.cacheRead * pricing.cacheRead +
        tokens.output * pricing.output) /
      1e6
    : null;
  const baselineCostPer1000 =
    baselineCostTotal !== null && okBaseline.length
      ? (baselineCostTotal / okBaseline.length) * 1000
      : null;
  const baselineMisses = lastBaseline.filter((r) => !r.agree).map((r) => r.id);

  console.log(`\n${'id'.padEnd(6)} ${'expected'.padEnd(36)} ${'anthropic'.padEnd(36)} ${'jev'.padEnd(36)}`);
  console.log('-'.repeat(118));
  corpus.forEach((entry, i) => {
    const a = lastBaseline[i]?.got ?? 'ERROR';
    const j = lastRun[i]?.choice ?? 'ERROR';
    const marks = `${a === entry.expectedClass ? 'A' : ' '}${j === entry.expectedClass ? 'J' : ' '}`;
    console.log(`${marks} ${entry.id.padEnd(4)} ${entry.expectedClass.padEnd(36)} ${a.padEnd(36)} ${j.padEnd(36)}`);
  });

  console.log('\nBaseline summary');
  console.log(
    `  agreement per run:      ${baselineAgreementPerRun.map((n) => `${n}/${corpus.length}`).join('  ')}` +
      `   (Jev: ${agreementPerRun.map((n) => `${n}/${corpus.length}`).join('  ')})`,
  );
  console.log(`  misses in last run:     ${baselineMisses.join(', ') || 'none'}`);
  console.log(
    `  run-to-run changes:     ${baselineChanged.length === 0 ? 'none' : baselineChanged.map((c) => `${c.id}(${c.gots.map((g) => g ?? 'ERROR').join('|')})`).join(', ')}`,
  );
  console.log(
    `  latency ms (n=${baselineLatency.n}):    mean ${fmtMs(baselineLatency.mean)}, median ${fmtMs(baselineLatency.median)}, p95 ${fmtMs(baselineLatency.p95)}` +
      `   (Jev: mean ${fmtMs(jevLatency.mean)}, median ${fmtMs(jevLatency.median)}, p95 ${fmtMs(jevLatency.p95)})`,
  );
  console.log(
    `  tokens:                 input ${tokens.input}, cache write ${tokens.cacheWrite}, cache read ${tokens.cacheRead}, output ${tokens.output} over ${okBaseline.length} calls`,
  );
  console.log(
    `  cost per 1,000 reports: ${baselineCostPer1000 === null ? 'n/a' : `$${baselineCostPer1000.toFixed(4)}`}` +
      `   (Jev: ${jevCostPer1000 === null ? 'n/a' : `$${jevCostPer1000.toFixed(4)}`})`,
  );

  baselineSummary = {
    agreementPerRun: baselineAgreementPerRun,
    missesLastRun: baselineMisses,
    identicalChoices: baselineChanged.length === 0,
    changedRows: baselineChanged,
    latencyMs: baselineLatency,
    tokens,
    estimatedCostUsdTotal: baselineCostTotal,
    estimatedCostUsdPer1000Reports: baselineCostPer1000,
  };
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

const artifact = {
  meta: {
    generatedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    requestedModel: jev.requestedModel,
    reportedModel,
    criteriaCommit: gitCommit(),
    criteriaSha256: criteriaSha256(),
    runs: jevRuns,
    corpusSize: corpus.length,
    includeNouls,
    pricing: {
      jevUsdPerInputToken: JEV_USD_PER_INPUT_TOKEN,
      jevSource: 'https://docs.typesafe.ai/models',
      anthropicUsdPerMTok: ANTHROPIC_PRICING_USD_PER_MTOK[baselineModel] ?? null,
      anthropicSource: 'https://platform.claude.com/docs/en/about-claude/pricing',
    },
    baseline: {
      enabled: baselineEnabled,
      model: baselineEnabled ? baselineModel : null,
      runs: baselineEnabled ? baselineRuns : 0,
      concurrency: 1,
    },
  },
  jev: {
    runs: jevRunRows.map((rows, i) => ({ run: i + 1, rows })),
    summary: {
      agreementPerRun,
      derivedAgreementPerRun,
      identicalChoices,
      identicalProbabilities,
      maxProbDelta,
      changedRows,
      latencyMs: jevLatency,
      totalInputTokens: totalJevInput,
      totalOutputTokens: totalJevOutput,
      estimatedCostUsdPer1000Reports: jevCostPer1000,
      confusionLastRun,
      publishedBaselineMisses: PUBLISHED_BASELINE_MISSES.map((id) => lastRun.find((r) => r.id === id) ?? null),
      confidenceDial: dial,
      adversarial: adversarialRows,
    },
  },
  ...(baselineEnabled
    ? {
        baseline: {
          runs: baselineRunRows.map((rows, i) => ({ run: i + 1, rows })),
          summary: baselineSummary,
        },
      }
    : {}),
};

await Bun.write(outPath, JSON.stringify(artifact, null, 2) + '\n');
console.log(`\nArtifact written to ${outPath}`);

const errored = allJevRows.some((r) => r.error) || baselineRunRows.flat().some((r) => r.error);
if (modelChanged || errored) {
  console.error(modelChanged ? 'Model changed mid-run.' : 'One or more calls errored.');
  process.exit(1);
}
