# The triage decision

An accepted card that carries a required handoff owes follow-up work. Read the current
delivery's `## Handoff`, create one card per deliverable with its accountable role, seed each
card's acceptance from the `Acceptance source`, and copy the handoff paths into the
description. Link an epic's children with a parent relation; a task's follow-up card records
the producer as its origin. Record `handoff_consumed_round` on the producer — or
`handoff_declined_round` when no downstream card is needed.

A proposed child that expands scope is E1: create it only if the map gives E1 to the director;
otherwise read `escalation.md` and escalate.
