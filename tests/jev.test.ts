/**
 * Jev-layer unit tests use a mock JevClient rather than the real API, for the
 * same reasons classify.test.ts mocks Anthropic: deterministic, offline, fast.
 * Real model behavior is measured separately by scripts/eval-jev.ts.
 */
import { describe, it, expect } from 'vitest';
import { ParsedReportSchema, NonBugSupportSchema } from '../src/schema/parsed-report';
import {
  BUCKETS,
  NOUL_KEYS,
  ROUTE_CRITERIA,
  SUPPORT_ROUTES,
  TRIAGE_CRITERIA,
  buildTriageQuestions,
  buildTriageState,
  criteriaSha256,
} from '../src/jev/questions';
import type { JevClient, JevResponse } from '../src/jev/client';
import {
  JevError,
  decideBucket,
  deriveBucketFromNouls,
  toBucket,
} from '../src/jev/triage';

const bucketProbabilities = (winner: string, rest = 0.02) => ({
  actionable_ticket: rest,
  partial_ticket_needs_clarification: rest,
  too_vague_request_more_info: rest,
  non_bug_support_question: rest,
  [winner]: 1 - rest * 3,
});

const mockResponse = (
  bucket: string,
  extra: Partial<JevResponse['answers']> = {},
): JevResponse => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 321, output_tokens: 0 },
  answers: {
    bucket: {
      type: 'choice',
      choice: bucket,
      confidence: 0.91,
      probabilities: bucketProbabilities(bucket),
    },
    ...extra,
  },
});

const clientReturning = (resp: JevResponse): JevClient => ({
  requestedModel: 'jev-latest',
  systemOne: async () => resp,
});

describe('question definitions stay in sync with the schema', () => {
  it('TRIAGE_CRITERIA keys equal the four classification literals', () => {
    const schemaLiterals = ParsedReportSchema.options
      .map((option) => option.shape.classification.value)
      .sort();
    expect(Object.keys(TRIAGE_CRITERIA).sort()).toEqual(schemaLiterals);
    expect([...BUCKETS].sort()).toEqual(schemaLiterals);
  });

  it('ROUTE_CRITERIA keys equal the SupportRoute enum', () => {
    const routes = [...NonBugSupportSchema.shape.suggested_route.options].sort();
    expect(Object.keys(ROUTE_CRITERIA).sort()).toEqual(routes);
    expect([...SUPPORT_ROUTES].sort()).toEqual(routes);
  });

  it('builds only the bucket question by default', () => {
    expect(Object.keys(buildTriageQuestions())).toEqual(['bucket']);
  });

  it('adds the three nouls and the route question when asked', () => {
    const keys = Object.keys(
      buildTriageQuestions({ includeNouls: true, includeRoute: true }),
    );
    expect(keys).toEqual(['bucket', ...NOUL_KEYS, 'support_route']);
  });

  it('puts the product description in state, not instructions', () => {
    const state = buildTriageState('the thing is broken');
    expect(state.report).toBe('the thing is broken');
    expect(state.product.length).toBeGreaterThan(0);
  });

  it('criteria fingerprint is stable across calls', () => {
    expect(criteriaSha256()).toBe(criteriaSha256());
    expect(criteriaSha256()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decideBucket', () => {
  it('maps the choice to a bucket and normalizes probabilities', async () => {
    const client = clientReturning(mockResponse('actionable_ticket'));
    const decision = await decideBucket('raw', client);
    expect(decision.bucket).toBe('actionable_ticket');
    expect(decision.confidence).toBe(0.91);
    expect(decision.probabilities.actionable_ticket).toBeCloseTo(0.94);
    expect(Object.keys(decision.probabilities).sort()).toEqual(
      [...BUCKETS].sort(),
    );
    expect(decision.model).toBe('jev-1.13.0');
    expect(decision.usage.input_tokens).toBe(321);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
    expect(decision).not.toHaveProperty('nouls');
    expect(decision).not.toHaveProperty('derivedBucket');
    expect(decision).not.toHaveProperty('route');
  });

  it('rejects an unknown bucket label', async () => {
    const client = clientReturning(mockResponse('spam'));
    await expect(decideBucket('raw', client)).rejects.toBeInstanceOf(JevError);
    expect(() => toBucket('spam')).toThrow(JevError);
  });

  it('rejects a response missing a bucket probability', async () => {
    const resp = mockResponse('actionable_ticket');
    const { non_bug_support_question: _dropped, ...partial } = (
      resp.answers['bucket'] as { probabilities: Record<string, number> }
    ).probabilities;
    (resp.answers['bucket'] as { probabilities: Record<string, number> }).probabilities =
      partial;
    await expect(decideBucket('raw', clientReturning(resp))).rejects.toThrow(
      /missing a probability/,
    );
  });

  it('collects nouls and derives a bucket when includeNouls is set', async () => {
    const client = clientReturning(
      mockResponse('partial_ticket_needs_clarification', {
        asks_how_product_works: { type: 'noul', noul: 0.05 },
        names_surface_and_symptom: { type: 'noul', noul: 0.9 },
        states_expected_and_observed: { type: 'noul', noul: 0.2 },
      }),
    );
    const decision = await decideBucket('raw', client, { includeNouls: true });
    expect(decision.nouls).toEqual({
      asks_how_product_works: 0.05,
      names_surface_and_symptom: 0.9,
      states_expected_and_observed: 0.2,
    });
    expect(decision.derivedBucket).toBe('partial_ticket_needs_clarification');
  });

  it('collects the support route when includeRoute is set', async () => {
    const client = clientReturning(
      mockResponse('non_bug_support_question', {
        support_route: {
          type: 'choice',
          choice: 'billing',
          confidence: 0.8,
          probabilities: {
            docs: 0.05,
            billing: 0.85,
            feature_request: 0.03,
            status: 0.02,
            other: 0.05,
          },
        },
      }),
    );
    const decision = await decideBucket('raw', client, { includeRoute: true });
    expect(decision.route?.choice).toBe('billing');
    expect(decision.route?.probabilities.billing).toBe(0.85);
  });

  it('fails loudly when a requested auxiliary answer is absent', async () => {
    const client = clientReturning(mockResponse('actionable_ticket'));
    await expect(
      decideBucket('raw', client, { includeNouls: true }),
    ).rejects.toThrow(/missing the asks_how_product_works/);
    await expect(
      decideBucket('raw', client, { includeRoute: true }),
    ).rejects.toThrow(/missing the support_route/);
  });
});

describe('deriveBucketFromNouls follows the prompt decision order', () => {
  it('question about the product wins first', () => {
    expect(
      deriveBucketFromNouls({
        asks_how_product_works: 0.9,
        names_surface_and_symptom: 0.9,
        states_expected_and_observed: 0.9,
      }),
    ).toBe('non_bug_support_question');
  });

  it('no clear surface or symptom is too vague', () => {
    expect(
      deriveBucketFromNouls({
        asks_how_product_works: 0.1,
        names_surface_and_symptom: 0.2,
        states_expected_and_observed: 0.9,
      }),
    ).toBe('too_vague_request_more_info');
  });

  it('surface known but expected/observed unclear is partial', () => {
    expect(
      deriveBucketFromNouls({
        asks_how_product_works: 0.1,
        names_surface_and_symptom: 0.8,
        states_expected_and_observed: 0.3,
      }),
    ).toBe('partial_ticket_needs_clarification');
  });

  it('everything present is actionable', () => {
    expect(
      deriveBucketFromNouls({
        asks_how_product_works: 0.1,
        names_surface_and_symptom: 0.8,
        states_expected_and_observed: 0.7,
      }),
    ).toBe('actionable_ticket');
  });

  it('honors a custom threshold', () => {
    const nouls = {
      asks_how_product_works: 0.6,
      names_surface_and_symptom: 0.9,
      states_expected_and_observed: 0.9,
    };
    expect(deriveBucketFromNouls(nouls, 0.7)).toBe('actionable_ticket');
    expect(deriveBucketFromNouls(nouls, 0.5)).toBe('non_bug_support_question');
  });
});
