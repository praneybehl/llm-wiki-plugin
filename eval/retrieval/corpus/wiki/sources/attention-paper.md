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

Vaswani and colleagues introduce the [[transformer]], replacing
recurrence and convolutions entirely with self-attention. The paper
presents the [[attention-mechanism]] as scaled dot-product attention
plus a multi-head arrangement.

## Contribution

The central claim is that attention alone suffices for sequence
transduction, and that removing recurrence unlocks parallel training on
long inputs.

## Architecture

Key components are the encoder stack, the decoder stack, positional
encodings, and layer normalisation.
