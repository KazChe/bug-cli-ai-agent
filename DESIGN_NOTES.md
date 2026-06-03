# Design notes

Short write-up of the thinking behind the build, in my own voice. Companion to the code in this repo.

## How I interpreted the problem

Looking at the problem statement I tried to extract certain keywords to understand the ~~exact~~ extract ~~or~~ high level requirement(s) and recognized that that these reports are incomplete. They have no steps to reproduce, no description of their expectation. So that made me think of classifications. Of course, they required to be expanded upon. So far as supporting metadata in order to create sort of loosely in my head a data structure, a schema that we could run some type of evaluation, some type of validation that could tell us this report or this exact bug report is incomplete or is not a bug at all or happy path. It is an actionable report that we can generate a ticket to engineering and it has all those pieces that we're looking for.

## Key decisions

### Output Shapes

I think what the core of this was that each input to be classified into some buckets of shapes, which I ended up making four buckets

- whether the report gives us a complete actionable ticket.
- It's a partial ticket, but needs clarification.
- Provided information is just too vague, request for more information.
- And lastly, it's not a bug. It's just a support question like billing and such.

~~So then these would be modeled as a Zod discrimination union that have strict per-variant schemas. So after our unknown keys, it would fail validation.~~ wth...

So these would be modeled as a Zod discriminated union with strict per variant schemas...any unknown keys fail validation.

### Anthropic tool-use with a forced tool_choice

Instead of asking Claude to "please output JSON," decided to have code define a classification tool with a schema that forces Claude to call that tool, so the model's output is structured as tool arguments. Also along the same lines, I get the response and once I have it, it's double validated. Once against the LLM output schema itself to check for hallucinations and then against the final contract after the runner merges in the identity fields that it itself owns.

## What I'd do differently with more time

shorter feedback loop; move this close to the customer, such that their "bug" request(s) would be triaged in real-time. High level - in app agent in GC AI user interface. A ui agent <-> backend agent communication To facilitate that entire life cycle of evaluating the bug and providing immediate feedback of missing information or providing solutions to try to resolve the issue if it's not a bug or show KBs.

Use of multiple models for evals

## What I'm most and least confident about

What's I'm most confident about? I started by writing tests. I'm confident about tests passing. So what I guess I would be less confident about is whether the logic that they are testing is the right interpretation of the workflow or the pipeline required. Another thing would be, would this be cost effective? If it is pushed to a production type of environment, next thing would be the scalability, would it scale as the number of users, number of customers grow exponentially? And whether it would pass security on the compliance or malicious attacks?
