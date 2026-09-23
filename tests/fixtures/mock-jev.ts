import type { JevClient, JevResponse } from '../../src/jev/client';
import type { Bucket, SupportRoute } from '../../src/jev/questions';

// Canned Jev responses for unit tests. Same role as mock-responses.ts plays
// for the Anthropic client: deterministic, offline, no SDK import.

export const bucketProbabilities = (
  winner: Bucket,
  rest = 0.02,
): Record<Bucket, number> => ({
  actionable_ticket: rest,
  partial_ticket_needs_clarification: rest,
  too_vague_request_more_info: rest,
  non_bug_support_question: rest,
  [winner]: 1 - rest * 3,
});

export const routeProbabilities = (
  winner: SupportRoute,
  rest = 0.02,
): Record<SupportRoute, number> => ({
  docs: rest,
  billing: rest,
  feature_request: rest,
  status: rest,
  other: rest,
  [winner]: 1 - rest * 4,
});

export interface MockJevOptions {
  route?: SupportRoute;
  confidence?: number;
  model?: string;
  inputTokens?: number;
}

export const mockJevResponse = (
  bucket: Bucket,
  options: MockJevOptions = {},
): JevResponse => ({
  model: options.model ?? 'jev-1.13.0',
  usage: { input_tokens: options.inputTokens ?? 321, output_tokens: 0 },
  answers: {
    bucket: {
      type: 'choice',
      choice: bucket,
      confidence: options.confidence ?? 0.91,
      probabilities: bucketProbabilities(bucket),
    },
    ...(options.route
      ? {
          support_route: {
            type: 'choice' as const,
            choice: options.route,
            confidence: 0.8,
            probabilities: routeProbabilities(options.route),
          },
        }
      : {}),
  },
});

export const jevClientReturning = (resp: JevResponse): JevClient => ({
  requestedModel: 'jev-latest',
  systemOne: async () => resp,
});

/** A Jev client that routes on the report text, like routingClient in cli.test.ts. */
export const jevRoutingClient = (
  route: (report: string) => JevResponse,
): JevClient => ({
  requestedModel: 'jev-latest',
  systemOne: async (state) => route(state.report),
});
