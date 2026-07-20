---
type: concept
title: Distributed Training
tags: [training, scaling, infrastructure]
sources: [scaling-laws-paper]
created: 2026-02-06
updated: 2026-02-18
---

# Distributed Training

Training a large model spreads the work across many accelerators. The
right combination of parallelism strategies depends on model size,
interconnect bandwidth, and memory per device.

## Data parallelism

Data parallelism replicates the whole model on every worker and feeds
each replica a different slice of the batch. Workers average their
gradients through an all-reduce before the optimizer step, so all
replicas stay identical.

## Tensor parallelism ##

Tensor parallelism splits an individual weight matrix across devices,
each holding a shard of the rows or columns. Every layer then needs an
all-gather so partial results recombine, so this strategy wants fast
intra-node links.

## Pipeline parallelism

Pipeline parallelism assigns consecutive layers to different devices and
streams micro-batches through the stages. A poorly sized schedule leaves
a pipeline bubble where early stages idle while waiting for the last
stage to finish.

## ZeRO and sharded optimizers

ZeRO stage 3 shards the optimizer state, gradients, and parameters
across the data-parallel group instead of replicating them, trading a
little extra communication for a large drop in per-device memory.

## Gradient accumulation

Gradient accumulation runs several forward and backward passes before an
optimizer step, summing their gradients. This simulates a large batch on
devices that cannot hold one in memory at once.

## Mixed precision training

Mixed precision keeps a master copy of the weights in float32 while
running the forward and backward passes in bfloat16, halving activation
memory and speeding up the matrix multiplies.

## Activation checkpointing

Activation checkpointing discards intermediate activations during the
forward pass and recomputes them in the backward pass, trading extra
compute for a smaller memory footprint.

## Communication collectives

The core collectives are all-reduce, all-gather, and reduce-scatter.
Overlapping these collectives with computation hides most of the network
latency behind useful work.

## Fault tolerance and checkpointing

Long runs write periodic checkpoints so a hardware failure only costs
the work since the last save. Elastic training rebuilds the process
group when a node drops out.

## Hyperparameter scaling

As the world size grows the global batch grows too, so the learning rate
usually scales with it, guided by the [[scaling-laws]] relationships
between compute, data, and model size.

## Where this fits

- [[gradient-descent]]
- [[scaling-laws]]
- [[pytorch]]
- [[cuda]]
