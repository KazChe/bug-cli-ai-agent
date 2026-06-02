import { describe, it, expect } from 'vitest';
import { ParsedReportSchema } from '../src/schema/parsed-report';
import {
  validActionable,
  validPartial,
  validTooVague,
  validNonBug,
} from './fixtures/valid-samples';

const errorPaths = (result: ReturnType<typeof ParsedReportSchema.safeParse>): string[] => {
  if (result.success) return [];
  return result.error.issues.flatMap((i) => i.path.map((p) => String(p)));
};

describe('ParsedReportSchema — happy paths', () => {
  it('parses a valid actionable_ticket', () => {
    const result = ParsedReportSchema.safeParse(validActionable);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(validActionable);
  });

  it('parses a valid partial_ticket_needs_clarification', () => {
    const result = ParsedReportSchema.safeParse(validPartial);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(validPartial);
  });

  it('parses a valid too_vague_request_more_info', () => {
    const result = ParsedReportSchema.safeParse(validTooVague);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(validTooVague);
  });

  it('parses a valid non_bug_support_question', () => {
    const result = ParsedReportSchema.safeParse(validNonBug);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(validNonBug);
  });
});

describe('ParsedReportSchema — discriminator routing', () => {
  it('routes actionable shape with partial classification to partial schema and complains about missing partial-only fields', () => {
    const { classification: _c, ...rest } = validActionable;
    const mismatched = {
      classification: 'partial_ticket_needs_clarification',
      ...rest,
    };
    const result = ParsedReportSchema.safeParse(mismatched);
    expect(result.success).toBe(false);
    const paths = errorPaths(result);
    expect(paths).toContain('clarifying_questions');
    expect(paths).toContain('what_unlocks_actionable');
  });

  it('rejects an unknown classification value', () => {
    const result = ParsedReportSchema.safeParse({
      ...validActionable,
      classification: 'spam',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing classification', () => {
    const { classification: _c, ...rest } = validActionable;
    const result = ParsedReportSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe('ParsedReportSchema — required field omissions', () => {
  const actionableRequired = [
    'report_id',
    'original_input',
    'title',
    'summary',
    'severity',
    'category',
    'extraction_confidence',
    'expected_behavior',
    'observed_behavior',
    'steps_to_reproduce',
    'engineering_notes',
    'missing_information',
  ] as const;

  it.each(actionableRequired)(
    'actionable_ticket fails when %s is omitted',
    (field) => {
      const { [field]: _omitted, ...rest } = validActionable;
      const result = ParsedReportSchema.safeParse(rest);
      expect(result.success).toBe(false);
      expect(errorPaths(result)).toContain(field);
    },
  );

  const partialExtra = ['clarifying_questions', 'what_unlocks_actionable'] as const;

  it.each(partialExtra)(
    'partial_ticket_needs_clarification fails when %s is omitted',
    (field) => {
      const { [field]: _omitted, ...rest } = validPartial;
      const result = ParsedReportSchema.safeParse(rest);
      expect(result.success).toBe(false);
      expect(errorPaths(result)).toContain(field);
    },
  );

  const tooVagueRequired = ['interpretation', 'clarifying_questions'] as const;

  it.each(tooVagueRequired)(
    'too_vague_request_more_info fails when %s is omitted',
    (field) => {
      const { [field]: _omitted, ...rest } = validTooVague;
      const result = ParsedReportSchema.safeParse(rest);
      expect(result.success).toBe(false);
      expect(errorPaths(result)).toContain(field);
    },
  );

  const nonBugRequired = ['suggested_route', 'suggested_response', 'reasoning'] as const;

  it.each(nonBugRequired)(
    'non_bug_support_question fails when %s is omitted',
    (field) => {
      const { [field]: _omitted, ...rest } = validNonBug;
      const result = ParsedReportSchema.safeParse(rest);
      expect(result.success).toBe(false);
      expect(errorPaths(result)).toContain(field);
    },
  );
});

describe('ParsedReportSchema — enum violations', () => {
  it('rejects an invalid severity', () => {
    const result = ParsedReportSchema.safeParse({
      ...validActionable,
      severity: 'urgent',
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('severity');
  });

  it('rejects an invalid category', () => {
    const result = ParsedReportSchema.safeParse({
      ...validActionable,
      category: 'database',
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('category');
  });

  it('rejects an invalid extraction_confidence', () => {
    const result = ParsedReportSchema.safeParse({
      ...validActionable,
      extraction_confidence: 'certain',
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('extraction_confidence');
  });

  it('rejects an invalid suggested_route on non_bug variant', () => {
    const result = ParsedReportSchema.safeParse({
      ...validNonBug,
      suggested_route: 'engineering',
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('suggested_route');
  });
});

describe('ParsedReportSchema — array constraints', () => {
  it('partial_ticket rejects an empty clarifying_questions array', () => {
    const result = ParsedReportSchema.safeParse({
      ...validPartial,
      clarifying_questions: [],
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('clarifying_questions');
  });

  it('partial_ticket rejects an empty what_unlocks_actionable array', () => {
    const result = ParsedReportSchema.safeParse({
      ...validPartial,
      what_unlocks_actionable: [],
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('what_unlocks_actionable');
  });

  it('too_vague rejects a single-item clarifying_questions array', () => {
    const result = ParsedReportSchema.safeParse({
      ...validTooVague,
      clarifying_questions: ['only one question'],
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('clarifying_questions');
  });
});

describe('ParsedReportSchema — strict mode', () => {
  it('actionable_ticket rejects an unknown extra key (.strict() wired)', () => {
    const result = ParsedReportSchema.safeParse({
      ...validActionable,
      clarifying_questions: ['this does not belong on an actionable ticket'],
    });
    expect(result.success).toBe(false);
  });

  it('non_bug rejects an unknown extra key', () => {
    const result = ParsedReportSchema.safeParse({
      ...validNonBug,
      severity: 'high',
    });
    expect(result.success).toBe(false);
  });
});

describe('ParsedReportSchema — type narrowing', () => {
  it('narrows correctly on the discriminator', () => {
    const result = ParsedReportSchema.safeParse(validActionable);
    expect(result.success).toBe(true);
    if (result.success && result.data.classification === 'actionable_ticket') {
      expect(result.data.title).toBe(validActionable.title);
      // @ts-expect-error — suggested_route only exists on non_bug_support_question
      result.data.suggested_route;
    }
  });
});
