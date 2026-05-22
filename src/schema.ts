import { z } from 'zod';

// All variants use .strict() so unknown keys fail validation. Rationale: Phase 2 uses
// Anthropic tool-use to populate these shapes; the LLM occasionally hallucinates extra
// keys (e.g. a `suggested_route` on an actionable_ticket). Strict mode catches that at
// the validation layer instead of silently shipping malformed tickets. If the schema
// evolves, update the variant explicitly rather than relaxing strictness.

const Severity = z.enum(['low', 'medium', 'high', 'critical']);
const Category = z.enum([
  'auth',
  'upload',
  'project_lifecycle',
  'ai_response',
  'billing',
  'performance',
  'ui',
  'other',
]);
const Confidence = z.enum(['low', 'medium', 'high']);
const SupportRoute = z.enum([
  'docs',
  'billing',
  'feature_request',
  'status',
  'other',
]);

const baseFields = {
  original_input: z.string().min(1),
  report_id: z.string().min(1),
};

const actionableFields = {
  ...baseFields,
  title: z.string().min(1).max(120),
  summary: z.string().min(1),
  severity: Severity,
  category: Category,
  extraction_confidence: Confidence,
  expected_behavior: z.string().min(1),
  observed_behavior: z.string().min(1),
  steps_to_reproduce: z.array(z.string().min(1)),
  engineering_notes: z.string(),
  missing_information: z.array(z.string()),
};

export const ActionableTicketSchema = z
  .object({
    classification: z.literal('actionable_ticket'),
    ...actionableFields,
  })
  .strict();

export const PartialTicketSchema = z
  .object({
    classification: z.literal('partial_ticket_needs_clarification'),
    ...actionableFields,
    clarifying_questions: z.array(z.string().min(1)).min(1),
    what_unlocks_actionable: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const TooVagueSchema = z
  .object({
    classification: z.literal('too_vague_request_more_info'),
    ...baseFields,
    interpretation: z.string().min(1),
    clarifying_questions: z.array(z.string().min(1)).min(2),
    suspected_category: Category.optional(),
  })
  .strict();

export const NonBugSupportSchema = z
  .object({
    classification: z.literal('non_bug_support_question'),
    ...baseFields,
    suggested_route: SupportRoute,
    suggested_response: z.string().min(1),
    reasoning: z.string().min(1),
  })
  .strict();

export const ParsedReportSchema = z.discriminatedUnion('classification', [
  ActionableTicketSchema,
  PartialTicketSchema,
  TooVagueSchema,
  NonBugSupportSchema,
]);

export type ActionableTicket = z.infer<typeof ActionableTicketSchema>;
export type PartialTicket = z.infer<typeof PartialTicketSchema>;
export type TooVague = z.infer<typeof TooVagueSchema>;
export type NonBugSupport = z.infer<typeof NonBugSupportSchema>;
export type ParsedReport = z.infer<typeof ParsedReportSchema>;
