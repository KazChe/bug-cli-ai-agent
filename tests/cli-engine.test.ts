/**
 * --engine plumbing: argv parsing, runCli dispatch, and the batch summary the
 * CLI prints to stderr for the jev engine.
 */
import { describe, it, expect } from 'vitest';
import {
  runCli,
  parseCliArgs,
  summarizeBatch,
  formatBatchSummary,
  CliInputError,
  USAGE,
} from '../src/cli/runner';
import type { AnthropicClient } from '../src/llm/client';
import { mockResponseFor, cannedActionable, cannedNonBug } from './fixtures/mock-responses';
import { mockJevResponse, jevRoutingClient } from './fixtures/mock-jev';

describe('parseCliArgs', () => {
  it('defaults to anthropic and passes other args through in order', () => {
    expect(parseCliArgs(['input.json'])).toEqual({ engine: 'anthropic', rest: ['input.json'] });
    expect(parseCliArgs([])).toEqual({ engine: 'anthropic', rest: [] });
  });

  it('accepts --engine jev in both spellings, anywhere in argv', () => {
    expect(parseCliArgs(['--engine', 'jev', 'input.json'])).toEqual({
      engine: 'jev',
      rest: ['input.json'],
    });
    expect(parseCliArgs(['input.json', '--engine=jev'])).toEqual({
      engine: 'jev',
      rest: ['input.json'],
    });
  });

  it('honors a default engine from the environment but lets argv win', () => {
    expect(parseCliArgs(['x'], 'jev').engine).toBe('jev');
    expect(parseCliArgs(['--engine', 'anthropic', 'x'], 'jev').engine).toBe('anthropic');
  });

  it('rejects unknown or missing engine values', () => {
    expect(() => parseCliArgs(['--engine', 'gpt'])).toThrow(CliInputError);
    expect(() => parseCliArgs(['--engine'])).toThrow(CliInputError);
    expect(() => parseCliArgs(['--engine='])).toThrow(CliInputError);
  });

  it('documents the flag in USAGE', () => {
    expect(USAGE).toContain('--engine jev');
  });
});

describe('runCli with engine jev', () => {
  const jev = jevRoutingClient((report) =>
    report.includes('how do I')
      ? mockJevResponse('non_bug_support_question', { route: 'docs' })
      : mockJevResponse('actionable_ticket', { route: 'other' }),
  );

  it('requires a jev client', async () => {
    const anthropic: AnthropicClient = {
      createMessage: async () => mockResponseFor(cannedActionable),
    };
    await expect(runCli('["x"]', anthropic, { engine: 'jev' })).rejects.toBeInstanceOf(
      CliInputError,
    );
  });

  it('routes each entry through Jev and only drafts where needed', async () => {
    let anthropicCalls = 0;
    const anthropic: AnthropicClient = {
      createMessage: async () => {
        anthropicCalls += 1;
        return mockResponseFor(cannedActionable);
      },
    };
    const out = await runCli(
      '["I deleted a project and got a 404", "how do I export?"]',
      anthropic,
      { engine: 'jev', jev, concurrency: 1 },
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.classification).toBe('actionable_ticket');
    expect(out[1]?.classification).toBe('non_bug_support_question');
    expect(anthropicCalls).toBe(1);
    if (out[0]?.classification === 'actionable_ticket') {
      expect(out[0].triage?.llm_called).toBe(true);
    }
    if (out[1]?.classification === 'non_bug_support_question') {
      expect(out[1].triage?.llm_called).toBe(false);
      expect(out[1].suggested_route).toBe('docs');
    }
  });

  it('turns a bucket override into an inline error envelope', async () => {
    const anthropic: AnthropicClient = {
      createMessage: async () => mockResponseFor(cannedNonBug),
    };
    const out = await runCli('["I deleted a project"]', anthropic, { engine: 'jev', jev });
    expect(out[0]?.classification).toBe('error');
    if (out[0]?.classification === 'error') {
      expect(out[0].error.stage).toBe('bucket_mismatch');
    }
  });

  it('leaves the default engine untouched', async () => {
    let jevCalls = 0;
    const countingJev = jevRoutingClient(() => {
      jevCalls += 1;
      return mockJevResponse('actionable_ticket', { route: 'other' });
    });
    const anthropic: AnthropicClient = {
      createMessage: async () => mockResponseFor(cannedActionable),
    };
    const out = await runCli('["x"]', anthropic, { jev: countingJev });
    expect(jevCalls).toBe(0);
    expect(out[0]).not.toHaveProperty('triage');
  });
});

describe('summarizeBatch', () => {
  it('counts routing, LLM calls, and override attempts', async () => {
    const jev = jevRoutingClient((report) =>
      report.includes('vague')
        ? mockJevResponse('too_vague_request_more_info', { route: 'other' })
        : mockJevResponse('actionable_ticket', { route: 'other' }),
    );
    let calls = 0;
    const anthropic: AnthropicClient = {
      createMessage: async () => {
        calls += 1;
        // First LLM call cooperates, the second overrides the pinned bucket.
        return mockResponseFor(calls === 1 ? cannedActionable : cannedNonBug);
      },
    };
    const out = await runCli('["one", "vague", "three"]', anthropic, {
      engine: 'jev',
      jev,
      concurrency: 1,
    });
    const s = summarizeBatch(out);
    expect(s).toMatchObject({
      total: 3,
      errors: 1,
      triaged: 2,
      llmCalls: 1,
      llmSkipped: 1,
      bucketMismatches: 1,
    });
    expect(s.routed.actionable_ticket).toBe(1);
    expect(s.routed.too_vague_request_more_info).toBe(1);
    const text = formatBatchSummary(s);
    expect(text).toContain('LLM calls: 1 made, 1 skipped');
    expect(text).toContain('bucket_mismatch: 1');
  });

  it('is all zeros for a default-engine batch', () => {
    const s = summarizeBatch([
      { ...cannedActionable, report_id: 'r', original_input: 'x' },
    ]);
    expect(s.triaged).toBe(0);
    expect(s.llmCalls).toBe(0);
    expect(s.errors).toBe(0);
  });
});
