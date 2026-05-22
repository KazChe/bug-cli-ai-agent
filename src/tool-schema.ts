import { z } from 'zod';
import {
  ActionableTicketSchema,
  PartialTicketSchema,
  TooVagueSchema,
  NonBugSupportSchema,
} from './schema';

// The LLM never emits report_id or original_input — those are runner-assigned facts.
// Omitting them from the tool input_schema reduces hallucination surface and keeps the
// runner as the source of truth. The final ParsedReportSchema validation in classify.ts
// re-attaches them and asserts the full contract.
const OMIT = { original_input: true, report_id: true } as const;

const ActionableForLLM = ActionableTicketSchema.omit(OMIT).strict();
const PartialForLLM = PartialTicketSchema.omit(OMIT).strict();
const TooVagueForLLM = TooVagueSchema.omit(OMIT).strict();
const NonBugForLLM = NonBugSupportSchema.omit(OMIT).strict();

export const LLMOutputSchema = z.discriminatedUnion('classification', [
  ActionableForLLM,
  PartialForLLM,
  TooVagueForLLM,
  NonBugForLLM,
]);

export type LLMOutput = z.infer<typeof LLMOutputSchema>;

// reused: 'inline' keeps the schema flat (no $ref/$defs). Each branch carries its full
// field list, which empirically improves field-completion fidelity for tagged unions.
export const llmToolInputJSONSchema = z.toJSONSchema(LLMOutputSchema, {
  target: 'draft-2020-12',
  unrepresentable: 'throw',
  reused: 'inline',
});
