---
type: source
title: "Adam: A Method for Stochastic Optimization"
---
# Adam: A Method for Stochastic Optimization

Kingma and Ba propose Adam, an optimizer that keeps exponential moving
averages of the first and second moments of the gradient. The method
adapts the step size for each parameter.

## Default hyperparameters

The paper recommends beta1 of 0.9, beta2 of 0.999, and an epsilon of
1e-8.
