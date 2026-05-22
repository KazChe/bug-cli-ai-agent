/**
 * CLI runner tests use a mock AnthropicClient that switches its response based on
 * the input string content — keeps the test deterministic without coupling to the
 * real model. Bad-input cases (non-JSON, non-array, non-string elements) are also
 * covered so we know the CLI fails loud on malformed input.
 */
import { describe, it, expect } from 'vitest';
import {
  runCli,
  parseInput,
  resolveInputSource,
  USAGE,
  CliInputError,
} from '../src/cli';
import type {
  AnthropicClient,
  MessagesCreateParams,
  MessagesResponse,
} from '../src/llm-client';
import {
  mockResponseFor,
  cannedActionable,
  cannedNonBug,
  cannedActionableMissingTitle,
} from './fixtures/mock-responses';

const routingClient = (
  route: (userMessage: string) => MessagesResponse,
): AnthropicClient => ({
  createMessage: async (params: MessagesCreateParams) => {
    const userMsg = params.messages[0]?.content ?? '';
    return route(userMsg);
  },
});

describe('resolveInputSource', () => {
  it('returns {kind: "file"} when a non-empty path arg is given and stdin is a TTY', () => {
    // Even if stdin happens to be a TTY, an explicit file path wins.
    expect(resolveInputSource(['input.json'], true)).toEqual({
      kind: 'file',
      path: 'input.json',
    });
  });

  it('returns {kind: "file"} when a path arg is given and stdin is piped', () => {
    expect(resolveInputSource(['input.json'], false)).toEqual({
      kind: 'file',
      path: 'input.json',
    });
  });

  it('returns {kind: "stdin"} when no args and stdin is piped (not a TTY)', () => {
    expect(resolveInputSource([], false)).toEqual({ kind: 'stdin' });
  });

  it('returns {kind: "usage"} when no args and stdin is a TTY (terminal, nothing piped)', () => {
    const result = resolveInputSource([], true);
    expect(result.kind).toBe('usage');
    if (result.kind === 'usage') {
      expect(result.message).toBe(USAGE);
      expect(result.message).toContain('Usage:');
      expect(result.message).toContain('bun run cli');
    }
  });

  it('treats an empty-string arg as missing and falls back to stdin/usage rules', () => {
    expect(resolveInputSource([''], false)).toEqual({ kind: 'stdin' });
    expect(resolveInputSource([''], true).kind).toBe('usage');
  });
});

describe('parseInput', () => {
  it('parses a valid JSON array of strings', () => {
    expect(parseInput('["a", "b", "c"]')).toEqual(['a', 'b', 'c']);
  });

  it('accepts an empty array', () => {
    expect(parseInput('[]')).toEqual([]);
  });

  it('throws CliInputError on invalid JSON', () => {
    expect(() => parseInput('not json')).toThrow(CliInputError);
  });

  it('throws CliInputError when input is not an array', () => {
    expect(() => parseInput('{"foo": "bar"}')).toThrow(CliInputError);
  });

  it('throws CliInputError when array contains non-string elements', () => {
    expect(() => parseInput('["ok", 42, "also ok"]')).toThrow(CliInputError);
  });
});

describe('runCli', () => {
  it('returns one OutputEntry per input, in order, with positional report_ids', async () => {
    const client = routingClient(() => mockResponseFor(cannedActionable));
    const out = await runCli('["one", "two", "three"]', client, {
      concurrency: 2,
    });
    expect(out).toHaveLength(3);
    expect(out[0]?.report_id).toBe('report-0');
    expect(out[1]?.report_id).toBe('report-1');
    expect(out[2]?.report_id).toBe('report-2');
    expect(out[0]?.original_input).toBe('one');
    expect(out[1]?.original_input).toBe('two');
  });

  it('returns inline error envelopes for entries that fail classification', async () => {
    const client = routingClient((userMsg) =>
      mockResponseFor(
        userMsg.includes('break me')
          ? cannedActionableMissingTitle
          : cannedActionable,
      ),
    );
    const out = await runCli('["good", "break me", "also good"]', client);

    expect(out).toHaveLength(3);
    expect(out[0]?.classification).toBe('actionable_ticket');
    expect(out[1]?.classification).toBe('error');
    expect(out[2]?.classification).toBe('actionable_ticket');

    if (out[1]?.classification === 'error') {
      expect(out[1].original_input).toBe('break me');
      expect(out[1].error.stage).toBe('llm_schema');
      expect(out[1].error.message.length).toBeGreaterThan(0);
    }
  });

  it('handles a mix of variants in one batch', async () => {
    const client = routingClient((userMsg) =>
      mockResponseFor(
        userMsg.includes('how do I') ? cannedNonBug : cannedActionable,
      ),
    );
    const out = await runCli(
      '["I deleted a project and 404", "how do I export?"]',
      client,
    );
    expect(out[0]?.classification).toBe('actionable_ticket');
    expect(out[1]?.classification).toBe('non_bug_support_question');
  });

  it('returns an empty array for empty input', async () => {
    const client = routingClient(() => mockResponseFor(cannedActionable));
    const out = await runCli('[]', client);
    expect(out).toEqual([]);
  });
});
