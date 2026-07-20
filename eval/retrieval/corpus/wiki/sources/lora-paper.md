---
type: source
title: "LoRA: Low-Rank Adaptation of Large Language Models"
authors: [Edward Hu, Yelong Shen]
url: https://arxiv.org/abs/2106.09685
raw: raw/lora-paper.md
ingested: 2026-02-01
created: 2026-02-01
updated: 2026-02-01
tags: [efficiency, fine-tuning]
---

# LoRA: Low-Rank Adaptation of Large Language Models

Hu and Shen freeze the pretrained weights and inject a trainable
low-rank adaptation into each layer, so fine-tuning updates a tiny
fraction of the parameters.

## Rank decomposition

The update is written as the product of two thin matrices whose inner
dimension is the rank. A rank of eight already recovers most of the
quality of a full fine-tune.

## Deployment

Because the base weights stay frozen, many task adapters can be swapped
in and out at serving time without duplicating the backbone, and they
pair naturally with [[quantization]].
