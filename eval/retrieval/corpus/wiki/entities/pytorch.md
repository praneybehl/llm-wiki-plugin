---
type: entity
kind: software
title: PyTorch
aliases: [torch]
tags: [framework, infrastructure]
sources: []
created: 2026-01-18
updated: 2026-02-02
---

# PyTorch

PyTorch is a Python deep learning framework built around eager tensor
operations and automatic differentiation. It compiles hot code paths
with a tracing compiler while keeping the define-by-run programming
model.

## Autograd

The autograd engine records every tensor operation on a tape and walks
it backward to produce gradients, so no manual derivative bookkeeping is
needed.

## Distributed API

`DistributedDataParallel` wraps a module and synchronises gradients
across processes with all-reduce. It is the standard entry point for
[[distributed-training]].

## Fused kernels

`torch.nn.functional.scaled_dot_product_attention` dispatches to a fused
kernel that computes the [[attention-mechanism]] without materialising
the full score matrix, saving memory on long sequences.
