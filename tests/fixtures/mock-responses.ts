import type { MessagesResponse } from '../../src/llm-client';

export const TOOL_NAME = 'classify_bug_report';

export const mockResponseFor = (toolInput: unknown): MessagesResponse => ({
  id: 'msg_test_0',
  stop_reason: 'tool_use',
  content: [
    {
      type: 'tool_use',
      id: 'toolu_test_0',
      name: TOOL_NAME,
      input: toolInput,
    },
  ],
});

// Canned LLM outputs — trimmed shapes (no report_id, no original_input).
// These would be the LLM's tool_use.input payloads.

export const cannedActionable = {
  classification: 'actionable_ticket' as const,
  title: 'Project delete leaves stale URL accessible',
  summary:
    'After deletion the old project URL still resolves to a chat-shell 404 with no recovery action.',
  severity: 'medium' as const,
  category: 'project_lifecycle' as const,
  extraction_confidence: 'high' as const,
  expected_behavior:
    'Deleted project URL should show a dedicated unavailable state with a recovery CTA.',
  observed_behavior:
    'Deleted project URL renders a 404 inside the chat layout with no CTA.',
  steps_to_reproduce: [
    'Create a project',
    'Copy URL',
    'Delete the project',
    'Reopen the URL',
  ],
  engineering_notes:
    'Likely the not-found state renders inside the chat layout rather than a dedicated recovery view.',
  missing_information: ['Browser', 'Workspace role'],
};

export const cannedPartial = {
  classification: 'partial_ticket_needs_clarification' as const,
  title: 'Contract Review returns incorrect answer for uploaded PDF',
  summary:
    'User reports Contract Review produced an incorrect answer for a PDF they uploaded.',
  severity: 'high' as const,
  category: 'ai_response' as const,
  extraction_confidence: 'medium' as const,
  expected_behavior:
    'Contract Review should return an accurate answer grounded in the uploaded PDF.',
  observed_behavior:
    'Contract Review returned an answer the user considered wrong.',
  steps_to_reproduce: [
    'Open Contract Review',
    'Upload a PDF',
    'Ask a question',
  ],
  engineering_notes:
    'Need the specific question, the PDF, and the expected vs returned answer before triaging.',
  missing_information: [
    'PDF document',
    'Question asked',
    'Expected answer',
    'Returned answer',
  ],
  clarifying_questions: [
    'Can you share the PDF (or a redacted version)?',
    'What question did you ask, and what did you expect?',
    'What did Contract Review return instead?',
  ],
  what_unlocks_actionable: [
    'The uploaded PDF or a redacted equivalent',
    'The exact question and the expected vs observed answer',
  ],
};

export const cannedTooVague = {
  classification: 'too_vague_request_more_info' as const,
  interpretation:
    'User says an upload feature is not working but did not specify the surface, file type, or error.',
  clarifying_questions: [
    'Where in the product were you trying to upload (Projects, Contract Review, chat attachment)?',
    'What were you uploading (file type, approximate size)?',
    'What happened — an error message, a hang, a silent failure?',
  ],
  suspected_category: 'upload' as const,
};

export const cannedNonBug = {
  classification: 'non_bug_support_question' as const,
  suggested_route: 'docs' as const,
  suggested_response:
    'Project export lives under Project settings → Export. Let me know if that surface is missing or unclear.',
  reasoning:
    'User is asking how to use a feature, not reporting unexpected behavior.',
};

// Intentionally malformed cans (used in failure-path tests).

export const cannedActionableWithExtraKey = {
  ...cannedActionable,
  suggested_route: 'docs' as const, // illegal on actionable_ticket under .strict()
};

export const cannedActionableMissingTitle = (() => {
  const { title: _omitted, ...rest } = cannedActionable;
  return rest;
})();

export const cannedUnknownClassification = {
  ...cannedActionable,
  classification: 'spam' as unknown as 'actionable_ticket',
};

export const cannedActionableWithSneakyIdentityFields = {
  ...cannedActionable,
  report_id: 'WRONG' as unknown as never,
  original_input: 'WRONG' as unknown as never,
};
