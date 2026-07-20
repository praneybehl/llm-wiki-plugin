---
type: concept
title: Quantization
tags: [efficiency, inference, precision]
sources: [lora-paper]
created: 2026-02-01
updated: 2026-02-10
---

# Quantization

Quantization stores weights and activations at lower numeric precision
to shrink memory footprint and speed up matrix multiplies. A model
trained in bfloat16 can often serve in int8 with little quality loss.

## Post-training quantization

Post-training quantization converts an already-trained checkpoint by
calibrating scale factors on a small sample, mapping float ranges onto
the int8 grid without any further optimisation.

## Quantization-aware training

Quantization-aware training simulates the rounding during the forward
pass so the network learns weights that survive int8 rounding better
than a naive conversion.

## Common pitfalls

Mixing dtypes triggers `RuntimeError: expected scalar type Half`. Keep
the activations and weights on the same dtype, and watch for outlier
channels that widen the calibration range.
