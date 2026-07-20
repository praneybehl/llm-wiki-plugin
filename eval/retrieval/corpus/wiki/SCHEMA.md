# Evaluation Wiki Schema

## Retrieval

- Semantic backend: local FastEmbed + sqlite-vec (`BAAI/bge-small-en-v1.5`, 384 dimensions).

The fixture uses hybrid retrieval when local semantic dependencies are available and otherwise exercises lexical fallback.
