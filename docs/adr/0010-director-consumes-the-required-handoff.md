# 0010 — The director consumes a required handoff

## Status

Accepted — 2026-11-02.

## Context

A producer card (product, architecture, or a change that owes a follow-up) names the work it
hands on in a `## Handoff` block. The role skills made the director responsible for creating
the downstream cards, but the director had no decision input that told it a handoff existed:
its only inputs were a worker question, an unowned card and an E1–E5 escalation. In practice
the next card was created by hand, and the handoff could be dropped silently.

The producer cannot create the card: a role that both designs and routes the next scope has
taken the director's decision. The supervisor cannot create it: choosing the card's scope,
title, acceptance seed and role is a content decision, and parsing a prose block is not a
deterministic plan.

## Decision

When a card with `meta.stage_handoff=required` is accepted, the supervisor gives the director
one **triage** decision for that card:

- the director reads the current delivery's `## Handoff`;
- it creates one accountable card per deliverable, seeds each acceptance from the handoff's
  `Acceptance source`, copies the handoff paths into the description, and links an epic's
  children (a task producer's follow-up records its origin);
- it records `handoff_consumed_round` on the producer, or `handoff_declined_round` when no
  downstream card is needed;
- the supervisor treats only that marker as the decision's completion; a linked child is
  advisory for the doctor, not proof.

A proposed child that expands scope is E1 and goes to the human; the director does not create
it. The producer is never reopened or moved by the triage; a failed triage leaves the accepted
card as it is and surfaces the unconsumed handoff to the human.

## Why

One content-decision lane owns the choice of the next scope, the producer stays a producer,
and the handoff becomes a machine-checkable obligation instead of prose that can be lost. The
marker also makes a crash after creating some children recoverable: the retry finds the
children by their `handoff_of` key and records the same round instead of duplicating them.

## Consequences

- One director turn per accepted handoff; it is bounded by the same attempt cap as the other
  director decisions and is not a worker slot.
- The supervisor must read accepted cards with the marker and must not move them; a triage
  that cannot complete is a `loop doctor` finding, not a card move.
- The round is part of the marker: a reopened/re-delivered producer is triaged again, while a
  historical marker from an earlier round does not suppress the new one.
- A deployment without a resident director leaves the handoff unconsumed and visible; it does
  not silently create cards from a different actor.
