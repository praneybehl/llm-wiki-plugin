---
type: source
title: "Attention Is All You Need"
authors: [Ashish Vaswani, Noam Shazeer]
url: https://arxiv.org/abs/1706.03762
raw: raw/attention-paper.md
ingested: 2026-01-15
created: 2026-01-15
updated: 2026-01-15
tags: [transformer, attention]
---

# Attention Is All You Need

Vaswani et al. introduce the [[transformer]] architecture, replacing
recurrence and convolutions with self-attention. The paper presents the
[[attention-mechanism]] — specifically scaled dot-product attention and
multi-head attention.

Transformers became the foundation for [[gpt-3]] and most modern large
language models. The architecture's main contribution is its parallelism
during training, which enables much larger models than RNNs allowed.

Key components: encoder, decoder, positional encoding, layer normalization.
