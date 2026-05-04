---
type: concept
title: Attention Mechanism
sources: [attention-paper]
tags: [attention, mechanism, transformer]
created: 2026-01-15
updated: 2026-01-20
---

# Attention Mechanism

Attention computes a weighted sum of values, where the weights are
derived from the similarity between a query and a set of keys. In the
[[transformer]] this is implemented as scaled dot-product attention:

  Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V

Multi-head attention runs several attention heads in parallel and
concatenates the outputs.

Self-attention is the case where Q, K, V come from the same sequence.
Cross-attention is the case where the queries come from one sequence
and the keys/values from another.

See [[attention-paper]] for the original derivation.
