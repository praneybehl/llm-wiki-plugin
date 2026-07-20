---
type: entity
kind: platform
title: CUDA
aliases: [CUDA Toolkit]
tags: [gpu, infrastructure]
sources: []
created: 2026-01-19
updated: 2026-02-04
---

# CUDA

CUDA is NVIDIA's parallel programming platform for its graphics
processors. Kernels launch a grid of threads grouped into blocks, and
the compiler `nvcc` turns annotated source into device code.

## Compute capability

Each generation exposes a compute capability version that gates which
instructions are available; compute capability 8.0 first offered the
tensor cores used for bfloat16 matrix multiplies.

## Memory hierarchy

Threads read fastest from registers, then shared memory within a block,
then global device memory. Coalescing global reads across a warp is the
single biggest performance lever.

## Out-of-memory errors

Oversubscribing device memory raises `CUDA_ERROR_OUT_OF_MEMORY`. Reduce
the batch, enable activation checkpointing, or shard the model to
recover, as covered in [[distributed-training]].
