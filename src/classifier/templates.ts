/**
 * Deterministic outputs for the two buckets that never reach the LLM under
 * --engine jev.
 *
 * Parts I and II of the blog series treated "refuse to draft" as a behavior:
 * too_vague and non_bug are the classifier declining to write a ticket. Once
 * Jev owns the bucket decision, there is nothing left for a language model to
 * generate for those two buckets, so the fields come from templates. The
 * output still has to satisfy the same strict schema as everything else.
 */
import type { JevDecision } from '../jev/triage';
import type { SupportRoute } from '../jev/questions';
import type { NonBugSupport, TooVague, Triage } from '../schema/parsed-report';

export function triageFromDecision(
  decision: JevDecision,
  llmCalled: boolean,
): Triage {
  return {
    engine: 'jev',
    model: decision.model,
    bucket: decision.bucket,
    confidence: decision.confidence,
    probabilities: decision.probabilities,
    latency_ms: decision.latencyMs,
    input_tokens: decision.usage.input_tokens,
    llm_called: llmCalled,
    ...(decision.route ? { route: decision.route } : {}),
  };
}

export const TOO_VAGUE_CLARIFYING_QUESTIONS: readonly string[] = [
  'Which part of the product were you using (projects, document upload, AI review, billing, sign-in)?',
  'What did you do, what did you expect to happen, and what happened instead?',
  'If there was an error message, what did it say?',
];

export function tooVagueFromDecision(
  reportId: string,
  rawInput: string,
  decision: JevDecision,
): TooVague {
  return {
    classification: 'too_vague_request_more_info',
    report_id: reportId,
    original_input: rawInput,
    triage: triageFromDecision(decision, false),
    interpretation:
      'The report does not say which part of the product is involved or what went wrong, so there is nothing to draft yet.',
    clarifying_questions: [...TOO_VAGUE_CLARIFYING_QUESTIONS],
  };
}

export const ROUTE_RESPONSES: Record<SupportRoute, string> = {
  docs: 'Thanks for reaching out. This reads as a question about how the product works rather than a bug, so it is going to our documentation team, who can point you to the right guide.',
  billing:
    'Thanks for reaching out. This reads as a billing or account question rather than a bug, so it is going to our billing team, who can review your account and invoices.',
  feature_request:
    'Thanks for the suggestion. This reads as a request for something the product does not do today, so it has been logged as a feature request for the product team.',
  status:
    'Thanks for checking. This reads as a question about service availability rather than a bug, so it is going to our status team. The status page has current incident details.',
  other:
    'Thanks for reaching out. This reads as a support question rather than a bug, so it is going to general support.',
};

/** Throws if the decision has no route, which means the caller asked Jev the wrong questions. */
export function nonBugFromDecision(
  reportId: string,
  rawInput: string,
  decision: JevDecision,
): NonBugSupport {
  const route = decision.route;
  if (!route) {
    throw new Error('nonBugFromDecision needs a decision that includes a support_route');
  }
  const bucketP = decision.probabilities.non_bug_support_question;
  const routeP = route.probabilities[route.choice];
  return {
    classification: 'non_bug_support_question',
    report_id: reportId,
    original_input: rawInput,
    triage: triageFromDecision(decision, false),
    suggested_route: route.choice,
    suggested_response: ROUTE_RESPONSES[route.choice],
    reasoning: `Routed without an LLM call. Jev put the message in non_bug_support_question with probability ${bucketP.toFixed(2)} and chose the ${route.choice} route with probability ${routeP.toFixed(2)}.`,
  };
}
