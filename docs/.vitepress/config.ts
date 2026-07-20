import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const repo = 'https://github.com/praneybehl/llm-wiki-plugin'
const site = 'https://praneybehl.github.io/llm-wiki-plugin/'
const socialImage = `${site}social-card.png`
const author = {
  '@type': 'Person',
  '@id': `${site}#author`,
  name: 'Praney Behl',
  url: 'https://github.com/praneybehl',
}
const faqItems = [
  {
    question: 'What is an LLM Wiki?',
    answer:
      'An LLM Wiki is a persistent, agent-maintained knowledge base compiled from project sources into structured Markdown pages. Instead of re-reading raw documents for every question, the agent ingests each source once, maintains links and summaries over time, and answers later questions from the accumulated wiki.',
  },
  {
    question: 'How is an LLM Wiki different from RAG?',
    answer:
      'RAG retrieves chunks from raw documents at query time, so each question reconstructs context from fragments. An LLM Wiki compiles sources into canonical pages during ingestion. Retrieval then searches the already-synthesized knowledge, letting corrections, cross-links, provenance, and contradictions compound across sessions.',
  },
  {
    question: 'Does LLM Wiki require embeddings or a vector database?',
    answer:
      'No. The default retrieval path is dependency-free section-level BM25 with an incremental local cache. Embeddings are optional and can be fused with lexical results through reciprocal rank fusion. The typed graph is also optional, while canonical Markdown remains the source of truth.',
  },
  {
    question: 'Which coding agents support LLM Wiki?',
    answer:
      'The agentskills.io-compatible skill is verified with Claude Code, Codex, Cursor, Gemini CLI, OpenCode, OpenClaw, Pi, and OMP. Claude Code also receives /wiki:* slash commands through the plugin; other agents invoke the same workflows through natural language. See the agent support matrix.',
  },
  {
    question: 'How do I install and start using LLM Wiki?',
    answer:
      'Install the plugin or skill for your agent, run /wiki:init, ingest a source with /wiki:ingest, then ask a cited question with /wiki:query. Run /wiki:lint periodically to catch structural and semantic issues. The getting-started guide lists exact commands for every supported agent.',
  },
]


function canonicalUrl(relativePath: string): string {
  const route = relativePath === 'index.md' ? '' : relativePath.replace(/\.md$/, '.html')
  return new URL(route, site).toString()
}

function structuredData(
  relativePath: string,
  title: string,
  description: string,
  url: string,
  lastUpdated: number,
): Record<string, unknown> {
  const website = {
    '@type': 'WebSite',
    '@id': `${site}#website`,
    name: 'LLM Wiki',
    url: site,
    description: 'Open-source tooling for an agent-maintained, continuously compiled knowledge base.',
    inLanguage: 'en-US',
    author: { '@id': author['@id'] },
  }
  const page =
    relativePath === 'index.md'
      ? {
          '@type': ['SoftwareApplication', 'SoftwareSourceCode'],
          '@id': `${site}#software`,
          name: 'LLM Wiki',
          applicationCategory: 'DeveloperApplication',
          operatingSystem: 'Cross-platform',
          softwareVersion: '2.0.0',
          description,
          url,
          codeRepository: repo,
          image: socialImage,
          license: `${repo}/blob/main/LICENSE`,
          programmingLanguage: ['Python', 'TypeScript'],
          author: { '@id': author['@id'] },
        }
      : {
          '@type': 'TechArticle',
          '@id': `${url}#article`,
          headline: title,
          description,
          url,
          mainEntityOfPage: url,
          image: socialImage,
          datePublished: '2026-07-20',
          dateModified: new Date(lastUpdated).toISOString(),
          isPartOf: { '@id': website['@id'] },
          author: { '@id': author['@id'] },
          inLanguage: 'en-US',
        }

  const graph: Record<string, unknown>[] = [website, author, page]
  if (relativePath === 'index.md') {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${site}#faq`,
      mainEntity: faqItems.map(({ question, answer }) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: answer,
        },
      })),
    })
  }

  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  }
}


export default withMermaid(
  defineConfig({
    // Project page served from https://praneybehl.github.io/llm-wiki-plugin/.
    // The trailing slash is required so generated asset URLs resolve under the sub-path.
    base: '/llm-wiki-plugin/',
    lang: 'en-US',
    title: 'LLM Wiki',
    description:
      'An LLM-curated, continuously compiled knowledge base for your projects — the LLM Wiki plugin.',
    // Keep default (non-clean) URLs so the build still emits *.html files and
    // legacy inbound links such as /llm-wiki-plugin/getting-started.html keep resolving.
    cleanUrls: false,
    lastUpdated: true,
    ignoreDeadLinks: false,
    sitemap: {
      hostname: site,
    },
    transformPageData(pageData) {
      const url = canonicalUrl(pageData.relativePath)
      const title =
        pageData.relativePath === 'index.md'
          ? 'LLM Wiki — LLM-curated knowledge base'
          : `${pageData.title} | LLM Wiki`
      const description =
        pageData.description ||
        'Build and maintain an agent-curated, continuously compiled knowledge base for your projects.'
      const data = structuredData(pageData.relativePath, title, description, url, pageData.lastUpdated)

      pageData.frontmatter.head ??= []
      pageData.frontmatter.head.push(
        ['link', { rel: 'canonical', href: url }],
        ['meta', { name: 'robots', content: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1' }],
        ['meta', { property: 'og:type', content: pageData.relativePath === 'index.md' ? 'website' : 'article' }],
        ['meta', { property: 'og:site_name', content: 'LLM Wiki' }],
        ['meta', { property: 'og:title', content: title }],
        ['meta', { property: 'og:description', content: description }],
        ['meta', { property: 'og:url', content: url }],
        ['meta', { property: 'og:image', content: socialImage }],
        ['meta', { property: 'og:image:width', content: '1200' }],
        ['meta', { property: 'og:image:height', content: '630' }],
        ['meta', { property: 'og:image:alt', content: 'LLM Wiki documentation' }],
        ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
        ['meta', { name: 'twitter:title', content: title }],
        ['meta', { name: 'twitter:description', content: description }],
        ['meta', { name: 'twitter:image', content: socialImage }],
        ['script', { type: 'application/ld+json' }, JSON.stringify(data)],
      )
    },
    head: [
      // `head` entries are emitted verbatim (base is not auto-prepended), so the
      // favicon path must include the base explicitly.
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/llm-wiki-plugin/favicon.svg' }],
      ['meta', { name: 'theme-color', content: '#4f46e5' }],
      ['meta', { name: 'color-scheme', content: 'light dark' }],
      ['link', { rel: 'alternate', type: 'text/plain', href: `${site}llms.txt`, title: 'LLM-readable documentation index' }],
    ],

    // The Mermaid plugin registers its component through a dynamic import, so
    // Vite's dev scanner misses the dependency tree unless Mermaid is explicit.
    vite: {
      optimizeDeps: {
        include: ['mermaid'],
      },
    },

    // Strict Mermaid: the plugin defaults to `securityLevel: 'loose'`; override it,
    // and render diagrams after client mount (no SSR auto-start).
    mermaid: {
      securityLevel: 'strict',
      startOnLoad: false,
      flowchart: {
        useMaxWidth: false,
      },
    },

    themeConfig: {
      logo: '/favicon.svg',
      siteTitle: 'LLM Wiki',

      nav: [
        { text: 'Overview', link: '/', activeMatch: '^/$' },
        {
          text: 'Guide',
          link: '/getting-started',
          activeMatch: '^/(getting-started|workflows)',
        },
        { text: 'Commands', link: '/commands', activeMatch: '^/commands' },
        {
          text: 'Search',
          link: '/search',
          activeMatch: '^/(search|graph)',
        },
        {
          text: 'Ecosystem',
          link: '/integrations',
          activeMatch: '^/(integrations|agents)',
        },
        {
          text: 'v2.0.0',
          items: [
            { text: 'Upgrade to v2', link: '/upgrade' },
            { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
            { text: 'Releases', link: `${repo}/releases` },
          ],
        },
      ],

      sidebar: [
        {
          text: 'Introduction',
          items: [
            { text: 'Home', link: '/' },
            { text: 'Getting started', link: '/getting-started' },
          ],
        },
        {
          text: 'Guides',
          items: [
            { text: 'Commands', link: '/commands' },
            { text: 'Workflows', link: '/workflows' },
            { text: 'Search & retrieval', link: '/search' },
            { text: 'Graph layer', link: '/graph' },
          ],
        },
        {
          text: 'Ecosystem',
          items: [
            { text: 'Integrations', link: '/integrations' },
            { text: 'Agents', link: '/agents' },
          ],
        },
        {
          text: 'Release',
          items: [{ text: 'Upgrade to v2', link: '/upgrade' }],
        },
      ],

      // Native fuzzy full-text search also acts as the local suggestion engine.
      search: {
        provider: 'local',
        options: {
          miniSearch: {
            searchOptions: {
              fuzzy: 0.2,
              prefix: true,
              boost: { title: 4, text: 2, titles: 1 },
            },
          },
        },
      },

      outline: {
        level: [2, 3],
        label: 'On this page',
      },

      socialLinks: [{ icon: 'github', link: repo }],

      editLink: {
        pattern: `${repo}/edit/main/docs/:path`,
        text: 'Edit this page on GitHub',
      },

      lastUpdated: {
        text: 'Last updated',
        formatOptions: { dateStyle: 'medium' },
      },

      docFooter: {
        prev: 'Previous',
        next: 'Next',
      },

      footer: {
        message: 'Released under the MIT License.',
        copyright: `Copyright © 2026 Praney Behl · <a href="${repo}">GitHub</a>`,
      },
    },
  }),
)
