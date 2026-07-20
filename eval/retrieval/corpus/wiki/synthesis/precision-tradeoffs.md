---
type: synthesis
title: "Numeric precision tradeoffs across the stack"
question: How low can numeric precision go before quality suffers?
tags: [precision, efficiency]
sources: [lora-paper]
created: 2026-03-03
updated: 2026-03-09
---

# Numeric precision tradeoffs across the stack

Lower precision saves memory and bandwidth but risks rounding damage.
The safe floor differs between training and serving.

## Training wants headroom

Training keeps a float32 master copy of the weights because the many
tiny gradient updates would vanish under aggressive rounding, even while
the forward pass runs in bfloat16.

## Serving tolerates less

At serving time the weights are fixed, so [[quantization]] to int8 or
lower is far safer than it would be mid-training, and it pairs well with
[[lora-paper]] adapters kept at higher precision.

## The outlier problem

A handful of large-magnitude channels dominate the error budget; holding
just those channels at higher precision recovers most of the lost
quality.
