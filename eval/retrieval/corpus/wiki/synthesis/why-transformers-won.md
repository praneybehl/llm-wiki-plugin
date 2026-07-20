---
type: synthesis
title: "Why transformers displaced recurrent networks"
question: Why did transformers replace recurrent networks for sequence modeling?
tags: [transformer, comparison]
sources: [attention-paper, scaling-laws-paper]
created: 2026-03-01
updated: 2026-03-05
---

# Why transformers displaced recurrent networks

Three factors, in order of importance.

## Parallelism during training

A recurrent network must process step t only after step t minus one, so
it cannot use a device fully. The [[attention-mechanism]] computes all
positions at once, which is the gap between training a model in days
versus months.

## Constant path length

Self-attention connects any two positions in a single hop, whereas a
recurrent network passes signal through many steps and its gradients
fade. Short paths preserve long-range dependencies.

## Scale follows parallelism

Once training parallelises, adding capability is mostly a matter of
compute, and the [[scaling-laws-paper]] results take over from there.
