# Workflow evaluation wiki

Raw sources are inside raw/ for this isolated workspace and are immutable.
Curated source pages live in sources/, concepts in concepts/.
Every curated page needs type, title, tags, created and updated frontmatter.
Source pages need raw and ingested; concept pages need sources citing source slugs.
Use relative wikilinks. Keep index.md and log.md current after ingestion.
The graph is derived from Markdown. Rebuild with wiki_graph_extract.py.
Use the supplied skill scripts, uv --offline and the preinstalled local embedding model.
No external network is needed. Save hybrid search JSON in outputs/ when a task requests it.
