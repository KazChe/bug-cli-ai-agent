import type { JevClient, JevChoiceAnswer, JevUsage } from './client';
import {
  BUCKETS,
  NOUL_KEYS,
  SUPPORT_ROUTES,
  buildTriageQuestions,
  buildTriageState,
  type Bucket,
  type BuildQuestionsOptions,
  type NoulKey,
  type SupportRoute,
} from './questions';

export class JevError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export interface RouteDecision {
  choice: SupportRoute;
  confidence: number;
  probabilities: Record<SupportRoute, number>;
}

export interface JevDecision {
  bucket: Bucket;
  confidence: number;
  /** Normalized once here so downstream code never sees a missing label. */
  probabilities: Record<Bucket, number>;
  nouls?: Record<NoulKey, number>;
  /** The prompt's decision order applied in code over the Noul probabilities. */
  derivedBucket?: Bucket;
  route?: RouteDecision;
  model: string;
  usage: JevUsage;
  latencyMs: number;
}

const BUCKET_SET: ReadonlySet<string> = new Set(BUCKETS);
const ROUTE_SET: ReadonlySet<string> = new Set(SUPPORT_ROUTES);

export function toBucket(label: string): Bucket {
  if (!BUCKET_SET.has(label)) {
    throw new JevError(`Jev returned an unknown bucket label: ${label}`);
  }
  return label as Bucket;
}

export function toRoute(label: string): SupportRoute {
  if (!ROUTE_SET.has(label)) {
    throw new JevError(`Jev returned an unknown route label: ${label}`);
  }
  return label as SupportRoute;
}

function normalize<K extends string>(
  keys: readonly K[],
  probabilities: Record<string, number>,
  what: string,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const value = probabilities[key];
    if (typeof value !== 'number') {
      throw new JevError(`Jev ${what} response is missing a probability for ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function expectChoice(
  answers: Record<string, { type: string }>,
  key: string,
): JevChoiceAnswer {
  const answer = answers[key];
  if (!answer || answer.type !== 'choice') {
    throw new JevError(`Jev response is missing the ${key} choice answer`);
  }
  return answer as JevChoiceAnswer;
}

/**
 * The prompt's "Decision order" section, as code over three probabilities:
 *   1. a question about the product          -> non_bug_support_question
 *   2. no clear surface or symptom            -> too_vague_request_more_info
 *   3. expected/observed cannot be answered   -> partial_ticket_needs_clarification
 *   4. otherwise                              -> actionable_ticket
 */
export function deriveBucketFromNouls(
  nouls: Record<NoulKey, number>,
  threshold = 0.5,
): Bucket {
  if (nouls.asks_how_product_works >= threshold) {
    return 'non_bug_support_question';
  }
  if (nouls.names_surface_and_symptom < threshold) {
    return 'too_vague_request_more_info';
  }
  if (nouls.states_expected_and_observed < threshold) {
    return 'partial_ticket_needs_clarification';
  }
  return 'actionable_ticket';
}

export async function decideBucket(
  raw: string,
  client: JevClient,
  options: BuildQuestionsOptions = {},
): Promise<JevDecision> {
  const questions = buildTriageQuestions(options);
  const started = performance.now();
  const response = await client.systemOne(buildTriageState(raw), questions);
  const latencyMs = performance.now() - started;

  const bucketAnswer = expectChoice(response.answers, 'bucket');
  const decision: JevDecision = {
    bucket: toBucket(bucketAnswer.choice),
    confidence: bucketAnswer.confidence,
    probabilities: normalize(BUCKETS, bucketAnswer.probabilities, 'bucket'),
    model: response.model,
    usage: response.usage,
    latencyMs,
  };

  if (options.includeNouls) {
    const nouls = {} as Record<NoulKey, number>;
    for (const key of NOUL_KEYS) {
      const answer = response.answers[key];
      if (!answer || answer.type !== 'noul') {
        throw new JevError(`Jev response is missing the ${key} noul answer`);
      }
      nouls[key] = answer.noul;
    }
    decision.nouls = nouls;
    decision.derivedBucket = deriveBucketFromNouls(nouls);
  }

  if (options.includeRoute) {
    const routeAnswer = expectChoice(response.answers, 'support_route');
    decision.route = {
      choice: toRoute(routeAnswer.choice),
      confidence: routeAnswer.confidence,
      probabilities: normalize(SUPPORT_ROUTES, routeAnswer.probabilities, 'route'),
    };
  }

  return decision;
}
