/**
 * `PIPELINE_VERSION` — the value every `note_projections.pipeline_version` row records
 * (03-data-model.md §9.3; 08-markdown-pipeline-import-export.md, "Package layout").
 *
 * It versions the projection pipeline's *output*: a change to what `project()` derives from the same
 * text — headings, tasks, links, body text — bumps it, and `iridium reindex --pipeline-version` (M2)
 * compares stored rows against it, so a change here is a reindex and never a silent reinterpretation.
 */

/** The version of the projection pipeline whose rows the current writer produces. */
export const PIPELINE_VERSION = 3;
