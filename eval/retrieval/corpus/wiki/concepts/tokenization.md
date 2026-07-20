---
type: concept
title: Tokenization
tags: [preprocessing, text]
sources: []
created: 2026-01-17
updated: 2026-01-19
---

# Tokenization

Tokenization converts raw text into a sequence of integer ids that a
model consumes. The vocabulary maps each subword unit to one id.

## Byte-pair encoding

Byte-pair encoding starts from single bytes and repeatedly merges the
most frequent adjacent pair, building a vocabulary of subword units that
balances vocabulary size against sequence length.

## Special tokens

Reserved ids mark boundaries: a beginning-of-sequence id, an
end-of-sequence id, and a padding id that fills short sequences in a
batch so their lengths align.

## Detokenization

Decoding reverses the map: integer ids become subword strings that are
concatenated back into readable text.
