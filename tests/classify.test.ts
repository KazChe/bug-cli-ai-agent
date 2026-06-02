/**
 * LLM-layer unit tests use a mock AnthropicClient rather than hitting the real API.
 *
 * Why:
 * - Deterministic: tests assert that our schema + merge + protocol-error code paths
 *   behave correctly given known LLM outputs. They are not measuring the model.
 * - Free + offline: CI runs (and local `bun run test`) require no API key, no network.
 * - Fast: ~11 tests run in under 50ms vs ~30-40 seconds for a real-API equivalent.
 *
 * Real model behavior is validated separately by `scripts/eval.ts` against the
 * corpus in `tests/fixtures/raw-inputs.ts`. That is the right tool for "does Sonnet
 * actually classify these reports correctly," which is a model question, not a code question.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyReport,
  ClassifyError,
} from '../src/classifier/classify';
import type {
  AnthropicClient,
  MessagesResponse,
  MessagesCreateParams,
} from '../src/llm/client';
import {
  mockResponseFor,
  cannedActionable,
  cannedPartial,
  cannedTooVague,
  cannedNonBug,
  cannedActionableWithExtraKey,
  cannedActionableMissingTitle,
  cannedUnknownClassification,
  cannedActionableWithSneakyIdentityFields,
} from './fixtures/mock-responses';

const clientReturning = (resp: MessagesResponse): AnthropicClient => ({
  createMessage: async () => resp,
});

describe('classifyReport — happy paths', () => {
  it('returns an actionable_ticket and merges runner-supplied identity fields', async () => {
    const client = clientReturning(mockResponseFor(cannedActionable));
    const out = await classifyReport('r-1', 'raw input text', client);
    expect(out.classification).toBe('actionable_ticket');
    expect(out.report_id).toBe('r-1');
    expect(out.original_input).toBe('raw input text');
    if (out.classification === 'actionable_ticket') {
      expect(out.title).toBe(cannedActionable.title);
    }
  });

  it('returns a partial_ticket_needs_clarification', async () => {
    const client = clientReturning(mockResponseFor(cannedPartial));
    const out = await classifyReport('r-2', 'partial raw', client);
    expect(out.classification).toBe('partial_ticket_needs_clarification');
    if (out.classification === 'partial_ticket_needs_clarification') {
      expect(out.clarifying_questions.length).toBeGreaterThanOrEqual(1);
      expect(out.what_unlocks_actionable.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns a too_vague_request_more_info', async () => {
    const client = clientReturning(mockResponseFor(cannedTooVague));
    const out = await classifyReport('r-3', 'vague raw', client);
    expect(out.classification).toBe('too_vague_request_more_info');
    if (out.classification === 'too_vague_request_more_info') {
      expect(out.clarifying_questions.length).toBeGreaterThanOrEqual(2);
      expect(out.interpretation.length).toBeGreaterThan(0);
    }
  });

  it('returns a non_bug_support_question', async () => {
    const client = clientReturning(mockResponseFor(cannedNonBug));
    const out = await classifyReport('r-4', 'how do I export?', client);
    expect(out.classification).toBe('non_bug_support_question');
    if (out.classification === 'non_bug_support_question') {
      expect(out.suggested_route).toBe('docs');
    }
  });
});

describe('classifyReport — runner owns identity fields', () => {
  it('rejects an LLM response that sneaks report_id/original_input into the tool input', async () => {
    const client = clientReturning(
      mockResponseFor(cannedActionableWithSneakyIdentityFields),
    );
    await expect(
      classifyReport('r-5', 'truth', client),
    ).rejects.toMatchObject({ stage: 'llm_schema' });
  });
});

describe('classifyReport — validation failures', () => {
  it('rejects an LLM response with an extra key on actionable_ticket (strict mode)', async () => {
    const client = clientReturning(
      mockResponseFor(cannedActionableWithExtraKey),
    );
    await expect(classifyReport('r', 'in', client)).rejects.toBeInstanceOf(
      ClassifyError,
    );
    await expect(classifyReport('r', 'in', client)).rejects.toMatchObject({
      stage: 'llm_schema',
    });
  });

  it('rejects an LLM response missing a required field', async () => {
    const client = clientReturning(mockResponseFor(cannedActionableMissingTitle));
    await expect(classifyReport('r', 'in', client)).rejects.toMatchObject({
      stage: 'llm_schema',
    });
  });

  it('rejects an unknown classification value', async () => {
    const client = clientReturning(mockResponseFor(cannedUnknownClassification));
    await expect(classifyReport('r', 'in', client)).rejects.toMatchObject({
      stage: 'llm_schema',
    });
  });
});

describe('classifyReport — protocol failures', () => {
  it('throws if response has no tool_use block', async () => {
    const client = clientReturning({
      id: 'msg',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I refuse to use the tool.' }],
    });
    await expect(classifyReport('r', 'in', client)).rejects.toMatchObject({
      stage: 'no_tool_use',
    });
  });

  it('throws if response uses a wrong tool name', async () => {
    const client = clientReturning({
      id: 'msg',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't', name: 'some_other_tool', input: {} },
      ],
    });
    await expect(classifyReport('r', 'in', client)).rejects.toMatchObject({
      stage: 'wrong_tool_name',
    });
  });
});

describe('classifyReport — request shape', () => {
  it('forces tool_choice, includes the system prompt with cache_control, and names the tool correctly', async () => {
    let captured: MessagesCreateParams | undefined;
    const client: AnthropicClient = {
      createMessage: async (params) => {
        captured = params;
        return mockResponseFor(cannedActionable);
      },
    };
    await classifyReport('r', 'in', client);
    expect(captured?.tool_choice).toEqual({
      type: 'tool',
      name: 'classify_bug_report',
    });
    expect(captured?.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(captured?.tools[0]?.name).toBe('classify_bug_report');
  });
});
