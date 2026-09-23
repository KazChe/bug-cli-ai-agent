import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevQuestions, JevState } from './questions';

// Re-declared response shapes so tests and the rest of src never import the
// SDK directly. Same decoupling pattern as src/llm/client.ts: if the SDK
// changes its types, the only fix point is the cast in createRealJevClient.

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  usage: JevUsage;
  answers: Record<string, JevAnswer>;
}

export interface JevClient {
  /** The model id the client will request; the response reports the versioned id that answered. */
  readonly requestedModel: string;
  systemOne(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}

export interface JevClientOptions {
  apiKey?: string;
  /** Overrides TYPESAFE_DEFAULT_MODEL and the SDK default of jev-latest. */
  model?: string;
  timeoutMs?: number;
}

export function createRealJevClient(options: JevClientOptions = {}): JevClient {
  const sdk = new TypeSafeClient({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.model ? { defaultModel: options.model } : {}),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  return {
    requestedModel: sdk.defaultModel,
    systemOne: async (state, questions) => {
      const result = await sdk.systemOne({
        state,
        questions: questions as unknown as Parameters<
          typeof sdk.systemOne
        >[0]['questions'],
      });
      return result as unknown as JevResponse;
    },
  };
}
