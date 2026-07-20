---
type: source
title: "Training Compute-Optimal Large Language Models"
authors: [Jordan Hoffmann, Sebastian Borgeaud]
url: https://arxiv.org/abs/2203.15556
raw: raw/chinchilla-paper.md
ingested: 2026-02-11
created: 2026-02-11
updated: 2026-02-11
tags: [scaling, compute]
---

# Training Compute-Optimal Large Language Models

Hoffmann and Borgeaud revisit compute-optimal training and find that
earlier models were badly undertrained: for a given compute budget,
model size and training data should grow in equal proportion.

## Twenty tokens per parameter

Their fits suggest roughly 20 tokens per parameter as the compute-optimal
ratio, far more data per weight than prior practice used.

## Chinchilla versus Gopher

A smaller model trained on more data beat a much larger model trained on
less, at the same compute, overturning the previous [[scaling-laws-paper]]
allocation advice.
