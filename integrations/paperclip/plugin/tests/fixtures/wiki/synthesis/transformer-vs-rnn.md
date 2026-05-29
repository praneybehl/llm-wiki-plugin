---
type: synthesis
title: "Why transformers replaced RNNs"
question: Why did transformers displace RNNs for sequence modeling?
sources: [attention-paper]
tags: [transformer, history]
created: 2026-03-01
updated: 2026-03-01
---

# Why transformers replaced RNNs

Three reasons, in order of importance:

1. **Parallelism during training.** RNNs are inherently sequential — you
   cannot compute step `t` until step `t-1` is done. The
   [[transformer]] computes all positions in parallel via the
   [[attention-mechanism]]. This is the difference between training a
   billion-parameter model in days vs. months.

2. **Long-range dependencies.** Self-attention has constant path length
   between any two tokens; RNNs have O(n) path length and gradients
   degrade.

3. **Scaling.** Once parallelism is solved, scale is just compute, and
   the [[scaling-laws]] do the rest.
