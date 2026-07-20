---
type: source
title: "Adam: A Method for Stochastic Optimization"
authors: [Diederik Kingma, Jimmy Ba]
url: https://arxiv.org/abs/1412.6980
raw: raw/adam-paper.md
ingested: 2026-01-16
created: 2026-01-16
updated: 2026-01-16
tags: [optimization, training]
---

# Adam: A Method for Stochastic Optimization

Kingma and Ba propose Adam, an optimizer that keeps exponential moving
averages of the first and second moments of the gradient to adapt the
step size per parameter. It underpins the [[gradient-descent]] page.

## Bias correction

Because the moving averages start at zero they are biased toward zero
early in training; a correction term divides out that bias.

## Default hyperparameters

The paper recommends beta1 of 0.9, beta2 of 0.999, and an epsilon of
1e-8, defaults that remain common today.
