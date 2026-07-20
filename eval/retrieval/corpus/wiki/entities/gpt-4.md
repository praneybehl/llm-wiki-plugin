---
type: entity
kind: model
title: GPT-4
aliases: [GPT4]
tags: [model, transformer]
sources: [scaling-laws-paper]
created: 2026-01-20
updated: 2026-02-06
---

# GPT-4

GPT-4 is a large decoder-only [[transformer]] language model released by
[[openai]]. It extends the recipe of earlier GPT models with more
parameters, more training tokens, and a longer context window.

## Architecture rumours

Public detail is sparse. Independent analysts believe GPT-4 uses a
[[mixture-of-experts]] design to raise capacity while holding inference
cost down, though this is not confirmed by the lab.

## Multimodal input

GPT-4 accepts images alongside text, encoding a picture into the same
token stream the language layers consume.

## Alignment

The model is tuned with reinforcement learning from human feedback to
follow instructions and refuse unsafe requests, work led in part by
[[ilya-sutskever]].
