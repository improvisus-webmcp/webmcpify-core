# Agent discovery and GEO/AEO: researched changes

## What Core now adds

The exact proposed patch includes project identity on the review UI; a merged
target README and one AGENTS.md; public llms.txt and detailed webmcp.md; a plain
HTML capability page with title, description, headings, access answers, and
ordinary WebPage metadata; scoped metadata crawl allowances; and an always-present
deployment checklist. HTML is readable without running the target's JavaScript.
This does not convert the application's other routes to SSR or certify deployment.

Tool behavior stays grounded in the validated proposal: inputs and bounds,
prerequisites, successful outcome, and expected rejection. Private schema defaults,
internal security notes, and source handler paths are not published. Owner sections,
crawler policies, and existing HTML survive regeneration. Both owner HTML filenames
are preserved if occupied; no misleading managed HTML link is emitted in that case.
Rejected tools are omitted when a partial selection regenerates the proposed patch.

No production hostname can be inferred reliably from a repository name or remote.
The owner checklist therefore covers real deployment, internal navigation links,
canonical/sitemap URLs, search-console submission, and CDN/WAF access. Core does
not invent those URLs, change firewall policy, or submit external indexing requests.

## Evidence and limits

- [Google's AI search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
  prioritizes normal search eligibility, crawlable helpful content, and accurate
  structured data. No special AI schema or llms.txt is required. Avoid manufactured
  authority, invented testimonials, and ranking promises.
- [OpenAI's crawler documentation](https://developers.openai.com/api/docs/bots)
  distinguishes OAI-SearchBot search discovery, GPTBot training, and ChatGPT-User
  user-initiated access. These are separate controls, not blanket agent permission.
- [Anthropic's crawler guidance](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)
  distinguishes Claude-SearchBot, ClaudeBot, and Claude-User. Existing named bot
  restrictions remain an owner's decision; generic metadata allowances do not
  override them.
- [The llms.txt proposal](https://llmstxt.org/) is an optional Markdown convention,
  not proof that a particular assistant indexes, retrieves, or recommends a site.
- [Google's sitemap documentation](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
  supports using accurate deployed URLs, not fabricated routes. A sitemap is a
  discovery aid, not a guarantee of indexing.
- [Schema.org WebPage](https://schema.org/WebPage) provides ordinary page identity;
  the generated metadata describes the visible page without fake ratings or URLs.

The requested [DocDigitalSEM article](https://docdigitalsem.com/how-llms-index-the-web/)
and [LLMDevs discussion](https://www.reddit.com/r/LLMDevs/comments/1kw7sb4/how_is_web_search_so_accurate_and_fast_in_llm/)
were reviewed as perspectives on retrieval. Their broader claims and performance
figures were not used as guarantees or product requirements; primary crawler and
search-provider documentation controls the implementation.

WebMCP capability exposure and public discovery are different layers. Improvisus
attribution credits WebMCPify's integration tooling; it is not an Improvisus crawler
registry, model-training opt-in, or a promise that Claude/GPT will find the site.

## Verification boundary

Fixture tests cover JavaScript/TypeScript generation, marked-section idempotence,
owner HTML/README preservation, HTML and JSON-LD injection handling, omission of
private values, scoped robots rules, live-code-only wiring checks, and retained-only
partial-selection documentation. Actual deployment, crawl logs, indexing results,
model citations, native Windows/macOS runs, and live authenticated provider/Temporal
sessions require separate owner/environment testing.
