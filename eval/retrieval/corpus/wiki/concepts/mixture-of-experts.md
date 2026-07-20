---
type: concept
title: Mixture of Experts
tags: [efficiency, architecture, scaling]
sources: []
created: 2026-02-03
updated: 2026-02-12
---

# Mixture of Experts

A mixture-of-experts layer replaces one dense feed-forward block with
many expert blocks and a router that sends each token to only a few of
them, so the parameter count grows without a proportional rise in
compute per token.

## Top-2 routing

A gating network scores every expert for a token and dispatches the
token to its top-2 experts. Only those experts run, which keeps the
active compute far below the total parameter count.

## Load balancing loss

Without a load balancing loss the router collapses onto a handful of
experts. The auxiliary loss pushes the gate to spread tokens evenly
across all experts.

## Capacity factor

Each expert has a fixed slot budget per batch. A capacity factor above
one leaves headroom; tokens beyond the budget are dropped and skip the
layer via the residual path.
