/**
 * CLI entry: reads a JSON array of raw bug-report strings from stdin or a file
 * path argument, classifies each, prints a JSON array of results (or error
 * envelopes) to stdout.
 *
 * Usage:
 *   bun run cli input.json
 *   cat input.json | bun run cli
 *   bun run cli --engine jev input.json
 *
 * Requires ANTHROPIC_API_KEY in env (or .env, auto-loaded by Bun).
 * --engine jev (or CLI_ENGINE=jev) also requires TYPESAFE_API_KEY.
 */
import {
  runCli,
  CliInputError,
  parseCliArgs,
  resolveInputSource,
  summarizeBatch,
  formatBatchSummary,
  type Engine,
} from './cli/runner';
import { createRealClient, DEFAULT_MODEL } from './llm/client';
import { createRealJevClient, type JevClient } from './jev/client';
import { ClassifyError } from './classifier/classify';

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

function defaultEngineFromEnv(): Engine {
  const raw = process.env['CLI_ENGINE'];
  if (raw === undefined || raw === '') return 'anthropic';
  if (raw !== 'anthropic' && raw !== 'jev') {
    console.error(`CLI_ENGINE must be anthropic or jev, got ${raw}`);
    process.exit(2);
  }
  return raw;
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

  const { engine, rest: args } = parseCliArgs(
    process.argv.slice(2),
    defaultEngineFromEnv(),
  );

  let jev: JevClient | undefined;
  if (engine === 'jev') {
    const typesafeKey = process.env['TYPESAFE_API_KEY'];
    if (!typesafeKey) {
      console.error(
        'TYPESAFE_API_KEY is required for --engine jev. Set it in your environment or .env file.',
      );
      process.exit(2);
    }
    jev = createRealJevClient({ apiKey: typesafeKey });
  }

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
    const engineNote =
      engine === 'jev'
        ? `engine=jev (triage model=${jev?.requestedModel ?? 'jev-latest'}, drafting model=${effectiveModel})`
        : `model=${effectiveModel}`;
    process.stderr.write(
      `Classifying ${total} report${total === 1 ? '' : 's'} against ${engineNote} ` +
        `(concurrency=${effectiveConcurrency}). Each entry typically takes 3-15s.\n`,
    );
  };
  const onTick = () => {
    process.stderr.write('.');
  };

  const results = await runCli(raw, client, {
    ...(model ? { model } : {}),
    ...(concurrency ? { concurrency } : {}),
    engine,
    ...(jev ? { jev } : {}),
    onStart,
    onTick,
  });
  if (results.length > 0) process.stderr.write(' done.\n');
  if (engine === 'jev' && results.length > 0) {
    process.stderr.write(formatBatchSummary(summarizeBatch(results)) + '\n');
  }
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
