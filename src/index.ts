/**
 * CLI entry — reads a JSON array of raw bug-report strings from stdin or a file
 * path argument, classifies each via Anthropic tool-use, prints a JSON array of
 * results (or error envelopes) to stdout.
 *
 * Usage:
 *   bun run cli input.json
 *   cat input.json | bun run cli
 *
 * Requires ANTHROPIC_API_KEY in env (or .env, auto-loaded by Bun).
 */
import { runCli, CliInputError } from './cli';
import { createRealClient } from './llm-client';
import { ClassifyError } from './classify';

async function readInput(args: string[]): Promise<string> {
  if (args.length > 0 && args[0]) {
    const file = Bun.file(args[0]);
    if (!(await file.exists())) {
      throw new CliInputError(`Input file not found: ${args[0]}`);
    }
    return await file.text();
  }
  return await Bun.stdin.text();
}

async function main(): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.error(
      'ANTHROPIC_API_KEY is required. Set it in your environment or .env file.',
    );
    process.exit(2);
  }
  const client = createRealClient(apiKey);

  const args = process.argv.slice(2);
  const raw = await readInput(args);
  if (!raw.trim()) {
    console.error(
      'No input received. Pipe a JSON array to stdin or pass a file path.',
    );
    process.exit(2);
  }

  const model = process.env['ANTHROPIC_MODEL'];
  const concurrencyEnv = process.env['CLI_CONCURRENCY'];
  const concurrency = concurrencyEnv ? Number(concurrencyEnv) : undefined;

  const results = await runCli(raw, client, {
    ...(model ? { model } : {}),
    ...(concurrency ? { concurrency } : {}),
  });
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

main().catch((err) => {
  if (err instanceof CliInputError) {
    console.error(`Input error: ${err.message}`);
    process.exit(2);
  }
  if (err instanceof ClassifyError) {
    console.error(`Classify error [${err.stage}]: ${err.message}`);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
