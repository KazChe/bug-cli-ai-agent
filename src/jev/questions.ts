/**
 * Jev question definitions for the bucket decision.
 *
 * This module is deliberately free of the TypeSafe SDK import so that unit
 * tests and the eval script can build and inspect questions without a client.
 * The plain objects below match the wire shape the SDK's choice() and noul()
 * helpers produce, and client.ts hands them to the SDK unchanged.
 *
 * Design notes, all drawn from the TypeSafe docs:
 * - Facts live in state, judgment lives in instructions. The product
 *   description is a fact the report is compared against, so it is a named
 *   state field rather than part of the instructions.
 * - Criteria use { what, not_for, examples } objects because the four buckets
 *   are easy to confuse at the boundaries. Examples are fresh text, never rows
 *   from the eval corpus, so the eval cannot leak its own labels.
 * - The prompt's "fewer than ~10 meaningful words" rule is not carried over.
 *   Jev does not count reliably; the rule's intent (cannot tell which part of
 *   the product or what went wrong) is stated instead.
 * - No fifth "other" bucket. The taxonomy is closed by construction:
 *   too_vague and non_bug are the catch-alls, and the eval compares against
 *   exactly four labels.
 */
import { createHash } from 'node:crypto';
import type { NonBugSupport, ParsedReport } from '../schema/types';

export type Bucket = ParsedReport['classification'];
export type SupportRoute = NonBugSupport['suggested_route'];

export const BUCKETS = [
  'actionable_ticket',
  'partial_ticket_needs_clarification',
  'too_vague_request_more_info',
  'non_bug_support_question',
] as const satisfies readonly Bucket[];

export const SUPPORT_ROUTES = [
  'docs',
  'billing',
  'feature_request',
  'status',
  'other',
] as const satisfies readonly SupportRoute[];

// Wire shapes. Kept local so this module has no SDK dependency.
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string | Record<string, string>;
  criteria: Record<string, string | Record<string, string | string[]>>;
}
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export type JevState = {
  product: string;
  report: string;
};

export const PRODUCT_CONTEXT =
  'A legal-AI SaaS product with project workspaces, document upload, chat-based AI review of documents, billing, and authentication (including SSO).';

export function buildTriageState(raw: string): JevState {
  return { product: PRODUCT_CONTEXT, report: raw };
}

type Criterion = {
  what: string;
  not_for: string;
  examples: string[];
};

export const TRIAGE_INSTRUCTIONS = {
  task: 'Classify `report`, a message sent to the support inbox of the product described in `product`, into the triage bucket it belongs in.',
  priority:
    'If more than one bucket seems to apply, prefer the earliest in this order: non_bug_support_question, too_vague_request_more_info, partial_ticket_needs_clarification, actionable_ticket.',
} satisfies Record<string, string>;

export const TRIAGE_CRITERIA: Record<Bucket, Criterion> = {
  actionable_ticket: {
    what: 'Reports unexpected behavior in a specific part of the product with enough detail to start investigating: what the user did, what they expected, and what happened instead. Steps can be assembled from the message even if they are not numbered.',
    not_for:
      'Reports where the expected or observed behavior is missing or unclear; messages asking how the product works or about account state.',
    examples: [
      'Clicking Save after renaming a workspace reverts the name on refresh. Steps: open workspace settings, rename, save, reload. Chrome 130, Team plan. Expected the new name to stick.',
    ],
  },
  partial_ticket_needs_clarification: {
    what: 'Clearly describes something broken in a named part of the product, but facts needed to investigate are missing, such as the exact error text, the specific document or question involved, which users are affected, or what output was expected.',
    not_for:
      'Reports that already state what was expected and what happened with reproducible detail; messages too thin to tell which part of the product is involved.',
    examples: [
      'The AI summary of my deposition transcript got several dates wrong. Please fix.',
    ],
  },
  too_vague_request_more_info: {
    what: 'Too thin to tell which part of the product is involved or what went wrong. Includes bare complaints, general sentiment, and pasted error output with no description of what the user was doing.',
    not_for:
      'Messages that name both a product area and a symptom; questions about how to use the product.',
    examples: ['nothing loads', 'this release is terrible'],
  },
  non_bug_support_question: {
    what: 'Asks how to use the product, asks about billing or account state, asks whether the service is down, or requests a feature. Does not describe unexpected behavior that needs fixing.',
    not_for: 'Descriptions of something in the product that is broken.',
    examples: [
      'Can I invite outside counsel to a single project without giving them workspace access?',
      'Why does my invoice show two line items this month?',
    ],
  },
};

export const ROUTE_INSTRUCTIONS =
  'Assuming `report` is a support question rather than a bug report, which resource should answer it?';

export const ROUTE_CRITERIA: Record<SupportRoute, string> = {
  docs: 'A question about how to use the product or where a feature lives.',
  billing:
    'A question about plans, invoices, charges, refunds, or account state.',
  feature_request:
    'A request for functionality the product does not currently have.',
  status: 'A question about whether the service is down or degraded.',
  other: 'A support question that fits none of the other routes.',
};

// The three conditions in the prompt's decision order, as separate Nouls.
// Asked in the same call as the Choice so they cost almost nothing extra.
export const NOUL_KEYS = [
  'asks_how_product_works',
  'names_surface_and_symptom',
  'states_expected_and_observed',
] as const;
export type NoulKey = (typeof NOUL_KEYS)[number];

export const NOUL_INSTRUCTIONS: Record<NoulKey, string> = {
  asks_how_product_works:
    '`report` is a question or request about how the product works, about billing or account state, about service status, or a feature request, rather than a description of something broken.',
  names_surface_and_symptom:
    '`report` makes clear both which part of the product is involved and what went wrong.',
  states_expected_and_observed:
    'From `report` alone, a reader could say both what the user expected to happen and what actually happened.',
};

export interface BuildQuestionsOptions {
  includeNouls?: boolean;
  includeRoute?: boolean;
}

export function buildTriageQuestions(
  options: BuildQuestionsOptions = {},
): JevQuestions {
  const questions: JevQuestions = {
    bucket: {
      type: 'choice',
      instructions: TRIAGE_INSTRUCTIONS,
      criteria: TRIAGE_CRITERIA,
    },
  };
  if (options.includeNouls) {
    for (const key of NOUL_KEYS) {
      questions[key] = { type: 'noul', instructions: NOUL_INSTRUCTIONS[key] };
    }
  }
  if (options.includeRoute) {
    questions['support_route'] = {
      type: 'choice',
      instructions: ROUTE_INSTRUCTIONS,
      criteria: ROUTE_CRITERIA,
    };
  }
  return questions;
}

/**
 * Fingerprint of everything that shapes the bucket decision. Recorded in the
 * eval artifact so a reader can tell whether two runs used the same criteria.
 */
export function criteriaSha256(): string {
  const payload = JSON.stringify({
    product: PRODUCT_CONTEXT,
    instructions: TRIAGE_INSTRUCTIONS,
    criteria: TRIAGE_CRITERIA,
    nouls: NOUL_INSTRUCTIONS,
  });
  return createHash('sha256').update(payload).digest('hex');
}
