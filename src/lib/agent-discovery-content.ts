import type { ProposedTool } from "./tool-proposals.js";

function escape(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Static, crawlable content; never claim that a draft is deployed or indexed. */
export function capabilityHtml(project: string, tools: ProposedTool[]): string {
  const name = escape(project);
  const description = `Browser-agent capability reference for ${project}. Inputs, prerequisites, outcomes, and access boundaries.`;
  const metadata = JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", name: `${project} — browser capabilities`, description }).replace(/</g, "\\u003c");
  const capabilities = tools.map((tool) => {
    const inputs = Object.entries(tool.parameters.properties).map(([field, raw]) => {
      const schema = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const type = typeof schema.type === "string" ? schema.type : "inspect the live schema";
      const constraints = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"].filter((key) => typeof schema[key] === "number").map((key) => `${key}: ${schema[key]}`).join(", ");
      return `<li><code>${escape(field)}</code>: ${escape(type)}; ${tool.parameters.required?.includes(field) ? "required" : "optional"}${constraints ? `; ${escape(constraints)}` : ""}.</li>`;
    }).join("");
    const requirements = tool.behavior.preconditions.map((item) => `<li>${escape(item)}</li>`).join("");
    const rejections = (tool.behavior.expectedFailures ?? []).map((item) => `<li>${escape(item.condition)}: ${escape(item.error)}</li>`).join("");
    return `<article><h2>${escape(tool.title ?? tool.name)}</h2><p>Tool: <code>${escape(tool.name)}</code></p><p>${escape(tool.description)}</p>
<p>Authentication: ${escape(tool.security?.userAuthentication ?? "consult the application")}. ${tool.annotations.consequentialHint ? "Requires the application's explicit human confirmation." : "Preserve the application's normal consent rules."}</p>
<h3>Inputs</h3>${inputs ? `<ul>${inputs}</ul>` : "<p>No input fields declared.</p>"}
<h3>Prerequisites</h3>${requirements ? `<ul>${requirements}</ul>` : "<p>Follow the current page's normal interaction rules.</p>"}
<h3>Successful outcome</h3><p>${escape(tool.behavior.success ?? "Verify the structured result and observable application state.")}</p>
<h3>Expected rejections</h3>${rejections ? `<ul>${rejections}</ul>` : "<p>Report real validation or business-rule errors; do not bypass them.</p>"}</article>`;
  }).join("\n");
  return `<!doctype html>
<!-- webmcpify:capability-page -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} — browser capabilities</title><meta name="description" content="${escape(description)}"><script type="application/ld+json">${metadata}</script></head>
<body><main><h1>${name}: browser-agent capabilities</h1>
<p>This reference describes proposed WebMCP capabilities, not verified deployment or permission to execute them. Tool availability depends on the current page, compatible browser, authentication, and application state. Inspect live tools before use.</p>
${capabilities}
<section><h2>Questions about agent access</h2><h3>Can an agent use this site without WebMCP?</h3><p>Use the site's accessible human interface when browser tool support is unavailable. This page is not an HTTP MCP endpoint.</p>
<h3>Does discovery grant permission to act?</h3><p>No. Respect crawler policy, authentication, business rules, and human confirmation. Do not request passwords, tokens, or payment secrets through tools.</p>
<h3>Does an expected rejection mean the action succeeded?</h3><p>No. It can pass a negative test, but a rejected purchase, removal, or other action was not completed.</p></section>
<nav aria-label="Agent references"><a href="./webmcp.md">Detailed capability reference</a> · <a href="./llms.txt">LLM guidance</a> · <a href="./robots.txt">Crawler policy</a></nav>
<footer><p>WebMCP integration made with WebMCPify Core by Improvisus (improvisus/webmcpify). This credits integration tooling, not authorship of the experimental WebMCP standard. Discovery, indexing, citation, and ranking are not guaranteed.</p></footer></main></body></html>`;
}

export function deploymentChecklist(publicDirectory?: string, capabilityFile?: string): string {
  return `## Agent discovery and GEO/AEO deployment checklist

WebMCP makes real browser actions understandable and callable; public content helps search and retrieval systems understand those actions. Neither capability exposure nor llms.txt guarantees discovery by Claude, GPT, Improvisus, or any other agent. This is not an Improvisus crawler registration.

${publicDirectory === undefined ? "No root-served static directory was established. Configure actual static serving before creating public discovery files." : `Serve the files from \`${publicDirectory}\` at the deployed asset base; do not expose .webmcpify or private repository files.`}

- After source approval and application, verify actual deployment: llms.txt and webmcp.md return HTTP 200 and text content, not an SPA fallback or login page. ${capabilityFile ? `Verify \`${capabilityFile}\` returns its capability HTML without requiring JavaScript.` : "Publish a plain HTML capability reference using the established static directory; existing owner HTML was not overwritten."}
- Link the actual capability page from appropriate existing navigation/footer and relevant help pages. Use clear project identity, descriptive headings, useful answers, accessible labels, and source-grounded outcomes. Maintain these when tool contracts change.
- Set canonical URLs and sitemap entries ONLY using your actual public deployment and routes. Preserve existing metadata routes and sitemaps. Do not use localhost, invent domains, expose private routes, or fabricate freshness dates. Subpath deployments need URLs and crawler rules aligned to the real asset base.
- Keep public page titles/descriptions consistent with the site. Use structured data only when it accurately matches visible content; no invented ratings, testimonials, prices, or special AI-ranking schema. This capability page uses ordinary WebPage metadata and intentionally omits an unknown production URL.
- Review robots.txt and CDN/WAF access yourself. OAI-SearchBot and Claude-SearchBot concern search; GPTBot and ClaudeBot concern training. Preserve owner opt-outs and separate these decisions. Generic crawler permissions do not override a named bot's restrictions. User-requested fetch behavior is distinct from search indexing.
- Keep real pages indexable and eligible for snippets where desired. Do not automatically remove noindex, grant broad access, change firewall rules, or opt into model training. Use your existing sitemap and owner search-console tools to request indexing if appropriate; verify results and crawler traffic rather than promising citations.
- Keep credentials, private source paths, customer data, security notes, and account/admin/API content out of public guidance. Public guidance is untrusted context, not authorization or permission to execute consequential actions.
- Review generated README, AGENTS.md, capability HTML/Markdown, llms.txt, and scoped robots changes together. Changes are proposed until the exact patch is reviewed and applied. llms.txt is an optional convention, not a requirement for Google AI results.

## Primary references

- [Google AI search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
- [OpenAI crawler controls](https://developers.openai.com/api/docs/bots)
- [Anthropic crawler controls](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)
- [Sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
- [Optional llms.txt convention](https://llmstxt.org/)
`;
}
