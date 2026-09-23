import {
  ParsedReportSchema,
  type ParsedReport,
  type Triage,
} from '../schema/parsed-report';
import {
  LLMOutputSchema,
  llmToolInputJSONSchema,
  toolInputSchemaFor,
} from '../llm/tool-schema';
import { DRAFT_SYSTEM_BLOCKS, SYSTEM_BLOCKS } from '../llm/prompt';
import {
  type AnthropicClient,
  type MessagesResponse,
  type MessagesUsage,
  type ToolUseBlock,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from '../llm/client';
import type { JevClient } from '../jev/client';
import { decideBucket } from '../jev/triage';
import {
  nonBugFromDecision,
  tooVagueFromDecision,
  triageFromDecision,
} from './templates';

export interface ClassifyOptions {
  model?: string;
  maxTokens?: number;
}

/** A classified report plus the call metadata the eval scripts need. */
export interface ClassifyResult {
  report: ParsedReport;
  /** Absent when the client did not report usage (mocked clients) or no LLM call was made. */
  usage?: MessagesUsage;
  latencyMs: number;
}

export type ClassifyErrorStage =
  | 'no_tool_use'
  | 'wrong_tool_name'
  | 'bucket_mismatch'
  | 'llm_schema'
  | 'final_schema';

export class ClassifyError extends Error {
  constructor(
    message: string,
    public override readonly cause: unknown,
    public readonly stage: ClassifyErrorStage,
  ) {
    super(message);
    this.name = 'ClassifyError';
  }
}

const TOOL_NAME = 'classify_bug_report';
const TOOL_DESCRIPTION =
  'Classify a user-submitted bug report into one of four structured outputs. Call exactly once.';
const DRAFT_TOOL_DESCRIPTION =
  'Fill in the structured output for a bug report whose classification has already been decided. Call exactly once.';

// Runner-owned fields attached after the LLM call. The LLM is never allowed to
// emit any of these (see OMIT in tool-schema.ts).
interface RunnerFields {
  report_id: string;
  original_input: string;
  triage?: Triage;
}

function extractToolInput(response: MessagesResponse): unknown {
  const toolUse = response.content.find(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) {
    throw new ClassifyError(
      `Expected tool_use block in response (stop_reason=${response.stop_reason})`,
      response,
      'no_tool_use',
    );
  }
  if (toolUse.name !== TOOL_NAME) {
    throw new ClassifyError(
      `Unexpected tool name: ${toolUse.name}`,
      toolUse,
      'wrong_tool_name',
    );
  }
  return toolUse.input;
}

// Validation pass 1 blames the model precisely; pass 2 asserts the full
// contract after the runner-owned fields are merged in.
function validateAndMerge(input: unknown, runnerFields: RunnerFields): ParsedReport {
  const llmParsed = LLMOutputSchema.safeParse(input);
  if (!llmParsed.success) {
    throw new ClassifyError(
      'LLM tool_use.input failed schema validation',
      llmParsed.error,
      'llm_schema',
    );
  }
  const merged = { ...llmParsed.data, ...runnerFields };
  const finalParsed = ParsedReportSchema.safeParse(merged);
  if (!finalParsed.success) {
    throw new ClassifyError(
      'Merged result failed final ParsedReport validation',
      finalParsed.error,
      'final_schema',
    );
  }
  return finalParsed.data;
}

export async function classifyReport(
  reportId: string,
  rawInput: string,
  client: AnthropicClient,
  options: ClassifyOptions = {},
): Promise<ParsedReport> {
  const result = await classifyReportWithMeta(reportId, rawInput, client, options);
  return result.report;
}

export async function classifyReportWithMeta(
  reportId: string,
  rawInput: string,
  client: AnthropicClient,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const started = performance.now();
  const response = await client.createMessage({
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: SYSTEM_BLOCKS,
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        input_schema: llmToolInputJSONSchema,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: `Bug report:\n\n${rawInput}` }],
  });

  const input = extractToolInput(response);
  const report = validateAndMerge(input, {
    report_id: reportId,
    original_input: rawInput,
  });
  return {
    report,
    ...(response.usage ? { usage: response.usage } : {}),
    latencyMs: performance.now() - started,
  };
}

/**
 * Hybrid engine: Jev decides the bucket, the LLM drafts only when there is
 * something to draft.
 *
 * - too_vague and non_bug are answered from templates with no LLM call.
 * - actionable and partial go to the LLM with the bucket pinned in the tool
 *   schema and the decision order removed from the prompt. If the LLM returns
 *   a different classification anyway, that is reported as bucket_mismatch
 *   before any schema validation runs, so an override is never misattributed
 *   as a generic schema failure.
 */
export async function classifyReportHybrid(
  reportId: string,
  rawInput: string,
  jev: JevClient,
  anthropic: AnthropicClient,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const started = performance.now();
  const decision = await decideBucket(rawInput, jev, { includeRoute: true });

  if (
    decision.bucket === 'too_vague_request_more_info' ||
    decision.bucket === 'non_bug_support_question'
  ) {
    const draft =
      decision.bucket === 'too_vague_request_more_info'
        ? tooVagueFromDecision(reportId, rawInput, decision)
        : nonBugFromDecision(reportId, rawInput, decision);
    const parsed = ParsedReportSchema.safeParse(draft);
    if (!parsed.success) {
      throw new ClassifyError(
        'Templated result failed final ParsedReport validation',
        parsed.error,
        'final_schema',
      );
    }
    return { report: parsed.data, latencyMs: performance.now() - started };
  }

  const response = await anthropic.createMessage({
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: DRAFT_SYSTEM_BLOCKS,
    tools: [
      {
        name: TOOL_NAME,
        description: DRAFT_TOOL_DESCRIPTION,
        input_schema: toolInputSchemaFor(decision.bucket),
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: `Classification (already decided): ${decision.bucket}\n\nBug report:\n\n${rawInput}`,
      },
    ],
  });

  const input = extractToolInput(response);
  const returned =
    typeof input === 'object' && input !== null && 'classification' in input
      ? (input as { classification: unknown }).classification
      : undefined;
  if (returned !== decision.bucket) {
    throw new ClassifyError(
      `LLM returned classification ${String(returned)} but the pinned bucket is ${decision.bucket}`,
      input,
      'bucket_mismatch',
    );
  }

  const report = validateAndMerge(input, {
    report_id: reportId,
    original_input: rawInput,
    triage: triageFromDecision(decision, true),
  });
  return {
    report,
    ...(response.usage ? { usage: response.usage } : {}),
    latencyMs: performance.now() - started,
  };
}
