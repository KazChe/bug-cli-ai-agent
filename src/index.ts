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
import { runCli, CliInputError, resolveInputSource } from './cli';
import { createRealClient, DEFAULT_MODEL } from './llm-client';
import { ClassifyError } from './classify';

async function readInput(args: string[]): Promise<string> {
  const source = resolveInputSource(args, Boolean(process.stdin.isTTY));
  if (source.kind === 'usage') {
    process.stderr.write(`No input given.\n\n${source.message}\n`);
    process.exit(2);
  }
  if (source.kind === 'file') {
    const file = Bun.file(source.path);
    if (!(await file.exists())) {
      throw new CliInputError(`Input file not found: ${source.path}`);
    }
    return await file.text();
  }
  process.stderr.write('Reading from stdin...\n');
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
  const effectiveModel = model ?? DEFAULT_MODEL;
  const effectiveConcurrency = concurrency ?? 5;

  // Progress goes to stderr so stdout stays a clean JSON array (pipeable to jq, etc.).
  const onStart = (total: number) => {
    if (total === 0) {
      process.stderr.write('No inputs to classify.\n');
      return;
    }
    process.stderr.write(
      `Classifying ${total} report${total === 1 ? '' : 's'} against model=${effectiveModel} ` +
        `(concurrency=${effectiveConcurrency}). Each entry typically takes 3-15s.\n`,
    );
  };
  const onTick = () => {
    process.stderr.write('.');
  };

  const results = await runCli(raw, client, {
    ...(model ? { model } : {}),
    ...(concurrency ? { concurrency } : {}),
    onStart,
    onTick,
  });
  if (results.length > 0) process.stderr.write(' done.\n');
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
