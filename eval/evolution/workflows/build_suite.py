#!/usr/bin/env python3
"""Freeze public repository workflow sources and a reproducible task protocol."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
PUBLIC_COMMIT = '06369b2eb0617bf7b07b2b8a5c07f4aca1fb1bf0'
wiki = HERE / 'wiki'
for name in ('sources', 'concepts', 'raw'):
    (wiki / name).mkdir(parents=True, exist_ok=True)
snapshots = {
    'retrieval': ('skills/llm-wiki/references/query-workflow.md', 'Local FastEmbed and BM25 are fused with reciprocal rank fusion. Canonical Markdown remains authoritative; the semantic cache is regenerable. Search JSON reports mode and retrieval provenance.'),
    'releases': ('CONTRIBUTING.md', 'Additive optional features use a minor version increment. The main release updates package.json, plugin.json, both marketplace version fields and CHANGELOG.md together. Publishing follows merge.'),
    'ingestion': ('skills/llm-wiki/references/ingest-workflow.md', 'Ingestion reads existing schema and index, preserves captured raw files, creates a source summary, updates relevant knowledge pages, and updates the index and log. Contradictions must remain explicit.'),
    'schema': ('skills/llm-wiki/assets/SCHEMA.md.template', 'Page types include source, entity, concept and synthesis. All pages need type, title, tags, created and updated. Source pages record their raw source; non-source pages cite source summaries. The hard page cap is 800 lines.'),
    'links': ('CHANGELOG.md', 'Path-qualified wikilinks resolve only to that exact path. An unresolved raw/foo must not fall back to sources/foo. Bare stem links can resolve without a directory prefix.'),
    'runtime': ('skills/llm-wiki/scripts/setup_wiki.py', 'Runtime setup checks FastEmbed, sqlite-vec and PyYAML, indexes current Markdown sections and checks vector consistency. A ready result reports model, pages, sections and vectors.'),
}
manifest = {}
for name,(source,summary) in snapshots.items():
    data = subprocess.check_output(['git', 'show', PUBLIC_COMMIT+':'+source], cwd=ROOT)
    (wiki/'raw'/f'{name}.txt').write_bytes(data)
    manifest[name] = {'repository_path':source,'commit':PUBLIC_COMMIT,'sha256':hashlib.sha256(data).hexdigest()}
    (wiki/'sources'/f'{name}.md').write_text(f'---\ntype: source\ntitle: "Repository {name}"\ntags: [project]\ncreated: 2026-09-13\nupdated: 2026-09-13\nauthors: [LLM Wiki maintainers]\nraw: raw/{name}.txt\ningested: 2026-09-13\n---\n\n# Repository {name}\n\n{summary}\n\nCaptured from {source}; inspect raw/{name}.txt for the full contract.\n')
(wiki/'SCHEMA.md').write_text('''# Workflow evaluation wiki

Raw sources are inside raw/ for this isolated workspace and are immutable.
Curated source pages live in sources/, concepts in concepts/.
Every curated page needs type, title, tags, created and updated frontmatter.
Source pages need raw and ingested; concept pages need sources citing source slugs.
Use relative wikilinks. Keep index.md and log.md current after ingestion.
The graph is derived from Markdown. Rebuild with wiki_graph_extract.py.
Use the supplied skill scripts, uv --offline and the preinstalled local embedding model.
No external network is needed. Save hybrid search JSON in outputs/ when a task requests it.
''')
(wiki/'index.md').write_text('# Index\n\n'+'\n'.join(f'- [[sources/{n}]]: repository {n} contract' for n in snapshots)+'\n')
(wiki/'log.md').write_text('# Log\n\n- 2026-09-13: public repository source snapshots frozen.\n')
(wiki/'concepts/runtime-policy.md').write_text('''---
type: concept
title: "Runtime policy (deliberately stale evaluation seed)"
tags: [project]
created: 2026-09-13
updated: 2026-09-13
sources: [retrieval]
---

# Runtime policy

This evaluation seed deliberately contains an incorrect claim for an editing task:
the semantic cache is authoritative and Markdown can be discarded after indexing.
Consult [[sources/retrieval]] before relying on this page.
''')
with (wiki/'index.md').open('a') as stream:
    stream.write('- [[concepts/runtime-policy]]: deliberately stale editing seed\n')
tasks=[]
def query(id, split, question, rubric, sources, abstain=False):
    tasks.append(dict(id=id,split=split,question=question,rubric=rubric,sources=['sources/'+s+'.md' for s in sources],abstain=abstain))
def ingest(id, split, topic, phrase):
    source=f'sources/ingested-{id}.md'; concept=f'concepts/{id}.md'
    tasks.append(dict(id=id,split=split,
      question=f'Ingest raw/{topic}.txt into {source}. Create {concept} explaining the applicable workflow and citing the new source. Update index.md and log.md. Preserve all existing source pages and raw files. Run the supplied wiki_graph_extract.py with --formats jsonl, then run wiki_search.py with --cache --json using hybrid retrieval for "{phrase}" and save its actual stdout to outputs/{id}.json. Report the result and cite the new source. Use the existing schema and supplied skill scripts; dependencies and embeddings are available offline.',
      rubric=f'The new source faithfully summarizes raw/{topic}.txt, records its raw path and ingestion metadata, and the concept cites it. The index and log include the new pages. Graph extraction and hybrid search actually ran. Saved search output has mode hybrid. The final answer accurately describes the completed work, supported by the new source.',
      sources=['sources/'+topic+'.md','raw/'+topic+'.txt'],abstain=False,
      allow_write=[source,concept,'index.md','log.md','graph/*.jsonl',f'outputs/{id}.json'],
      required_commands=[['wiki_graph_extract.py','--formats','jsonl'],['wiki_search.py','--json','--cache']],
      artifacts=[{'path':source,'kind':'contains','equals':['type: source',f'raw/{topic}.txt','ingested:']},
                 {'path':concept,'kind':'contains','equals':['type: concept',f'ingested-{id}']},
                 {'path':'index.md','kind':'contains','equals':[f'ingested-{id}',id]},
                 {'path':'log.md','kind':'contains','equals':[id]},
                 {'path':'graph/nodes.jsonl','kind':'jsonl_subset','equals':[{'path':source},{'path':concept}]},
                 {'path':f'outputs/{id}.json','kind':'json_subset','equals':{'mode':'hybrid'}}]))
query('train-cache','train','Can a missing semantic cache be restored, and where does authoritative content live?','Explain regenerable cache, canonical Markdown and local retrieval. Cite retrieval source.',['retrieval'])
query('train-pages','train','Which metadata is shared by all curated page types?','List type,title,tags,created,updated with schema citation.',['schema'])
query('train-absent','train','What guaranteed percentage improvement does this project establish for every model?','Abstain: the supplied sources establish no universal numerical improvement.',[],True)
ingest('train-link-ingest','train','links','path-qualified wikilinks')
query('val-version','validation','Does an additive optional workflow require a major release, and which records must change?','Choose minor, identify three JSON files/four version fields plus changelog; cite releases.',['releases'])
query('val-counts','validation','What does a ready runtime setup verify about sections and vectors?','Explain vector consistency and relevant setup outputs without inventing counts.',['runtime'])
query('val-citation','validation','Should a link to raw/foo bind to a curated sources/foo page when raw/foo is absent?','No: directory prefix constrains exact resolution; do not silently substitute another path.',['links'])
ingest('val-ingest-process','validation','ingestion','immutable captured raw sources')
query('test-retrieval','test','Explain how lexical and semantic evidence become a ranked query result, and how a caller can inspect provenance.','Mention BM25, local FastEmbed, reciprocal rank fusion and JSON retrieval provenance. Cite source.',['retrieval'])
query('test-source-policy','test','A new source disagrees with an existing concept. Should ingestion erase the original capture or silently replace the old claim?','Preserve raw sources and explicitly retain conflict with evidence; do not silently erase history.',['ingestion'])
query('test-metadata','test','How do source and concept provenance fields differ, and when must a page be split?','Source raw and ingestion metadata; concepts cite source summaries; 800-line hard cap.',['schema'])
query('test-price-unknown','test','What is the precise dollar cost of every local hybrid-search query?','Abstain on exact dollars: no dollar tariff is given; local embeddings do not establish a precise total machine cost.',[],True)
ingest('test-release-ingest','test','releases','minor release version changelog')
ingest('test-runtime-ingest','test','runtime','vector consistency sections model')
tasks.append(dict(id='test-edit-policy',split='test',
    question='Correct concepts/runtime-policy.md using the current sources/retrieval.md contract. Preserve its metadata and source link, explicitly identify the former cache-authoritative assertion as incorrect, and state the current authority and regeneration policy. Update log.md and cite the corrected concept and its supporting source.',
    rubric='The saved concept explicitly corrects the stale claim: Markdown remains authoritative and the cache is regenerable. It preserves concept metadata and a source citation, retains an explicit correction/history note and updates the log. No raw or unrelated source is modified.',
    sources=['sources/retrieval.md'],abstain=False,allow_write=['concepts/runtime-policy.md','log.md'],
    artifacts=[{'path':'concepts/runtime-policy.md','kind':'contains','equals':['type: concept','sources/retrieval']},
               {'path':'log.md','kind':'contains','equals':['runtime-policy']}]))
tasks.append(dict(id='test-runtime-audit',split='test',
    question='Run the supplied setup_wiki.py against this wiki using the prepared offline runtime. Save its actual JSON stdout to outputs/runtime-audit.json. Explain what was verified, including whether the reported vector count matches the indexed section count, and cite the runtime source.',
    rubric='The actual setup command completed with status ready and the pinned dependency versions. The answer accurately describes local model and section/vector consistency without inventing a count.',
    sources=['sources/runtime.md'],abstain=False,allow_write=['outputs/runtime-audit.json'],
    required_commands=[['setup_wiki.py','--wiki']],
    artifacts=[{'path':'outputs/runtime-audit.json','kind':'json_subset','equals':{'status':'ready','dependencies':{'fastembed':'0.8.0','pyyaml':'6.0.3','sqlite-vec':'0.1.9'}}}]))
calibration=[]
for answer,passed in [('No. Keep Markdown as the source of truth; a lost cache is only a rebuildable derivative.',True),('Markdown is canonical, so delete the Markdown after saving the authoritative cache.',False)]:
    calibration.append(dict(question='Can the cache replace the Markdown?',rubric='Markdown is authoritative; cache is regenerable and cannot replace it.',answer=answer,sources=['sources/retrieval.md'],citations=['sources/retrieval.md'],abstain=False,passed=passed))
(HERE/'suite.json').write_text(json.dumps({'version':2,'corpus':'wiki','tasks':tasks,'calibration':calibration},indent=2)+'\n')
(HERE/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Frozen {len(tasks)} tasks and {len(manifest)} repository sources')
