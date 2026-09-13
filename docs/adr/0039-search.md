# A39 — Search: InnoDB FULLTEXT over a narrow projection, behind a `SearchIndex` interface

**Status:** Accepted (2026-09-11); **confirmed by the owner's answer to G5 on 2026-09-12** — no CJK ngram support at MVP. The Decision stands unchanged, and the clause that reads "CJK ngram support is G5 (default parser and `innodb_ft_min_token_size=2` until answered)" is now a settled position rather than a default in force: the default InnoDB full-text parser with a two-character minimum token is what 1.0 ships, with no ngram parser and no second index.

## Context

Spec §3 requires title and content search within the current vault; spec §4 requires that search results obey vault permissions and that "knowledge of a note ID must not grant access"; spec §8 says infrastructure can initially be one application deployment, MySQL, and attachment storage. An external engine (Meilisearch, Typesense) would add a deployment component, a second backup artifact, and — most importantly — would move the ACL filter out of SQL into application-side post-filtering, which is precisely where isolation bugs live. Digest §11.27 records four competing projection shapes; digest §5.2 confirms that InnoDB FULLTEXT needs `innodb_ft_min_token_size` set at server level (A9 bakes it to 2 and disables the stopword list), and that boolean mode requires server-side query construction because user input contains operator characters.

## Decision

A narrow table `note_search(note_id, vault_id, title, body_text, revision)` with `FULLTEXT ft_note_search(title, body_text)` created in its own migration, `0020_note_search_fulltext` (A7: one DDL statement per file). The skeleton names that one object twice — `ft_note_search` in the DDL and `ft_title_body` in this row — and decision D03-11 in `03-data-model.md` settles it as `ft_note_search`, which is also the name `iridium repair search` drops and rebuilds; `ft_title_body` names nothing that exists. Queries are built server-side in boolean mode: `+tok*` per token, operator characters escaped, `"phrases"` preserved, `-negation` supported; single-character tokens fall back to a `title LIKE ?` union because they fall below `innodb_ft_min_token_size`. The query parser lives in `@iridium/markdown/search/parseQuery.ts` and supports the `path:` and `file:` operators in the MVP; `tag:` and `line:` are reserved, and the `fm_tags` multi-valued index exists from day one so `tag:` needs no migration later. The ACL filter is `vault_id IN (accessible)` **inside the SQL statement**, never a post-filter. Ranking is `ORDER BY <MATCH … AGAINST score> DESC, note_id ASC` — exactly the keyset cursor `(score DESC, note_id)` of A35, so the ordering and the paging key are the same total order. `updated_at` is returned per hit and a client may sort a page by it, but it does **not** affect ranking: a tie-breaker outside the keyset is not a total order over the result set, so a page boundary inside a score tie would silently drop or duplicate hits — and on the MCP path an agent has no way to notice. Everything sits behind a `SearchIndex {index, remove, query, rebuild}` interface so Meilisearch can replace the implementation post-MVP without touching callers. CJK ngram support is G5 (default parser and `innodb_ft_min_token_size=2` until answered).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Meilisearch or Typesense in the MVP | A second stateful component to deploy, back up, restore, and secure; ACL filtering moves out of SQL; spec §8 asks for one application plus MySQL plus attachment storage. Kept as the post-MVP path behind the interface. |
| SQLite FTS5 alongside MySQL | A second storage engine to keep consistent with the system of record and to include in the backup set (A47). |
| `LIKE '%term%'` only | No ranking, no phrase handling, full scans on a vault of any size. |
| Indexing `note_projections.markdown` directly | Markdown punctuation pollutes tokens and scores; `body_text` is the plain-text projection with `yaml` and `html` nodes filtered out (digest §7.4). |
| Application-side ACL filtering after an unfiltered search | The isolation bug class the "Vault isolation" acceptance row exists to catch. |
| A wide search table (headings, links, tasks in the same row) | Bloats the FULLTEXT index; those projections live in `note_projections` and `note_links` where they are queried structurally. |

## Consequences

Positive: no new deployment component; the ACL is a SQL predicate that the isolation test exercises directly; rebuilds are a single job (`iridium reindex`); the interface records the replacement criterion rather than pretending FULLTEXT is forever. Negative: InnoDB FULLTEXT ranking is crude compared with a dedicated engine (no typo tolerance, no configurable synonyms) and `innodb_ft_min_token_size` is a server-level setting, so changing it requires a restart and a rebuild — which is why A9 bakes it before migration 0001; boolean-mode query construction is security-sensitive (operator escaping is unit-tested with a hostile corpus); CJK needs a second index and is deliberately parked at G5.

## Verification

`search.query-parser.unit` (operator escaping, phrases, negation, `path:`/`file:`, single-character fallback, hostile input); `search.acl.integration` (the "Vault isolation" row: a user's search never returns another vault's notes, including by guessed id); `search.ranking.integration` (score descending then `note_id` ascending, ties broken deterministically, and `updated_at` provably not part of the ordering); `search.rebuild.integration` (`iridium reindex --vault` and `--stale` reproduce the index exactly); `search.staleness-hint.integration` (A38).

## References

Digest §5.2 (InnoDB FULLTEXT, `innodb_ft_min_token_size`), §7.4 (filter `yaml`/`html` from plain text), §11.27, §3.6; spec §3, §4, §8; plan-risk-first ADR-22; **G5, answered "no" on 2026-09-12**, confirming this ADR's stated default without changing it. A59 additionally requires that the FULLTEXT configuration this decision depends on behaves identically on MySQL 8.4.11 and 9.7.2, which `migrations.parity.integration` and `ops.mysql-config.spec` assert on both images. Implemented in `03-data-model.md` and `08-markdown-pipeline-import-export.md`.

---

Source: docs/plan/13-decision-log.md, decision A39. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
