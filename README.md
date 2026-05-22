# Support Engineer Challenge

### Recordings

- [Part 1: Product Investigation](https://dhbtuus86mod.cloudfront.net/product_investigation.mp4)
- [Part 2: Support Experience](https://dhbtuus86mod.cloudfront.net/part-2-support-experience-audit.mp4)

---

## Audit

#### (a) Evaluate the current support experience end-to-end — the AI responses, the help articles, the docs site, the overall flow. What worked? What didn't? Where did the AI give you a useful answer vs. a generic one? Where did you hit a dead end? Be specific, include screenshots if helpful.

From what I currently understand from the product, the support experience I had via Intercom and overall flow was smooth. Responses were in general decent. It provided answers to the questions that I had and it pointed to relative documentation. There was an issue that I mentioned in the recording where it showed a link to documentation which took us to an LLM text.

![Untitled doc link](images/untitled_doc_link.png)

and navigating to what that `untitled` links to:
![Untitled doc link](images/llms-text.png)

#### (b) What's the single biggest gap in the current support experience that you'd want to fix first, and how would you fix it?

Support experience was generally effective in the areas I tested. The biggest improvement I would make is not adding more docs, but making the support path more discoverable from inside the exact workflow when the user face an issue and get stuck. for exmaple,

```
need help? open support with this project URL and error context attached
```

#### (c) If you could change one thing about how the AI agent responds to users, what would it be and why?

Didn't see any reason to change the agent's tone or the way it respondes overall, but I would look inot doing away with its immediate follow ups right after it provides a response, `Is that what you were looking for?` or `Did that answer your question?`. If the idea is to get feedback/training, then I would use a thumbs up/down approach.

### Part 3: Build Something
