/**
 * Hybrid engine tests: Jev routes, the LLM drafts only when there is something
 * to draft. Both clients are mocked; nothing here touches the network.
 */
import { describe, it, expect } from 'vitest';
import { classifyReportHybrid, ClassifyError } from '../src/classifier/classify';
import { ParsedReportSchema } from '../src/schema/parsed-report';
import { DRAFT_SYSTEM_PROMPT } from '../src/llm/prompt';
import type { AnthropicClient, MessagesCreateParams } from '../src/llm/client';
import {
  mockResponseFor,
  cannedActionable,
  cannedPartial,
  cannedNonBug,
} from './fixtures/mock-responses';
import { mockJevResponse, jevClientReturning } from './fixtures/mock-jev';

const neverCalled: AnthropicClient = {
  createMessage: async () => {
    throw new Error('Anthropic must not be called for this bucket');
  },
};

const capturing = (
  toolInput: unknown,
): { client: AnthropicClient; params: () => MessagesCreateParams | undefined } => {
  let captured: MessagesCreateParams | undefined;
  return {
    client: {
      createMessage: async (params) => {
        captured = params;
        return {
          ...mockResponseFor(toolInput),
          usage: { input_tokens: 800, output_tokens: 250 },
        };
      },
    },
    params: () => captured,
  };
};

describe('classifyReportHybrid: LLM path', () => {
  it('drafts an actionable ticket with the bucket pinned in the tool schema', async () => {
    const jev = jevClientReturning(mockJevResponse('actionable_ticket', { route: 'docs' }));
    const { client, params } = capturing(cannedActionable);

    const out = await classifyReportHybrid('r-1', 'raw text', jev, client);

    expect(out.report.classification).toBe('actionable_ticket');
    expect(out.report.report_id).toBe('r-1');
    expect(out.usage?.input_tokens).toBe(800);
    expect(out.report.triage).toMatchObject({
      engine: 'jev',
      model: 'jev-1.13.0',
      bucket: 'actionable_ticket',
      confidence: 0.91,
      input_tokens: 321,
      llm_called: true,
    });
    expect(out.report.triage?.probabilities.actionable_ticket).toBeCloseTo(0.94);
    expect(out.report.triage?.route?.choice).toBe('docs');

    const sent = params();
    expect(sent?.system[0]?.text).toBe(DRAFT_SYSTEM_PROMPT);
    expect(sent?.tool_choice).toEqual({ type: 'tool', name: 'classify_bug_report' });
    const schema = sent?.tools[0]?.input_schema as {
      properties: { classification: { enum?: string[]; const?: string } };
    };
    const pinned = schema.properties.classification;
    expect(pinned.enum ?? [pinned.const]).toEqual(['actionable_ticket']);
    expect(sent?.messages[0]?.content).toContain('Classification (already decided): actionable_ticket');
  });

  it('drafts a partial ticket the same way', async () => {
    const jev = jevClientReturning(
      mockJevResponse('partial_ticket_needs_clarification', { route: 'other' }),
    );
    const { client } = capturing(cannedPartial);
    const out = await classifyReportHybrid('r-2', 'raw', jev, client);
    expect(out.report.classification).toBe('partial_ticket_needs_clarification');
    expect(out.report.triage?.llm_called).toBe(true);
  });

  it('reports bucket_mismatch, before schema validation, when the LLM overrides the pin', async () => {
    const jev = jevClientReturning(mockJevResponse('actionable_ticket', { route: 'docs' }));
    // The LLM answers with a valid non_bug payload despite the pinned actionable bucket.
    const { client } = capturing(cannedNonBug);
    await expect(classifyReportHybrid('r-3', 'raw', jev, client)).rejects.toMatchObject({
      stage: 'bucket_mismatch',
    });
  });

  it('still blames the LLM for schema drift when the bucket matches', async () => {
    const jev = jevClientReturning(mockJevResponse('actionable_ticket', { route: 'docs' }));
    const { client } = capturing({ ...cannedActionable, suggested_route: 'docs' });
    await expect(classifyReportHybrid('r-4', 'raw', jev, client)).rejects.toMatchObject({
      stage: 'llm_schema',
    });
  });

  it('rejects a Jev response without a route, since the hybrid always asks for one', async () => {
    const jev = jevClientReturning(mockJevResponse('actionable_ticket'));
    const { client } = capturing(cannedActionable);
    await expect(classifyReportHybrid('r-5', 'raw', jev, client)).rejects.toThrow(
      /support_route/,
    );
  });
});

describe('classifyReportHybrid: templated path (no LLM call)', () => {
  it('answers too_vague from a template that satisfies the strict schema', async () => {
    const jev = jevClientReturning(
      mockJevResponse('too_vague_request_more_info', { route: 'other', confidence: 0.77 }),
    );
    const out = await classifyReportHybrid('r-6', 'it broke', jev, neverCalled);
    expect(out.report.classification).toBe('too_vague_request_more_info');
    expect(out).not.toHaveProperty('usage');
    if (out.report.classification === 'too_vague_request_more_info') {
      expect(out.report.clarifying_questions.length).toBeGreaterThanOrEqual(2);
      expect(out.report.interpretation.length).toBeGreaterThan(0);
      expect(out.report).not.toHaveProperty('suspected_category');
    }
    expect(out.report.triage).toMatchObject({ llm_called: false, confidence: 0.77 });
    expect(ParsedReportSchema.safeParse(out.report).success).toBe(true);
  });

  it('answers non_bug from a template using the Jev route', async () => {
    const jev = jevClientReturning(
      mockJevResponse('non_bug_support_question', { route: 'billing' }),
    );
    const out = await classifyReportHybrid('r-7', 'was I charged twice?', jev, neverCalled);
    expect(out.report.classification).toBe('non_bug_support_question');
    if (out.report.classification === 'non_bug_support_question') {
      expect(out.report.suggested_route).toBe('billing');
      expect(out.report.suggested_response).toContain('billing');
      expect(out.report.reasoning).toContain('without an LLM call');
    }
    expect(out.report.triage?.llm_called).toBe(false);
    expect(out.report.triage?.route?.probabilities.billing).toBeCloseTo(0.92);
    expect(ParsedReportSchema.safeParse(out.report).success).toBe(true);
  });

  it('propagates a Jev failure as-is', async () => {
    const jev = jevClientReturning(mockJevResponse('spam' as never, { route: 'docs' }));
    await expect(classifyReportHybrid('r-8', 'raw', jev, neverCalled)).rejects.not.toBeInstanceOf(
      ClassifyError,
    );
  });
});
