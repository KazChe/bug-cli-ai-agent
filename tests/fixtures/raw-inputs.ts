export type ExpectedClass =
  | 'actionable_ticket'
  | 'partial_ticket_needs_clarification'
  | 'too_vague_request_more_info'
  | 'non_bug_support_question';

export interface CorpusEntry {
  id: string;
  input: string;
  expectedClass: ExpectedClass;
  note: string;
}

export const corpus: readonly CorpusEntry[] = [
  // ----- actionable_ticket (5) -----
  {
    id: 'a-01',
    input:
      "Deleted a project this morning. Now if I paste the old URL into Chrome it still loads our app shell, the left sidebar says 'No chats yet', and the main panel shows '404 We can't access this project. It may have been deleted or you don't have permission.' There's no button to go back to Projects. Repro: create project, copy URL, delete project from Projects list, paste URL. Account is on Free trial.",
    expectedClass: 'actionable_ticket',
    note: 'Clean repro, surface + symptom + environment all present',
  },
  {
    id: 'a-02',
    input:
      'Trying to upload a 12MB PDF to Contract Review. The upload progress bar fills to 100%, then the page just sits there — no error toast, no document in the list. Tried it 4 times in Safari 18 and Chrome 130. Works fine for a 200KB PDF. Expected: file uploads or I get an error. Actual: silent failure at 100%.',
    expectedClass: 'actionable_ticket',
    note: 'Clear expected vs actual, has retry data and file size threshold signal',
  },
  {
    id: 'a-03',
    input:
      'When I rename a project to anything containing an emoji (tried 🚀 and ✅), the project name in the sidebar shows as `??` after a refresh. The title bar still shows the emoji. URL slug looks fine too — it is just the sidebar list that mojibakes. Started after the May 14 release I think.',
    expectedClass: 'actionable_ticket',
    note: 'Specific encoding bug with reproducible character set',
  },
  {
    id: 'a-04',
    input:
      'Billing page shows I was charged $40 on May 1 but my plan is the $20 Starter tier. Invoice PDF also says $40. Payment method on file is the right card. I have screenshots if useful. Need this fixed before our finance review on the 28th.',
    expectedClass: 'actionable_ticket',
    note: 'Billing severity should be critical; user provides concrete amounts',
  },
  {
    id: 'a-05',
    input:
      "SAML SSO via Okta — when I click the Okta tile I get redirected to your /auth/callback endpoint and the page says 'Sign-in failed. Please try again.' Tried in two browsers, two users in our org. Direct email/password login still works. Started yesterday around 4pm PT. Other Okta-integrated apps work fine for the same users.",
    expectedClass: 'actionable_ticket',
    note: 'Auth outage, scoped to SAML, clear repro and counter-evidence',
  },

  // ----- partial_ticket_needs_clarification (5) -----
  {
    id: 'p-01',
    input:
      "Contract review gave me a totally wrong answer about the indemnity clause. I uploaded the PDF and asked about the cap on liability and it said unlimited but it's clearly capped at $1M in the doc. Can you fix it?",
    expectedClass: 'partial_ticket_needs_clarification',
    note: 'Bug is real but model needs the doc + exact prompt to triage',
  },
  {
    id: 'p-02',
    input:
      'exports are wrong. when I export to docx the formatting is all messed up — bullets become numbers, some headings disappear. happens for me and one other person on my team but not our admin. need this for client delivery friday',
    expectedClass: 'partial_ticket_needs_clarification',
    note: 'Specific surface + symptom; need example doc + role differences',
  },
  {
    id: 'p-03',
    input:
      'the AI keeps cutting off mid-sentence when I ask for long summaries. like literally stops mid-word. usually happens after a few minutes of working in a long doc. not every time though, maybe 1 in 5 requests?',
    expectedClass: 'partial_ticket_needs_clarification',
    note: 'Intermittent — need doc length, model used, timing reproducibility',
  },
  {
    id: 'p-04',
    input:
      "share link broken?? sent a colleague a link to my project, they got an error. they're on our team, same workspace. tried it twice.",
    expectedClass: 'partial_ticket_needs_clarification',
    note: 'Surface known (sharing) symptom known (error) — need the error text + roles',
  },
  {
    id: 'p-05',
    input:
      "Notifications aren't sending. I should be getting emails when comments are added to a project I'm assigned to but I haven't gotten any since last week. Checked spam.",
    expectedClass: 'partial_ticket_needs_clarification',
    note: 'Clear feature + clear symptom; need: account email, did sender confirm action, last working timestamp',
  },

  // ----- too_vague_request_more_info (5) -----
  {
    id: 'v-01',
    input: 'UPLOAD BROKEN AGAIN. FIX IT.',
    expectedClass: 'too_vague_request_more_info',
    note: 'All-caps rant, no surface specificity beyond "upload", no repro',
  },
  {
    id: 'v-02',
    input: "it doesn't work",
    expectedClass: 'too_vague_request_more_info',
    note: 'Minimum-effort report — zero signal',
  },
  {
    id: 'v-03',
    input:
      'Hi — first off love the product. Quick thing though, something seems off lately, not sure what. Could you take a look?',
    expectedClass: 'too_vague_request_more_info',
    note: 'Polite and friendly but contains no usable information',
  },
  {
    id: 'v-04',
    input:
      "Stack trace below:\nTypeError: Cannot read properties of undefined (reading 'id')\n    at ProjectsList (projects-list.tsx:142)\n    at renderWithHooks (react-dom.development.js:14985)\n    at mountIndeterminateComponent (react-dom.development.js:17811)\n    at beginWork (react-dom.development.js:19049)",
    expectedClass: 'too_vague_request_more_info',
    note: 'Pasted error trace, no user context — what were they doing?',
  },
  {
    id: 'v-05',
    input: 'the new update is so much worse',
    expectedClass: 'too_vague_request_more_info',
    note: 'Sentiment, not a bug report; needs at least a surface',
  },

  // ----- non_bug_support_question (5) -----
  {
    id: 'n-01',
    input: 'How do I export my project to Word? I see PDF in the menu but I need .docx.',
    expectedClass: 'non_bug_support_question',
    note: 'How-to question — route to docs',
  },
  {
    id: 'n-02',
    input:
      'Is there a way to bulk-tag projects? We have ~80 projects from a recent migration and tagging them one by one will take forever.',
    expectedClass: 'non_bug_support_question',
    note: 'Feature request disguised as a question — route to feature_request',
  },
  {
    id: 'n-03',
    input:
      "I was charged twice this month according to my email receipts but the billing page only shows one charge — is the second one a real charge or a hold? Don't want to dispute prematurely.",
    expectedClass: 'non_bug_support_question',
    note: 'Looks bug-shaped but is actually a billing-state question; route to billing',
  },
  {
    id: 'n-04',
    input: 'Your status page is red, is the app down for everyone or just me?',
    expectedClass: 'non_bug_support_question',
    note: 'Status check — route to status',
  },
  {
    id: 'n-05',
    input:
      'EVERYTHING IS BROKEN AND I HATE THIS APP. you charge $20/mo for what?? answer me',
    expectedClass: 'non_bug_support_question',
    note: 'Hostile rant with no actionable bug — route to other or billing depending on interpretation',
  },
] as const;
