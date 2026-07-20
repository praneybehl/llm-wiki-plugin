---
type: source
title: "Scaling Laws for Neural Language Models"
authors: [Jared Kaplan, Sam McCandlish]
url: https://arxiv.org/abs/2001.08361
raw: raw/scaling-laws-paper.md
ingested: 2026-01-24
created: 2026-01-24
updated: 2026-01-24
tags: [scaling, training]
---

# Scaling Laws for Neural Language Models

Kaplan and McCandlish show that test loss falls as a smooth power law in
model size, dataset size, and compute, spanning many orders of
magnitude. The result motivates [[distributed-training]] at ever larger
scale.

## Power-law form

Loss is roughly proportional to each resource raised to a small negative
exponent, so returns diminish but never flatten within the studied
range.

## Compute allocation

Given a fixed compute budget the paper argues most of it should go into a
larger model trained on fewer steps than intuition suggests.
