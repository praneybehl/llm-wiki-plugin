---
type: concept
title: Gradient Descent
tags: [optimization, training]
sources: [adam-paper]
created: 2026-01-16
updated: 2026-01-22
---

# Gradient Descent

Gradient descent updates parameters by stepping in the direction that
lowers the loss, scaled by a learning rate. Stochastic gradient descent
estimates the gradient from a mini-batch instead of the whole dataset.

## Learning rate schedules

The learning rate controls step size. A warmup phase raises it slowly,
then a cosine schedule decays it toward zero over training.

## Adam and AdamW

Adam keeps running averages of the gradient and its square to adapt the
step per parameter. AdamW decouples weight decay from the gradient
update, which improves regularisation. See [[adam-paper]].

## Gradient clipping

Clipping the global gradient norm to a threshold prevents a single large
batch from destabilising the [[distributed-training]] run.
