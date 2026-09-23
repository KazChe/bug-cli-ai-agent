import { z } from 'zod';
import {
  classifyReport,
  classifyReportHybrid,
  ClassifyError,
} from '../classifier/classify';
import type { AnthropicClient } from '../llm/client';
import type { JevClient } from '../jev/client';
import { BUCKETS, type Bucket } from '../jev/questions';
import type { ParsedReport } from '../schema/parsed-report';

export type Engine = 'anthropic' | 'jev';
export const ENGINES: readonly Engine[] = ['anthropic', 'jev'];

export interface RunOptions {
  concurrency?: number;
  model?: string;
  /** Default 'anthropic'. 'jev' requires the jev client. */
  engine?: Engine;
  jev?: JevClient;
  onStart?: (total: number) => void;
  onTick?: (completed: number, total: number) => void;
}

export interface ErrorEntry {
  classification: 'error';
  report_id: string;
  original_input: string;
  error: { stage: string; message: string };
}

export type OutputEntry = ParsedReport | ErrorEntry;

const InputSchema = z.array(z.string());

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

export const USAGE = `Usage:
  bun run cli <path-to-input.json>
  cat input.json | bun run cli
  echo '["raw bug report", "..."]' | bun run cli
  bun run cli --engine jev <path-to-input.json>

Input must be a JSON array of strings. A demo input lives at tests/fixtures/example-input.json

Engines:
  anthropic  (default) one Anthropic tool-use call decides the bucket and drafts the fields
  jev        Jev decides the bucket; Anthropic drafts only actionable and partial tickets
             (needs TYPESAFE_API_KEY as well as ANTHROPIC_API_KEY)`;

export interface CliArgs {
  engine: Engine;
  /** Everything that was not an --engine flag, in order. */
  rest: string[];
}

/**
 * Pure argv parser. Pulls out --engine <name> / --engine=<name> so the rest
 * can go to resolveInputSource unchanged.
 */
export function parseCliArgs(
  argv: readonly string[],
  defaultEngine: Engine = 'anthropic',
): CliArgs {
  let engine: Engine = defaultEngine;
  const rest: string[] = [];
  const setEngine = (value: string | undefined): void => {
    if (value === undefined || !ENGINES.includes(value as Engine)) {
      throw new CliInputError(
        `--engine must be one of ${ENGINES.join(', ')}; got ${value ?? '(nothing)'}`,
      );
    }
    engine = value as Engine;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--engine') {
      setEngine(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--engine=')) {
      setEngine(arg.slice('--engine='.length));
    } else {
      rest.push(arg);
    }
  }
  return { engine, rest };
}

export type InputSource =
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }
  | { kind: 'usage'; message: string };

/**
 * Pure decision function: where should the CLI read input from?
 *
 * Extracted from src/index.ts so we can unit-test the source-resolution rules
 * without touching process.stdin or process.exit. The real entry function in
 * index.ts calls this and dispatches accordingly.
 */
export function resolveInputSource(
  args: readonly string[],
  isStdinTty: boolean,
): InputSource {
  const firstArg = args[0];
  if (firstArg !== undefined && firstArg.length > 0) {
    return { kind: 'file', path: firstArg };
  }
  if (isStdinTty) {
    return { kind: 'usage', message: USAGE };
  }
  return { kind: 'stdin' };
}

export function parseInput(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliInputError(
      `Input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = InputSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
      .slice(0, 500);
    throw new CliInputError(
      `Input must be a JSON array of strings. ${detail}`,
    );
  }
  return result.data;
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
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
        results[i] = await fn(item, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function runCli(
  rawInput: string,
  client: AnthropicClient,
  options: RunOptions = {},
): Promise<OutputEntry[]> {
  const engine = options.engine ?? 'anthropic';
  const jev = options.jev;
  if (engine === 'jev' && !jev) {
    throw new CliInputError('engine "jev" requires a Jev client');
  }

  const inputs = parseInput(rawInput);
  const total = inputs.length;
  options.onStart?.(total);

  const concurrency = options.concurrency ?? 5;
  const classifyOptions = {
    ...(options.model ? { model: options.model } : {}),
  };
  let completed = 0;
  return runWithConcurrency(inputs, concurrency, async (input, index) => {
    const reportId = `report-${index}`;
    try {
      const result =
        engine === 'jev' && jev
          ? (await classifyReportHybrid(reportId, input, jev, client, classifyOptions)).report
          : await classifyReport(reportId, input, client, classifyOptions);
      completed += 1;
      options.onTick?.(completed, total);
      return result satisfies OutputEntry;
    } catch (e) {
      const stage = e instanceof ClassifyError ? e.stage : 'unknown';
      const message = e instanceof Error ? e.message : String(e);
      completed += 1;
      options.onTick?.(completed, total);
      const entry: ErrorEntry = {
        classification: 'error',
        report_id: reportId,
        original_input: input,
        error: { stage, message },
      };
      return entry;
    }
  });
}

export interface BatchSummary {
  total: number;
  errors: number;
  /** Entries that carry a triage block, i.e. went through the jev engine. */
  triaged: number;
  routed: Record<Bucket, number>;
  llmCalls: number;
  llmSkipped: number;
  /** Error entries whose stage is bucket_mismatch: the LLM tried to override the pinned bucket. */
  bucketMismatches: number;
}

/** Pure summary over a finished batch. Only informative for the jev engine. */
export function summarizeBatch(entries: readonly OutputEntry[]): BatchSummary {
  const routed = {} as Record<Bucket, number>;
  for (const b of BUCKETS) routed[b] = 0;
  const summary: BatchSummary = {
    total: entries.length,
    errors: 0,
    triaged: 0,
    routed,
    llmCalls: 0,
    llmSkipped: 0,
    bucketMismatches: 0,
  };
  for (const entry of entries) {
    if (entry.classification === 'error') {
      summary.errors += 1;
      if (entry.error.stage === 'bucket_mismatch') summary.bucketMismatches += 1;
      continue;
    }
    if (!entry.triage) continue;
    summary.triaged += 1;
    summary.routed[entry.triage.bucket] += 1;
    if (entry.triage.llm_called) summary.llmCalls += 1;
    else summary.llmSkipped += 1;
  }
  return summary;
}

export function formatBatchSummary(s: BatchSummary): string {
  const routed = BUCKETS.map((b) => `${b}=${s.routed[b]}`).join(', ');
  return [
    `Triage summary: ${s.triaged} routed by Jev (${routed})`,
    `LLM calls: ${s.llmCalls} made, ${s.llmSkipped} skipped`,
    `Errors: ${s.errors} (bucket_mismatch: ${s.bucketMismatches})`,
  ].join('\n');
}
