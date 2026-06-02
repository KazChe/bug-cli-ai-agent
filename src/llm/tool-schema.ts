import { z } from 'zod';
import {
  ActionableTicketSchema,
  PartialTicketSchema,
  TooVagueSchema,
  NonBugSupportSchema,
} from '../schema/parsed-report';

// The LLM never emits report_id or original_input — those are runner-assigned facts.
// Omitting them from the per-variant schemas reduces hallucination surface and keeps
// the runner as the source of truth. The final ParsedReportSchema validation in
// classify.ts re-attaches them and asserts the full contract.
const OMIT = { original_input: true, report_id: true } as const;

const ActionableForLLM = ActionableTicketSchema.omit(OMIT).strict();
const PartialForLLM = PartialTicketSchema.omit(OMIT).strict();
const TooVagueForLLM = TooVagueSchema.omit(OMIT).strict();
const NonBugForLLM = NonBugSupportSchema.omit(OMIT).strict();

// Post-call validator: strict + discriminated. Enforces per-variant required fields
// and rejects any extra keys the model might hallucinate. This is what classify.ts
// parses tool_use.input against.
export const LLMOutputSchema = z.discriminatedUnion('classification', [
  ActionableForLLM,
  PartialForLLM,
  TooVagueForLLM,
  NonBugForLLM,
]);
export type LLMOutput = z.infer<typeof LLMOutputSchema>;

// Anthropic's tool input_schema validator rejects oneOf / anyOf / allOf at the
// top level, so we can't hand them the JSON Schema generated from our
// discriminated union. Instead we expose a FLAT object schema where
// `classification` is the only required field and every variant field is
// optional at the schema layer. The model picks a classification and fills the
// matching fields per the system prompt's rubric; per-variant required-field
// enforcement happens after the call in LLMOutputSchema.safeParse above.
//
// Field definitions duplicate the per-variant Zod schemas. If those change in
// schema.ts, update this flat schema too — tests will catch divergence.

const ClassificationLiteral = z.enum([
  'actionable_ticket',
  'partial_ticket_needs_clarification',
  'too_vague_request_more_info',
  'non_bug_support_question',
]);
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

const FlatLLMSchema = z.object({
  classification: ClassificationLiteral,
  title: z.string().min(1).max(120).optional(),
  summary: z.string().min(1).optional(),
  severity: Severity.optional(),
  category: Category.optional(),
  extraction_confidence: Confidence.optional(),
  expected_behavior: z.string().min(1).optional(),
  observed_behavior: z.string().min(1).optional(),
  steps_to_reproduce: z.array(z.string().min(1)).optional(),
  engineering_notes: z.string().optional(),
  missing_information: z.array(z.string()).optional(),
  clarifying_questions: z.array(z.string().min(1)).optional(),
  what_unlocks_actionable: z.array(z.string().min(1)).optional(),
  interpretation: z.string().min(1).optional(),
  suspected_category: Category.optional(),
  suggested_route: SupportRoute.optional(),
  suggested_response: z.string().min(1).optional(),
  reasoning: z.string().min(1).optional(),
});

export const llmToolInputJSONSchema = z.toJSONSchema(FlatLLMSchema, {
  target: 'draft-2020-12',
  unrepresentable: 'throw',
});
