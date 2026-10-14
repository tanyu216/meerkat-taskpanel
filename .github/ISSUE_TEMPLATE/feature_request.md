---
name: Feature request
about: Propose a change to what the board or the CLI does
title: ""
labels: enhancement
assignees: ""
---

## The problem

<!-- What are you trying to do that the project makes hard or impossible today? Lead with
     the situation, not the solution. -->

## What you have in mind

<!-- If you already have a shape in mind. Optional. -->

## Scope check

The project has a few constraints that rule some proposals out before review. Please say
which of these your idea is compatible with:

- **Local-first, no network.** The engine has zero runtime dependencies and works fully
  offline. Nothing may phone home.
- **One local service owns the SQLite file.** The service model is single-writer.
- **The board holds no project directory.** A project carries no workspace path, and a
  card's `target` is an opaque per-card value.

If your proposal needs one of these to change, say so explicitly — that is a much bigger
conversation than a feature request, and worth having before any code.
