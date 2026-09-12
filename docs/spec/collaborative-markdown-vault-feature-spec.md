# Collaborative Markdown Vault
## MVP Feature Specification

Status: Proposed draft  
Date: September 11, 2026

## 1. Purpose

Provide an Obsidian-inspired documentation workspace where employees organize, read, and edit Markdown notes in centrally managed vaults. Multiple employees must be able to edit the same note without stale whole-document saves overwriting one another.

Markdown must remain the document content format and be accessible as ordinary `.md` files through export and as plain text through an authenticated API. The application is a focused internal documentation tool, not a complete Obsidian replacement.

## 2. Core objects and behavior

| Object | Definition and behavior |
|---|---|
| Server | The centrally administered service that owns vaults, user accounts, authorization, and persistence. Clients connect to it rather than directly editing a shared network folder. |
| Vault | An independent collection of categories, notes, and attachments, with its own membership and permissions. Users see only vaults they can access. |
| Category | A folder-like container within a vault. It can contain notes and nested categories, but has no Markdown body. Selecting it displays its children. |
| Note | A Markdown document with a stable ID, filename/title metadata, and one location: the vault root or a category. Selecting it opens the document. Notes cannot contain child notes. |
| Attachment | A server-managed file belonging to one vault, referenced from Markdown and protected by that vault's permissions. |

Categories are organizational folders, not tags. Notes do not belong to multiple categories. A category overview can be an ordinary note inside the category; it is not a separate document type.

Stable IDs do not change when a note or category is renamed or moved. Note filenames and the first Markdown heading are separate; renaming a note does not silently rewrite its heading.

## 3. Workspace and editing

After connecting to a configured server and signing in, a user selects an accessible vault. The workspace provides a vault selector, a collapsible category/note tree, document tabs, and title/content search within the current vault.

Authorized editors can create, rename, and move notes and categories within a vault. Notes can be moved to trash and restored. Nonempty categories cannot be deleted until their contents have been moved or explicitly trashed. Conflicting names and invalid category moves, including moving a category into its descendant, are rejected.

The editor provides Markdown source editing, rendered reading mode, and split source/preview mode. Initial formatting support includes headings, emphasis, lists, task lists, tables, blockquotes, fenced code blocks, links, and images. Formatting shortcuts modify the Markdown source directly.

Frontmatter, code, whitespace, and unsupported syntax must not be rewritten merely by opening or previewing a note. The initial release is not a rich-text editor that repeatedly converts Markdown to an editor-specific document format and back.

Standard relative Markdown links resolve within the vault. The initial release warns about affected links before a linked note is moved or renamed; automatic cross-document link rewriting is deferred. Obsidian-specific syntax is addressed explicitly during import rather than assumed compatible.

## 4. Access control

Permissions apply to the entire vault and are inherited by its categories, notes, attachments, history, search results, and exports.

| Role | Allowed actions |
|---|---|
| Viewer | Browse, search, read notes, follow links, read history, and download/export accessible content. Cannot modify content or metadata. |
| Editor | Viewer permissions, plus create, edit, rename, move, trash, and restore notes; organize categories; and manage attachments. |
| Vault manager | Editor permissions, plus manage vault membership and settings, archive the vault, and perform coordinated content-version restores. |
| Server administrator | Manage server configuration and user accounts, create vaults, and administer all vaults. This role is explicitly trusted with all vault content. |

Accounts are administrator-managed; there is no public registration. There are no note-level permission exceptions in the MVP.

Authorization is enforced on the server for REST requests, collaboration connections and incoming edits, attachments, search, history, and exports. Knowledge of a note ID must not grant access. Read-only controls in the client are a convenience, not the security boundary.

Revoking access or downgrading a role must affect already-open sessions, not just the next login. The server must stop unauthorized future reads/writes and disconnect or reauthorize affected collaboration sessions. It cannot retract content a user already viewed or exported.

## 5. Live collaboration and saving

Multiple authorized editors can edit the same note simultaneously. Changes synchronize through an established CRDT implementation. The UI shows connected participants and their cursors/selections. Undo and redo target the current user's editing operations rather than indiscriminately undoing another participant's work.

Use Yjs for the MVP; do not implement both CRDT and OT, or invent a new synchronization engine. The CodeMirror binding supports shared text, remote cursors, and per-client undo history. [1]

Document bodies are synchronized through WebSockets. REST is used for accounts, vaults, membership, category/note metadata, attachments, search, import, and export. There is no unrestricted REST endpoint that replaces an active note with a client-supplied full-document snapshot.

The UI distinguishes syncing, saved, disconnected, and save-failed states. **Saved means the server has durably persisted a state that includes the user's pending edits.** Being connected or synchronized with the server's memory is not sufficient.

The MVP is online-first. A detected disconnect pauses further editing, retains pending changes in the current session, and warns before closing with unsaved work. Reconnection rechecks authorization before merging pending changes through the collaboration protocol. Rejected changes remain visibly unsaved and recoverable for review; they are not silently discarded or sent through an authorization bypass. Full offline operation and guaranteed recovery of unacknowledged edits after a client crash are outside the MVP.

Convergence is a technical guarantee to test, not a guarantee that two people editing the same sentence will produce sensible prose. Intentional deletions still delete content.

## 6. Server and storage architecture

| Layer | Proposed implementation |
|---|---|
| Desktop client | Electron with a TypeScript UI; keep desktop-specific integration thin. |
| Markdown editor | CodeMirror 6 bound to a Yjs shared-text value, with a separate sanitized Markdown preview. |
| Application server | Node.js with TypeScript and REST endpoints. |
| Collaboration server | Hocuspocus and its matching client provider, using Yjs over WebSockets. |
| Database | MySQL for accounts, memberships, hierarchy, metadata, persisted Yjs state, content revisions, and rebuildable Markdown/search projections. |
| Files | Server-managed attachment storage and generated Markdown export directories or archives. |

Hocuspocus provides authentication/read-only controls and a generic persistence extension with application-supplied fetch/store functions; integrating those functions with MySQL is part of this project. These components do not implement the application's complete authorization or durability policy automatically. [2][3]

The persisted Yjs state is authoritative for collaborative document state. Markdown is the readable text within that state, not an alternative independently writable master. Initialize a document once during creation/import, then reload its persisted binary state. Reconstructing a fresh Yjs document from Markdown on every load would lose the identities needed for collaboration; Hocuspocus specifically warns against regenerating document state during normal persistence. [3][4]

Expose a current committed Markdown representation through the API and export. Any cached text, search index, or generated `.md` file records its source revision and must not overwrite newer state. A continuously generated filesystem mirror is optional and strictly read-only to employees and integrations.

Start with one collaboration-server process owning active documents. Serialize persistence per note so an older asynchronous save cannot overwrite a newer state. Hierarchy, names, permissions, and deletion use database transactions and metadata version checks; they do not become safe merely because document text uses CRDTs.

Note deletion closes editing sessions and prevents stale clients from recreating the note. A version restore is a confirmed, coordinated content change applied through the collaboration service and recorded as a new revision, not a silent replacement of the live CRDT state.

## 7. Markdown portability and LLM access

Import an existing Markdown directory or ZIP as a new vault, preserving its relative hierarchy and supported attachments. Show an import report for filename collisions, unsafe paths, broken references, unsupported files, and Obsidian-specific features. Do not silently normalize or discard note content. Obsidian stores its notes in Markdown files and application configuration separately in `.obsidian`; application configuration and plugins are not imported as executable functionality. [5]

The initial compatibility contract is Markdown source plus the supported renderer described above. Wikilinks, transclusions, callouts, Dataview queries, canvas files, and plugin behavior are not presumed equivalent; preserve source text and identify unsupported constructs before migration is accepted.

Export a vault as a folder tree or ZIP containing ordinary `.md` files and attachments. Preserve supported relative references, and include a manifest of note IDs, paths, and committed revisions. Never overwrite an existing external directory without an explicit destination/overwrite decision.

Provide authenticated, read-only endpoints to enumerate accessible notes and fetch Markdown with stable IDs and revisions. Permit vault-scoped read-only integration credentials for approved LLM tooling. Search and export use the same access rules as the application. Permission revocation also stops further integration access; previously exported copies require downstream handling.

AI editing, a built-in chatbot, vector search, and autonomous agent write access are not required for the MVP.

## 8. Recovery, security, and operation

Maintain recoverable content checkpoints and trash, separate from the binary state used for synchronization. Record administrative and structural actions using authenticated identities; do not treat CRDT client identifiers or self-reported cursor names as proof of authorship.

Back up the database and attachments together using a documented recovery procedure, and test restoration. A Markdown export is a useful portability copy but is not a complete backup of accounts, permissions, revisions, attachments, and collaboration state.

Use HTTPS/WSS, established authentication/password-storage components, input validation, upload/message size limits, and safe path handling. Do not expose MySQL or writable server storage directly to clients.

Render Markdown as untrusted content: disable executable HTML, sanitize rendered output, restrict URL schemes and navigation, and do not expose Node.js or unrestricted Electron APIs to note content. Enable renderer context isolation and sandboxing with a narrow, validated preload interface. These requirements follow Electron's security guidance. [6]

Ship a repeatable server deployment, database migrations, health checks, and operational logging that excludes credentials and unnecessary document content. Infrastructure can initially be one application deployment, MySQL, and persistent attachment storage; horizontal scaling is not an MVP requirement.

## 9. Acceptance criteria

| Test | Required outcome |
|---|---|
| Concurrent editing | At least three independent clients edit one note, including overlapping positions. After synchronization, all clients and persisted content agree without stale whole-file replacement. |
| Initialization/reconnection | Two clients open an imported note simultaneously, reconnect, and reopen after a server restart without duplicated initial content. |
| Viewer enforcement | Direct REST and collaboration-protocol attempts by a viewer cannot mutate content, metadata, or attachments. |
| Vault isolation | An unauthorized user cannot obtain another vault's content, metadata, search results, history, attachments, or exports using guessed IDs. |
| Live revocation | Removing membership or edit permission affects already-open sessions and prevents later unauthorized reads/writes. |
| Durable saving | Kill the server immediately after it acknowledges a specific revision as saved. Restarting recovers that revision and its content; failed persistence never produces a saved acknowledgement. |
| Structural concurrency | Concurrent rename/move/delete operations either succeed consistently or return an explicit conflict. Stale clients cannot resurrect trashed notes. |
| Portability and safety | Markdown/frontmatter/code survive import and export without unintended changes; supported links and attachments resolve; hostile note content cannot execute scripts or access desktop privileges. |
| Backup recovery | A clean deployment can restore vault content, attachments, permissions, and revision history from the documented backup set. |

## 10. Explicitly deferred

Defer a plugin ecosystem, graph view, advanced WYSIWYG/live-preview editing, automatic link rewriting, full Obsidian syntax compatibility, per-note/category ACL overrides, public sharing, cross-vault moves, bidirectional filesystem/Git sync, offline-first editing, mobile clients, enterprise SSO, multi-server collaboration, and built-in AI features.

The first implementation milestone is one authenticated note, two editors, one viewer, MySQL persistence, and a server restart. Prove correct collaboration, authorization, and saving before expanding the vault-management UI.

## Technical references

References support component capabilities and implementation constraints; the feature requirements above are proposed product decisions, not claims that these libraries provide the complete application.

[1] Yjs — CodeMirror 6 binding, cursors, and per-client undo. The repository currently distinguishes the stable package from its development branch; pin a mutually compatible stable dependency set. `https://github.com/yjs/y-codemirror.next`

[2] Hocuspocus — Authentication and read-only mode. `https://tiptap.dev/docs/hocuspocus/guides/authentication`

[3] Hocuspocus — Generic database extension and binary state persistence. `https://tiptap.dev/docs/hocuspocus/server/extensions/database`

[4] Hocuspocus — Document loading and debounced persistence hooks. The application must implement and test its own durable-save acknowledgement semantics. `https://tiptap.dev/docs/hocuspocus/server/hooks`

[5] Obsidian — How Obsidian stores data. `https://obsidian.md/help/data-storage`

[6] Electron — Security recommendations. `https://www.electronjs.org/docs/latest/tutorial/security`

[7] Yjs — Document updates, state encoding, and convergence. `https://docs.yjs.dev/api/document-updates`
