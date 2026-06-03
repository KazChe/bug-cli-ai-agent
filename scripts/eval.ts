/**
 * Live LLM eval over the messy corpus.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run eval
 *   ANTHROPIC_API_KEY=sk-... ANTHROPIC_MODEL=claude-haiku-4-5 bun run eval
 *
 * Bun auto-loads .env / .env.local — no dotenv import needed.
 *
 * Hits the real API. Prints per-entry classification + agreement with the
 * corpus's expectedClass label, then a summary. Exits non-zero if overall
 * agreement is below AGREEMENT_THRESHOLD.
 *
 * This is NOT a unit test: the corpus labels are engineer judgment; the LLM may
 * legitimately disagree. The eval surfaces disagreement rather than asserts
 * agreement, but a hard floor (default 70%) catches the case where something
 * is broken (prompt regression, schema mismatch).
 */
import { ZodError } from 'zod';
import { classifyReport, ClassifyError } from '../src/classifier/classify';
import { createRealClient, DEFAULT_MODEL } from '../src/llm/client';
import { corpus } from '../tests/fixtures/raw-inputs';

const AGREEMENT_THRESHOLD = 0.7;
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 5);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is required for eval. Aborting.');
  process.exit(2);
}
const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
const client = createRealClient(apiKey);

console.log(
  `Eval running ${corpus.length} reports against model=${model} (concurrency=${CONCURRENCY})\n`,
);

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        const item = items[i];
        if (item === undefined) return;
        results[i] = await fn(item);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface Row {
  id: string;
  expected: string;
  got: string | 'ERROR';
  agree: boolean;
  errStage?: string;
  errMsg?: string;
}

const start = Date.now();
// Progress goes to stderr so a redirected stdout (`bun run eval > out.txt`)
// stays clean. Dot for agreement, ! for disagreement, x for error.
const rows: Row[] = await runWithConcurrency(corpus, CONCURRENCY, async (entry) => {
  try {
    const out = await classifyReport(entry.id, entry.input, client, { model });
    const agree = out.classification === entry.expectedClass;
    process.stderr.write(agree ? '.' : '!');
    return {
      id: entry.id,
      expected: entry.expectedClass,
      got: out.classification,
      agree,
    };
  } catch (e) {
    process.stderr.write('x');
    if (e instanceof ClassifyError) {
      const detail =
        e.cause instanceof ZodError
          ? e.cause.issues
              .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
              .join('; ')
          : '';
      return {
        id: entry.id,
        expected: entry.expectedClass,
        got: 'ERROR' as const,
        agree: false,
        errStage: e.stage,
        errMsg: detail ? `${e.message}, ${detail}` : e.message,
      };
    }
    return {
      id: entry.id,
      expected: entry.expectedClass,
      got: 'ERROR' as const,
      agree: false,
      errMsg: e instanceof Error ? e.message : String(e),
    };
  }
});
process.stderr.write(' done.\n');

const agreeCount = rows.filter((r) => r.agree).length;
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(
  'id     expected                              got                                   agree',
);
console.log(
  '-------------------------------------------------------------------------------------------',
);
for (const r of rows) {
  const marker = r.agree ? 'ok ' : '   ';
  const errSuffix = r.errMsg
    ? `\n       [${r.errStage ?? 'error'}] ${r.errMsg}`
    : '';
  console.log(
    `${marker}${r.id.padEnd(6)} ${r.expected.padEnd(38)} ${r.got.padEnd(38)} ${r.agree}${errSuffix}`,
  );
}

const rate = agreeCount / corpus.length;
console.log(
  `\nAgreement: ${agreeCount}/${corpus.length} (${(rate * 100).toFixed(1)}%) in ${elapsed}s on model=${model}`,
);

if (rate < AGREEMENT_THRESHOLD) {
  console.error(
    `Agreement below floor ${(AGREEMENT_THRESHOLD * 100).toFixed(0)}%`,
  );
  process.exit(1);
}
