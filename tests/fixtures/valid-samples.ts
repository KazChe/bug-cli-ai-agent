import type {
  ActionableTicket,
  PartialTicket,
  TooVague,
  NonBugSupport,
} from '../../src/schema/types';

export const validActionable: ActionableTicket = {
  classification: 'actionable_ticket',
  report_id: 'report-0',
  original_input:
    'I deleted a project and now the old link shows a 404 in chat',
  title: 'Deleted project URL opens ambiguous 404 state in chat layout',
  summary:
    'After deleting a project, the old project URL still opens a 404 page inside the chat layout.',
  severity: 'medium',
  category: 'project_lifecycle',
  extraction_confidence: 'high',
  expected_behavior:
    'Deleted project URLs should show a clear unavailable state with a recovery path.',
  observed_behavior:
    'Old project URL shows a 404 inside the chat UI with no recovery CTA.',
  steps_to_reproduce: [
    'Create a project',
    'Copy the project URL',
    'Delete the project',
    'Open the copied URL',
  ],
  engineering_notes:
    'Likely the deleted/inaccessible route renders inside the normal chat layout instead of a dedicated recovery state.',
  missing_information: ['Browser', 'Workspace role'],
};

export const validPartial: PartialTicket = {
  classification: 'partial_ticket_needs_clarification',
  report_id: 'report-1',
  original_input:
    'Contract review gave me the wrong answer after I uploaded a PDF',
  title: 'Contract review returns incorrect answer for uploaded PDF',
  summary:
    'User reports Contract review produced an incorrect answer for a PDF they uploaded.',
  severity: 'high',
  category: 'ai_response',
  extraction_confidence: 'medium',
  expected_behavior:
    'Contract review should return an accurate answer grounded in the uploaded PDF.',
  observed_behavior:
    'Contract review returned an answer the user considered wrong.',
  steps_to_reproduce: ['Open Contract review', 'Upload a PDF', 'Ask a question'],
  engineering_notes:
    'Need the specific question, the PDF, and the expected vs returned answer before triaging.',
  missing_information: [
    'PDF document',
    'Question asked',
    'Expected answer',
    'Returned answer',
  ],
  clarifying_questions: [
    'Can you share the PDF (or describe its type and length)?',
    'What question did you ask, and what answer did you expect?',
    'What did Contract review return instead?',
  ],
  what_unlocks_actionable: [
    'The uploaded PDF or a redacted equivalent',
    'The exact question and the expected vs observed answer',
  ],
};

export const validTooVague: TooVague = {
  classification: 'too_vague_request_more_info',
  report_id: 'report-2',
  original_input: 'upload is broken',
  interpretation:
    'User says an upload feature is not working but did not specify the surface, file type, or error.',
  clarifying_questions: [
    'Where in the product were you trying to upload (Projects, Contract review, chat attachment)?',
    'What were you uploading (file type, approximate size)?',
    'What happened — an error message, a hang, a silent failure?',
  ],
  suspected_category: 'upload',
};

export const validNonBug: NonBugSupport = {
  classification: 'non_bug_support_question',
  report_id: 'report-3',
  original_input: 'How do I export my project?',
  suggested_route: 'docs',
  suggested_response:
    'Project export lives under Project settings → Export. Let me know if that surface is missing or unclear.',
  reasoning:
    'User is asking how to use a feature, not reporting unexpected behavior.',
};
