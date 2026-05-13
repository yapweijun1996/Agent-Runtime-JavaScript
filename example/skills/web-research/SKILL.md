---
name: web-research
description: Search the web and read source URLs using the runtime web_search and read_url actions.
tags: web, search, read-url, research, source, citation, current, latest, article
inputTypes: url, webpage, article, news, documentation, search-query
---
# Web Research

Use this skill when the user asks for current information, asks you to search
online, provides a URL to inspect, asks for article review, or needs source-backed
facts.

Rules:

1. Use `web_search` when you need to discover candidate sources.
2. Use `read_url` when the user provides a URL directly, or when search snippets
   are not enough and you need page text.
3. Treat `web_search` and `read_url` as runtime actions, not hardcoded HTTP
   calls inside the skill instructions.
4. For the browser read-url service, the correct service entrypoint is
   `POST /read-url`. Do not try unsupported paths like `/read`, `/fetch`,
   `/scrape`, `/v1/*`, `/api/*`, `/reader`, `/parse`, or `/markdown`.
5. Hosts should configure the read-url service endpoint and API key through
   runtime/browser settings or environment variables. Do not print, summarize,
   or expose the API key in answers.
6. If `read_url` reports `API_KEY_MISSING`, `401`, or an unavailable service,
   explain that the browser/runtime read-url endpoint or key must be configured.
7. A degraded health check does not prove page reads are broken. Trust the actual
   `read_url` action result for the requested URL.
8. Prefer direct source links and page-grounded evidence. If only snippets are
   available, say that the answer is search-grounded rather than page-grounded.
9. If a `read_url` result includes `textRange.hasAfter=true` and the missing
   answer may be later in the same page, call `read_url` again with the same URL
   and `textStart=textRange.nextTextStart`. Decide based on the task; do not
   assume the first source window is enough.
