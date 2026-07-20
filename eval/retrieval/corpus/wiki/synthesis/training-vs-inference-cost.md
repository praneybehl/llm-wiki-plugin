---
type: synthesis
title: "Where the cost lives: training versus inference"
question: Does training or inference dominate the lifetime cost of a deployed model?
tags: [cost, efficiency]
sources: [chinchilla-paper]
created: 2026-03-02
updated: 2026-03-08
---

# Where the cost lives: training versus inference

Training is a one-time capital expense; inference is a recurring bill
that scales with usage. For a widely deployed model the recurring side
usually wins over the lifetime.

## Training is amortised

A single expensive training run is paid once and spread across every
later request, so its per-request share shrinks as traffic climbs.

## Inference compounds with traffic

Every request pays for a forward pass and a growing [[kv-cache]], so a
popular product spends far more serving answers than it ever spent
learning them. This is why [[quantization]] and [[mixture-of-experts]]
matter for the bottom line.

## The Chinchilla angle

Because a compute-optimal model from the [[chinchilla-paper]] is smaller
for the same quality, it also lowers the recurring inference bill, not
just the training bill.
