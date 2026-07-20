---
type: concept
title: KV Cache
tags: [inference, efficiency, attention]
sources: []
created: 2026-02-05
updated: 2026-02-14
---

# KV Cache

During autoregressive decoding a model appends one token at a time. The
KV cache stores the keys and values computed for previous tokens so
attention never recomputes them, turning quadratic decoding into a
linear scan over new positions.

## past_key_values

Frameworks expose the cache as a `past_key_values` tuple threaded
through each decoding step. On the first step it is empty; on later steps
the freshly computed keys and values are concatenated onto it.

## Memory growth

The cache grows linearly with the number of generated tokens and with
batch size, so a long generation eventually dominates GPU memory. This
is the motivation for [[quantization]] of the cache.

## Paged attention

Paged attention allocates the cache in fixed blocks like virtual memory
pages, cutting fragmentation when many requests of different lengths
share one accelerator.
