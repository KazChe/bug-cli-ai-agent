import { z } from 'zod';
import { classifyReport, ClassifyError } from './classify';
import type { AnthropicClient } from './llm-client';
import type { ParsedReport } from './schema';

export interface RunOptions {
  concurrency?: number;
  model?: string;
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
  const concurrency = options.concurrency ?? 5;
  return runWithConcurrency(inputs, concurrency, async (input, index) => {
    const reportId = `report-${index}`;
    try {
      const result = await classifyReport(reportId, input, client, {
        ...(options.model ? { model: options.model } : {}),
      });
      return result satisfies OutputEntry;
    } catch (e) {
      const stage = e instanceof ClassifyError ? e.stage : 'unknown';
      const message = e instanceof Error ? e.message : String(e);
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
