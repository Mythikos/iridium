# Markdown pipeline fixture provenance

`commonmark-0.31.2.json` is the complete CommonMark 0.31.2 official example corpus,
retrieved from https://spec.commonmark.org/0.31.2/spec.json on 2026-09-20. It contains
652 examples and is identical to the canonical testkit corpus at
`packages/testkit/src/fixtures/commonmark/spec.json`. Licence: CC-BY-SA 4.0,
Copyright © 2014–2021 John MacFarlane. The testkit `PROVENANCE.md` records the
original vendoring metadata.

`commonmark-deviations.json` records exact expected output for each intentional
Iridium policy difference, with its specification section. The conformance test
runs every example and rejects obsolete exceptions.

The GFM golden and extended hostile sources are original Iridium test data. Their
Markdown source, mdast, sanitized hast, HTML, and projection snapshots are immutable
fixture data and must not be reformatted. Original testkit hostile Markdown also
runs in the same sanitizer suite without copying its bytes.

Pathological sources use committed repetition descriptors rather than megabytes
of identical bytes. The testkit adapter expands those descriptors deterministically.
