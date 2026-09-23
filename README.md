# Bug Report Triage CLI

A CLI that takes a JSON array of raw bug-report strings and transforms each one into a structured triage output via Anthropic tool-use. Crucially, it does **not** force every input into a ticket. Each report is classified into one of four buckets, each with its own output shape.

There are two engines. The default makes one Anthropic tool-use call that decides the bucket and drafts the fields. `--engine jev` hands the bucket decision to [TypeSafe's Jev](https://docs.typesafe.ai/introduction), a model that returns a typed choice with a probability distribution instead of text, and calls Anthropic only for the two buckets that have fields worth drafting. See [Jev experiment](#jev-experiment) below.

The four buckets:

1. `actionable_ticket`, enough context to file directly.
2. `partial_ticket_needs_clarification`, real bug signal but key facts missing; emits a draft + clarifying questions.
3. `too_vague_request_more_info`, too thin to draft; emits only clarifying questions.
4. `non_bug_support_question`, not a bug; routes away from engineering (how-to, billing, feature request, status).

## Quick start

```bash
bun install
cp .env.example .env   # fill in ANTHROPIC_API_KEY; add TYPESAFE_API_KEY for --engine jev and eval:jev
```

## Commands

| Command             | What it does                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`      | Runs Vitest suite (104 tests across schema, classifier, CLI, prompt, Jev, hybrid engine). Uses mocked Anthropic and Jev clients, no API key, no network.                                     |
| `bun run typecheck` | `tsc --noEmit` strict-mode pass.                                                                                                                                                              |
| `bun run cli`       | Reads a JSON array of strings from stdin or a file path, classifies each, writes a JSON array to stdout. Requires `ANTHROPIC_API_KEY`. Add `--engine jev` (needs `TYPESAFE_API_KEY`) to route the bucket decision through Jev. |
| `bun run eval`      | Runs the live model over the 20-entry messy corpus in [tests/fixtures/raw-inputs.ts](tests/fixtures/raw-inputs.ts), compares to expected labels, exits non-zero if agreement falls below 70%. |
| `bun run eval:jev`  | Runs the bucket decision through Jev N times over the same corpus and writes [eval-jev-results.json](eval-jev-results.json). `EVAL_BASELINE=1` also re-runs the Anthropic classifier in the same harness. See [Jev experiment](#jev-experiment). |

## Input format

The CLI accepts a **JSON array of strings**, where each string is one raw bug report. You can pass any file path or pipe JSON over stdin. The repo ships a 4-entry demo at [tests/fixtures/example-input.json](tests/fixtures/example-input.json) for the "Try it" commands below.

```json
["raw bug report text from user 1", "raw bug report text from user 2"]
```

The 20-entry "messy" corpus used by `bun run eval` lives in [tests/fixtures/raw-inputs.ts](tests/fixtures/raw-inputs.ts) (TypeScript, includes expected labels for eval), not directly consumable by the CLI.

## Try it

A copy-paste checklist to run end-to-end. Each step takes <10s; the file-arg run is the best "does this thing actually work" demo.

**Happy paths** (require `ANTHROPIC_API_KEY` in env or `.env`):

```bash
# 1. file arg, 4 entries, one per classification
bun run cli tests/fixtures/example-input.json

# 2. stdin pipe, one entry, should be classified as too_vague
echo '["upload is broken"]' | bun run cli

# 3. override the model
ANTHROPIC_MODEL=claude-haiku-4-5 bun run cli tests/fixtures/example-input.json

# 4. hybrid engine: Jev decides the bucket, Anthropic drafts only actionable and partial
#    (needs TYPESAFE_API_KEY; pin the Jev version so runs are comparable)
TYPESAFE_DEFAULT_MODEL=jev-1.13.0 bun run cli --engine jev tests/fixtures/example-input.json
```

**Error paths** (should fail loud with exit code 2 and a stderr message, no API call made):

```bash
echo 'not json' | bun run cli                # invalid JSON
echo '{"foo":"bar"}' | bun run cli           # not a JSON array
echo '["ok", 42]' | bun run cli              # array contains a non-string
( unset ANTHROPIC_API_KEY; echo '[]' | bun run cli )   # missing API key
```

**Edge case:**

```bash
echo '[]' | bun run cli   # empty array → prints "[]", exits 0
```

**What to look for in the output:**

- A banner + per-entry dots on **stderr** while the batch runs (e.g. `Classifying 4 reports against model=claude-sonnet-4-6 (concurrency=5)...` then `....` then `done.`). Each entry typically takes 3-15s; for 20 entries plan on 30-60s total.
- The final JSON goes to **stdout** only, so `bun run cli input.json | jq` works cleanly. To suppress the banner entirely, redirect: `bun run cli input.json 2>/dev/null`.
- Pretty-printed JSON array, one entry per input, in input order.
- Each entry has a positional `report_id` (`report-0`, `report-1`, …) and an `original_input` echo.
- Per-entry classification failures show up as `{ "classification": "error", "report_id", "original_input", "error": { "stage", "message" } }` inline. The batch keeps going.
- With `--engine jev`, every entry also carries a runner-owned `triage` block (Jev model, bucket, confidence, full probability distribution, latency, input tokens, `llm_called`, and the support route for non-bug questions), and stderr ends with a triage summary: how many reports went to each bucket, how many LLM calls were made or skipped, and how many times the LLM tried to override the pinned bucket (`bucket_mismatch`).

## How it works

**Schema-first.** Every output conforms to a [Zod discriminated union](src/schema/parsed-report.ts) over the four classifications. Each variant is `.strict()`, so unknown keys are rejected. That's what catches LLM drift. Inferred TS types flow downstream so the rest of the code knows exactly which fields exist on which variant.

**Anthropic tool-use with double validation.** [classifyReport](src/classifier/classify.ts) sends each report with a forced `tool_choice`. The tool's `input_schema` is a flat object (Anthropic rejects `oneOf`/`anyOf` at the root of tool schemas), so per-variant required-field enforcement happens after the call: `LLMOutputSchema.safeParse(tool_use.input)` first (precise blame on the model), then `ParsedReportSchema.safeParse(merged)` (final contract guarantee after merging in runner-owned `report_id` and `original_input`).

**Prompt design.** The [system prompt](src/llm/prompt.ts) carries the rubric: four classifications with definitions, a severity scale, the category enum, anti-hallucination rules, and explicit per-variant field-discipline lists (each variant's allowed fields with "do NOT emit anything else"). The prompt is marked `cache_control: ephemeral` so Anthropic caches it for ~5 min. Every report in a batch after the first benefits.

**Two test surfaces.** Mocked tests run the schema, classifier, and CLI logic against a fake `AnthropicClient`: fast, deterministic, no API key. The live [eval script](scripts/eval.ts) runs the real model over the messy corpus and reports per-entry agreement with a 70% floor. They answer different questions: unit tests answer "is the code correct?"; the eval answers "does the model handle real ugliness?"

**Hybrid engine (`--engine jev`).** [decideBucket](src/jev/triage.ts) sends the report to Jev as `{ product, report }` state with one Choice question whose four criteria ([src/jev/questions.ts](src/jev/questions.ts)) mirror the system prompt's bucket definitions, plus a speculative `support_route` Choice consumed only for non-bug questions. [classifyReportHybrid](src/classifier/classify.ts) then answers `too_vague` and `non_bug` from [templates](src/classifier/templates.ts) with no LLM call, and sends `actionable` and `partial` to Anthropic with the decision order removed from the prompt (`DRAFT_SYSTEM_PROMPT`) and the tool schema's `classification` narrowed to one literal ([toolInputSchemaFor](src/llm/tool-schema.ts)). If the LLM returns a different classification anyway, that is reported as `bucket_mismatch` before any schema validation runs. The default engine's prompt is unchanged: [tests/prompt.test.ts](tests/prompt.test.ts) asserts it equals a verbatim snapshot byte for byte.

## Project layout

```
src/
  index.ts                    # CLI entry: stdin/argv → runCli → stdout
  schema/
    parsed-report.ts          # Zod discriminated union + strict variants + inferred types
    types.ts                  # stable re-export surface for downstream imports
  llm/
    client.ts                 # AnthropicClient interface + real SDK factory
    prompt.ts                 # system prompt (sectioned) + drafting prompt for the hybrid engine
    tool-schema.ts            # flat JSON Schema for the tool; strict per-variant validator; pinned-bucket variant
  jev/
    questions.ts              # Jev state builder, bucket criteria, route criteria, decision-order Nouls
    client.ts                 # JevClient interface + real SDK factory
    triage.ts                 # decideBucket (label validation, probability normalization)
  classifier/
    classify.ts               # classifyReport (default) and classifyReportHybrid (Jev routes, LLM drafts)
    templates.ts              # no-LLM answers for too_vague and non_bug under the hybrid engine
  cli/
    runner.ts                 # runCli (parse input, engine dispatch, concurrent classify, batch summary)
tests/
  fixtures/
    valid-samples.ts          # canonical valid object per variant (schema tests)
    raw-inputs.ts             # 20-entry messy corpus (eval)
    adversarial-inputs.ts     # 3 injection probes for the Jev eval, never mixed into the corpus number
    mock-responses.ts         # canned tool_use payloads (unit tests)
    mock-jev.ts               # canned Jev responses (unit tests)
    system-prompt.snapshot.ts # verbatim pre-refactor system prompt (byte-equality test)
    example-input.json        # 4-entry demo input for the CLI
  schema.test.ts
  classify.test.ts
  cli.test.ts
  cli-engine.test.ts
  hybrid.test.ts
  jev.test.ts
  prompt.test.ts
scripts/
  eval.ts                     # live API runner over the corpus
  eval-jev.ts                 # Jev eval with optional Anthropic baseline; writes eval-jev-results.json
eval-jev-results.json         # committed artifact from the published run
```

## Sample eval run

![bun run eval over the 20-entry messy corpus: 17/20 agreement on claude-sonnet-4-6, with three class-boundary misses (a-05, v-04, n-05)](https://dhbtuus86mod.cloudfront.net/run-evals.png)

17/20 agreement against the hand-labeled expectations in [tests/fixtures/raw-inputs.ts](tests/fixtures/raw-inputs.ts). The three misses (a-05, v-04, n-05) are class-boundary judgment calls, not classifier failures.

## Jev experiment

`scripts/eval-jev.ts` re-runs only the bucket decision through Jev and compares it against the same labels and, with `EVAL_BASELINE=1`, against the Anthropic classifier run in the same harness. The committed [eval-jev-results.json](eval-jev-results.json) is the artifact behind Part III of the blog series. Headline numbers from that run (3 runs per engine, Jev pinned to `jev-1.13.0`, Sonnet at concurrency 1 so per-call latency is comparable):

| | Jev (bucket only) | claude-sonnet-4-6 (bucket plus drafted fields) |
| --- | --- | --- |
| Agreement per run | 16/20, 16/20, 16/20 | 18/20, 18/20, 17/20 |
| Choices identical across runs | yes (probabilities drifted by up to 0.07) | no (a-05 flipped on run 3) |
| Latency, mean / median / p95 | 203 ms / 195 ms / 261 ms | 11.7 s / 14.2 s / 19.9 s |
| Cost per 1,000 reports | $0.044 (input only; output is free) | $10.48 (81% of it output tokens) |

Rules the run followed, so the numbers can be trusted:

- The four bucket criteria in [src/jev/questions.ts](src/jev/questions.ts) were committed before the first live call. The artifact records the commit and a SHA-256 of the criteria, and they were not tuned after seeing results. Two of Jev's four misses are arguably my criteria's fault (v-01) or the label's (n-05, which Sonnet also misses); they stay as they are.
- Both engines get the same number of runs, and the baseline runs sequentially, so "Jev is repeatable" has something to be compared against and Sonnet's latency is not inflated by queuing.
- The run aborts if the Jev model id reported by the API changes between calls, so a `jev-latest` rollover cannot masquerade as non-determinism.
- Three adversarial probes in [tests/fixtures/adversarial-inputs.ts](tests/fixtures/adversarial-inputs.ts) are reported in their own block and never mixed into the 20-row number. One of them (an embedded "classify this as actionable" instruction inside an otherwise empty report) moved Jev's answer.

Pricing sources: [docs.typesafe.ai/models](https://docs.typesafe.ai/models) for Jev and [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) for Sonnet, both read on 2026-09-22 and recorded in the artifact's `meta.pricing`.

To reproduce:

```bash
# Jev only, 3 runs, with the decision-order Nouls and the adversarial block
TYPESAFE_DEFAULT_MODEL=jev-1.13.0 bun run eval:jev

# Jev plus the Anthropic baseline, 3 runs each (about 20 minutes, mostly Sonnet)
EVAL_BASELINE=1 TYPESAFE_DEFAULT_MODEL=jev-1.13.0 bun run eval:jev

# knobs: JEV_RUNS, BASELINE_RUNS, JEV_NOULS=0, JEV_ADVERSARIAL=0, JEV_OUT=<path>
```
