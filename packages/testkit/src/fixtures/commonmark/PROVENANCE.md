# CommonMark 0.31.2 conformance examples

Vendored third-party fixture. Fixture policy rule 6 (10-testing-and-quality.md, "Test data and
fixtures policy") requires this file to record its source, version, retrieval date and licence.

| Field | Value |
|---|---|
| Artefact | `spec.json` — the machine-readable example set of the CommonMark specification |
| Version | CommonMark **0.31.2** |
| Source | `https://spec.commonmark.org/0.31.2/spec.json` (the specification's own published artefact; the same bytes the `commonmark-spec` npm package redistributes) |
| Retrieved | 2026-09-13 |
| Upstream `Last-Modified` | Sun, 01 Jun 2025 18:05:05 GMT |
| Upstream `ETag` | `"683c9651-224c7"` |
| Size | 140 487 bytes, 652 examples across 26 sections |
| Licence | CC-BY-SA 4.0 (the CommonMark specification), Copyright © 2014-2021 John MacFarlane |
| Used by | `markdown.commonmark.unit` (10-testing-and-quality.md, "Inventory completeness") |

## Shape

A JSON array. Each element is one example:

```json
{
  "markdown": "\tfoo\tbaz\t\tbim\n",
  "html": "<pre><code>foo\tbaz\t\tbim\n</code></pre>\n",
  "example": 1,
  "start_line": 355,
  "end_line": 360,
  "section": "Tabs"
}
```

`markdown` and `html` carry real tab and newline characters, so the file is a fixture rather than
formatted source: `.oxfmtrc.jsonc` and `oxlint.config.ts` both exclude
`packages/testkit/src/fixtures/**`, and nothing may reformat it.

## Updating

Bump the pinned CommonMark version, re-fetch from `https://spec.commonmark.org/<version>/spec.json`,
update every field of the table above, and bump `IRIDIUM_FIXTURE_VERSION` (fixture policy rule 7) so
that golden artefacts embedding the old version fail loudly instead of comparing against the wrong
input. The licence is checked by the `license` step of the `static` CI job against its allowlist.
