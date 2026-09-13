# @iridium/api-codegen

The workspace that declares `openapi-typescript` 7.13.0, and nothing else.

`openapi-typescript` prints its output through TypeScript's JavaScript compiler API (`ts.factory`),
which the native TypeScript 7.0.2 checker the rest of the repository builds with does not ship
(risk R-T10). The generator therefore needs the same isolation `tooling/mutation` gives Stryker's
`typescript-checker` (decision A2): a leaf package whose `typescript` devDependency is the
`@typescript/typescript6@6.0.2` alias, which nothing imports and no `tsc` invocation outside this
directory can resolve.

The package has no sources and no scripts. Step 3 of `pnpm gen` (`scripts/generate-api-types.ts`)
resolves the `openapi-typescript` bin from this directory and writes
`packages/api-client/src/generated/paths.d.ts`; `@iridium/api-client` keeps owning that artefact and
compiles it with TypeScript 7.0.2 like every other package.

`@typescript/typescript6` may appear in exactly two manifests, this one and `tooling/mutation`'s;
the `guards.mutation-lane.guard` test asserts that list.
