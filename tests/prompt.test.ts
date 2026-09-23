/**
 * Guards the prompt refactor. SYSTEM_PROMPT was split into named sections so
 * the hybrid engine could reuse them; this proves the default engine's prompt
 * did not change by a single byte, which is what keeps `bun run eval`
 * comparable to the published baseline.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  SYSTEM_PROMPT,
  SYSTEM_BLOCKS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_SYSTEM_BLOCKS,
} from '../src/llm/prompt';
import { SYSTEM_PROMPT_SNAPSHOT } from './fixtures/system-prompt.snapshot';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('SYSTEM_PROMPT is byte-identical to the pre-refactor snapshot', () => {
  it('equals the snapshot string exactly', () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT_SNAPSHOT);
    expect(sha256(SYSTEM_PROMPT)).toBe(sha256(SYSTEM_PROMPT_SNAPSHOT));
  });

  it('is what SYSTEM_BLOCKS sends, with cache_control intact', () => {
    expect(SYSTEM_BLOCKS[0]?.text).toBe(SYSTEM_PROMPT_SNAPSHOT);
    expect(SYSTEM_BLOCKS[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('DRAFT_SYSTEM_PROMPT', () => {
  it('drops the decision order and says the bucket is already chosen', () => {
    expect(SYSTEM_PROMPT).toContain('# Decision order');
    expect(DRAFT_SYSTEM_PROMPT).not.toContain('# Decision order');
    expect(DRAFT_SYSTEM_PROMPT).toContain('already been decided');
  });

  it('keeps the field discipline and rubric sections', () => {
    for (const heading of [
      '# Severity rubric',
      '# Anti-hallucination rules',
      '# CRITICAL: field discipline by classification',
    ]) {
      expect(DRAFT_SYSTEM_PROMPT).toContain(heading);
    }
  });

  it('is cached the same way', () => {
    expect(DRAFT_SYSTEM_BLOCKS[0]?.text).toBe(DRAFT_SYSTEM_PROMPT);
    expect(DRAFT_SYSTEM_BLOCKS[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
