---
type: entity
kind: architecture
title: Transformer
aliases: [Transformer architecture]
sources: [attention-paper]
tags: [transformer, architecture]
created: 2026-01-15
updated: 2026-01-15
---

# Transformer

The transformer is a neural network architecture introduced by Vaswani
et al. in 2017 (see [[attention-paper]]). It uses self-attention as its
primary mechanism, completely replacing recurrence.

The architecture has two halves: an encoder and a decoder. Modern
language models like [[gpt-3]] are decoder-only stacks. The transformer
made it practical to train very large models because attention is
trivially parallel during training.

The [[attention-mechanism]] page covers the math; this page is about the
overall architecture, layer composition, and historical context.
