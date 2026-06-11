/**
 * AGRUN-207 — Provider server-auth header allow-list helper.
 *
 * Why this exists:
 *   AGRUN-205 added server-auth fetch wrappers that strip a black-list
 *   of known credential headers (`authorization`, `openai-organization`,
 *   `x-goog-api-key`, ...). Black-lists fail open: any future SDK header
 *   carrying a secret slips through until someone notices. Allow-lists
 *   fail closed — only headers the host proxy genuinely needs flow
 *   through, everything else is dropped.
 *
 * Contract:
 *   `filterHeadersByAllowList(headers, allowList)` returns a fresh
 *   `Headers` instance containing only entries whose lowercased name is
 *   in `allowList`. Names are compared case-insensitively. Input
 *   `headers` may be a `Headers` instance, a plain object, an array of
 *   tuples, `null`, or `undefined`; missing input yields an empty
 *   `Headers` so callers can splat the result without branching.
 *
 *   The allow-list itself is a per-provider constant. The two
 *   providers (OpenAI / Gemini) currently agree on the minimum set
 *   (`content-type`, `accept`), but they own their own constants so a
 *   future divergence (one provider needing, say, `x-stainless-arch`)
 *   does not force the other to widen its surface.
 */

function filterHeadersByAllowList(headers, allowList) {
  const allowed = new Set(
    Array.isArray(allowList)
      ? allowList.map((name) => String(name).toLowerCase())
      : []
  );
  const out = new Headers();
  if (!headers) return out;

  // Use Headers as the canonical iterator — handles plain object,
  // tuple array, and existing Headers uniformly via `new Headers(...)`.
  const source = headers instanceof Headers ? headers : new Headers(headers);
  source.forEach((value, key) => {
    if (allowed.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

export { filterHeadersByAllowList };
