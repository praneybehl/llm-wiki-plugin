---
type: concept
title: RAG Pipeline
tags: [retrieval, generation, evaluation]
sources: [attention-paper]
created: 2026-07-20
updated: 2026-07-20
---

# RAG Pipeline

Retrieval-augmented generation grounds an answer in selected evidence.

## Ingestion

Documents are normalized, split into searchable units, and indexed.

## Retrieval

A query ranks candidate sections before any answer is generated.

### Lexical ranking

BM25 rewards exact term overlap while normalizing document length.

### Semantic ranking

Embeddings can recover relevant passages when wording differs.

## Generation

The model receives the highest-ranked evidence with source metadata.

## Evaluation

Recall and reciprocal rank measure whether expected evidence is retrieved.
