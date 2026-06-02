import Anthropic from '@anthropic-ai/sdk';

// Re-declared SDK response shape so test mocks don't import @anthropic-ai/sdk
// directly. Decouples test fixtures from SDK minor-version drift. If Anthropic
// ever changes the content block shape, the only fix point is the cast in
// createRealClient below.

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ResponseBlock = ToolUseBlock | TextBlock;

export interface MessagesResponse {
  id: string;
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
  content: ResponseBlock[];
}

export interface MessagesCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }>;
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice: { type: 'tool'; name: string };
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AnthropicClient {
  createMessage(params: MessagesCreateParams): Promise<MessagesResponse>;
}

export function createRealClient(apiKey: string): AnthropicClient {
  const sdk = new Anthropic({ apiKey });
  return {
    createMessage: (params) =>
      sdk.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      ) as unknown as Promise<MessagesResponse>,
  };
}

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_MAX_TOKENS = 2048;
