import { z } from 'zod';
import { classifyReport, ClassifyError } from './classify';
import type { AnthropicClient } from './llm-client';
import type { ParsedReport } from './schema';

export interface RunOptions {
  concurrency?: number;
  model?: string;
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

Input must be a JSON array of strings. A demo input lives at tests/fixtures/example-input.json`;

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
  const inputs = parseInput(rawInput);
  const total = inputs.length;
  options.onStart?.(total);

  const concurrency = options.concurrency ?? 5;
  let completed = 0;
  return runWithConcurrency(inputs, concurrency, async (input, index) => {
    const reportId = `report-${index}`;
    try {
      const result = await classifyReport(reportId, input, client, {
        ...(options.model ? { model: options.model } : {}),
      });
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
