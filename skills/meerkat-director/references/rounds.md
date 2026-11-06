## Decision rounds

A decision round closes the choices a piece of work would otherwise assume silently. It
changes *how* a question is asked; the ladder still sets *who* decides, and only a
human-authored comment resumes an `awaiting` card.

1. **Draw the tree.** Each decision is a branch; a decision hangs off the answers it depends
   on.
2. **Find the frontier.** The frontier is every decision whose prerequisites are answered —
   what can be asked now without guessing an answer not yet heard. Ask the whole frontier in
   one round. A decision that depends on another open question belongs to a later round.
3. **Number and recommend.** Q1, Q2, … each with a recommended answer and the why. Word the
   question so "yes" accepts the recommendation; list alternatives for a different answer.
4. **Facts are the asker's job.** Look up the code, docs, board or a probe; when the lookup is
   itself work, start a fact-gathering task or worker. The tools establish the facts; the
   human answers the judgment. A running lookup is an open prerequisite: it blocks only the
   questions downstream of it; ask the rest of the frontier now.
5. **Reshape and repeat.** Answers close branches and unblock the next frontier. Recompute
   it and ask the next round. The round closes only when the frontier is empty.
6. **Act once the frontier closes.** Build, add dependencies, freeze a direction or write files
   after every frontier item is answered. Record the answers in the plan, spec or test plan
   (and on the card), and confirm the shared understanding with the decider.

**Card mode — collaborative.** For card execution (Jobs/Linus/Turing) lead with the
recommendation and the evidence. "yes" accepts the recommended set; record the answers and
proceed.

**Design mode — adversarial.** For setup and team design, challenge the assumptions: ask what
would falsify each one and request a concrete counterexample — a real card, flow or failure the
proposal gets wrong. For a team, require an ownership matrix: every card shape has exactly one
accountable role — a defined role, or an explicit assignment to a worker outside the roles —
and the reviewer is independent of the producer. Work that belongs outside the roles goes to a
worker outside them rather than being force-fit into a role; an unowned card shape is a finding
only when a defined role owns that shape.

### The request shape

A single item (or each Qn inside a round) uses this shape:

```text
Decision needed: <one sentence>
Options: A) ...; B) ... [; C) ...]
Recommendation: <the asker's recommendation and why>
Impact if deferred: <what stays blocked>
Verified already: <cards/code/evidence already checked>
```

An escalation from outside a card additionally says **why the matter is beyond its authority**
and names the E-code.
