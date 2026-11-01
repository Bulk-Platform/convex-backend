# Bulk fork of the `convex` npm package

`Bulk-Platform/bulk_v3` installs this package as
`"convex": "npm:@bulk-platform/convex@<version>"` in `backend_v3`, where the
Convex CLI runs codegen and deploys. Clients (Yogi, services) keep the public
`convex` package of the same upstream version; the client runtime is unchanged.

A client that type-checks against the backend's modules must take the Convex
types from one copy of the package. TypeScript merges two copies only when their
name and version match, and with `ApiFromModules` from the client's `convex`
applied to modules typed by the backend's `@bulk-platform/convex`, every action
types as `FunctionReference<"action", "public", DefaultFunctionArgs, unknown>`.
So Yogi's `convex-generated/*.d.ts` re-export `backend_v3/convex/_generated/*`
rather than copying the files with rewritten module imports. A client that
copies them instead must install this package at the same version.

The `bulk/convex-npm` branch starts at the upstream commit that released the
version in `package.json`. It is separate from the backend runtime fork on
`main`, which versions independently.

## Patches

| Patch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files                                                                      | Test                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segmented `api.d.ts`: one `ApiFromModules` chunk per top-level folder, nested folders split again past 400 modules. Upstream's single chunk collapses to `never` near 1,950 modules in TypeScript 6 and 7 (TypeScript 5.0 does not).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/cli/codegen_templates/segmented_api.ts`, `api.ts`, `component_api.ts` | `bulk-tests/segmented_api.test.ts` compares with upstream's shape on a small fixture. `bulk-tests/segmented_api_scale.test.ts` type-checks 2,621- and 4,021-module projects. |
| Paged function spec: `npx convex function-spec`, the MCP `functionSpec` tool and `npx convex run`'s function list read `_system/cli/modules:apiSpecPage` a page at a time (Bulk runtime fork) and fall back to `apiSpec` when the backend lacks it, or for a component. One `apiSpec` response for Bulk's app is over the system result size and nesting limits. Output is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                        | `src/cli/lib/functionSpec.ts`, `run.ts`, `mcp/tools/functionSpec.ts`       | `bulk-tests/function_spec.test.ts`. The runtime fork's `npm-packages/system-udfs/scripts/api-spec-scale-test.mjs` covers the backend side.                                   |
| MCP `functionSpec` filters: optional `identifierPrefix` (matches identifiers with or without `.js`, and HTTP route paths), `includeValidators: false` (identifiers, types and visibility only), `validatorFormat: "compact"` (TypeScript-like validator strings such as `{ id: Id<"users">, n?: int64 }`) and `maxCharacters` (default 80,000, about 20k tokens, under Claude Code's default 25k-token MCP output limit). Over the cap the tool returns an error with the compact and no-validator sizes and the largest narrower prefixes. With a prefix, the backend reads only the matching modules (`apiSpecPage`'s `pathPrefix`, from the part before `:`, or `http.js` for a route path), instead of the whole spec (about 40 MB and 15 s for Bulk's app). Small apps get the same output as upstream. | `src/cli/lib/mcp/tools/functionSpec.ts`                                    | `bulk-tests/mcp_function_spec.test.ts`                                                                                                                                       |
| Release version `<upstream>-bulk.<n>`. `src/index.ts` keeps the upstream version, which is what the CLI and clients report to the backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `scripts/version-check.mjs`                                                | —                                                                                                                                                                            |

`api_cjs.ts` (`generateCommonJSApi`) and static codegen (`staticApi`) are not
patched.

### What the scale tests check

`segmented_api_scale.test.ts` generates projects past the cliff (a 600-module
`big/` folder with nested subfolders, an internal-only folder, a root module
that is also a folder) and type-checks them with `typescript@7.0.2` and its
default 4 checkers, as Bulk does. It runs `tsc` through `npx` (set `BULK_TSC` to
a local binary to skip the download). For `api.d.ts` and `api.ts` from
`apiCodegen`, and for both component codegen outputs, the probes in
`bulk-tests/probes.ts` assert:

- exact `FunctionReference`, `FunctionArgs` and `FunctionReturnType` types
  through `api.<folder>.<file>.<fn>` and `internal.…`, in every chunk;
- the exact key sets at the root, in the split folder and below it;
- that misspelled paths, internal functions through `api`, public functions
  through `internal`, helpers and wrong arguments fail, each with its own error,
  behind `@ts-expect-error`.

Two controls keep the probes honest: upstream's single `ApiFromModules` must
collapse to `never` at each size, and an `api` typed as `any` must fail the
probes. A TypeScript 5 run checks the segmented types equal upstream's at 2,621
modules.

### The one difference from upstream

A top-level folder or root module with no functions of a visibility stays on
that object as `{}`: for example `api.jobsInternal` when it only has internal
functions. Upstream drops the key. Any access below it (`api.jobsInternal.x`)
fails as before. Wrapping the root in `FilterApi` would drop these keys too, but
makes TypeScript resolve every chunk on first use of `api` (about 35% more check
time and 70% more memory at 4,000 modules).

## Release

1. Run `pnpm install --frozen-lockfile --filter "convex..."` in `npm-packages`,
   then `pnpm run typecheck` and `pnpm exec vitest run bulk-tests` here.
2. Push `bulk/convex-npm`, then tag the commit
   `convex-npm/v<package.json version>-bulk.<n>` and push the tag.
   `.github/workflows/bulk_release_convex_npm.yml` tests, packs and publishes
   `@bulk-platform/convex` to GitHub Packages with dist-tag `latest`.
3. In `bulk_v3/backend_v3`, bump the alias in `package.json`, run
   `pnpm install`, regenerate `convex/_generated` with
   `pnpm exec convex codegen` and run `pnpm run sync-types:all`. Keep Yogi's
   public `convex` at the same upstream version.

The first publish links the package to this repository, so it takes the
repository's visibility. A public package cannot be made private later.

### Installing

GitHub Packages needs a token for every install, public package or not. Each
project that installs the package has this `.npmrc`:

```ini
@bulk-platform:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

- Local dev and agent worktrees: `export NODE_AUTH_TOKEN=$(gh auth token)` with
  a `gh` login that has `read:packages` (`gh auth refresh -s read:packages`), or
  a classic PAT with `read:packages`.
- GitHub Actions in another repository: grant that repository read access under
  the package's "Manage Actions access", give the job
  `permissions: packages: read`, and set
  `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` on install steps.
- Docker builds: pass the token as a build secret
  (`RUN --mount=type=secret,id=npm_token NODE_AUTH_TOKEN=$(cat /run/secrets/npm_token) npm ci`),
  never as a build argument.

## Moving to a newer upstream release

Create a new branch from the upstream `npm release version X.Y.Z` commit,
cherry-pick the Bulk commits from `bulk/convex-npm`, run the tests above, and
release `X.Y.Z-bulk.1`. Keep the runtime image fork on `main` separate.
