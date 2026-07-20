---
type: concept
title: Attention Mechanism
tags: [attention, transformer, inference]
sources: [attention-paper]
created: 2026-01-15
updated: 2026-01-20
---

# Attention Mechanism

Attention computes a weighted sum of values, where the weights come from
the similarity between a query and a set of keys. It lets a sequence
position gather information from every other position.

## Scaled dot-product attention

The core operation is scaled dot-product attention:
softmax(QK^T / sqrt(d_k)) V. Dividing by sqrt(d_k) keeps the logits from
growing too large as dimensionality rises.

## Multi-head attention

Multi-head attention runs several attention heads in parallel and
concatenates their outputs, so different heads specialise on different
relationships between tokens.

## Self-attention versus cross-attention

Self-attention draws its query, keys, and values from one sequence.
Cross-attention takes the query from one sequence and the keys and
values from another, which is how a decoder reads an encoder.

See [[attention-paper]] and the [[transformer]] page for the surrounding
architecture.
