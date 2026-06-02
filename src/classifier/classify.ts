import { ParsedReportSchema, type ParsedReport } from '../schema/parsed-report';
import { LLMOutputSchema, llmToolInputJSONSchema } from '../llm/tool-schema';
import { SYSTEM_BLOCKS } from '../llm/prompt';
import {
  type AnthropicClient,
  type ToolUseBlock,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from '../llm/client';

export interface ClassifyOptions {
  model?: string;
  maxTokens?: number;
}

export type ClassifyErrorStage =
  | 'no_tool_use'
  | 'wrong_tool_name'
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

export async function classifyReport(
  reportId: string,
  rawInput: string,
  client: AnthropicClient,
  options: ClassifyOptions = {},
): Promise<ParsedReport> {
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

  const llmParsed = LLMOutputSchema.safeParse(toolUse.input);
  if (!llmParsed.success) {
    throw new ClassifyError(
      'LLM tool_use.input failed schema validation',
      llmParsed.error,
      'llm_schema',
    );
  }

  const merged = {
    ...llmParsed.data,
    report_id: reportId,
    original_input: rawInput,
  };
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
