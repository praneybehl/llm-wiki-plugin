---
type: concept
title: Scaling Laws
sources: [scaling-laws-paper]
tags: [scaling, training, safety]
created: 2026-02-10
updated: 2026-02-15
---

# Scaling Laws

Empirical observation that the loss of large language models follows a
power law in model size, dataset size, and training compute. Kaplan et
al. (see [[scaling-laws-paper]]) first articulated this for autoregressive
language models.

The practical consequence is that frontier capability is predictable
from compute spent, which has driven the industry toward training larger
and larger models.

Related: [[gpt-3]] is the first widely-known model that validated this
empirically at scale. The compute-optimal frontier was later refined.
