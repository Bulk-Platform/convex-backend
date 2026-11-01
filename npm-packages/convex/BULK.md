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

The package builds from the fork's `main`, the Bulk line it shares with the
runtime image. `main` merges upstream at its npm releases, so the package is
upstream's release of the version in `package.json` plus the patches below.
`BULK_FORK.md` describes the line, the versions and the upstream sync.

## Patches

| Patch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files                                                                      | Test                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segmented `api.d.ts`: one `ApiFromModules` chunk per top-level folder, nested folders split again past 400 modules. Upstream's single chunk collapses to `never` near 1,950 modules in TypeScript 6 and 7 (TypeScript 5.0 does not). CommonJS codegen's `api_cjs.d.cts` is the same text, so it is segmented too. Static codegen is unpatched (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/cli/codegen_templates/segmented_api.ts`, `api.ts`, `component_api.ts` | `bulk-tests/segmented_api.test.ts` compares with upstream's shape on a small fixture. `bulk-tests/segmented_api_scale.test.ts` type-checks 2,621- and 4,021-module projects. |
| Paged function spec: `npx convex function-spec`, the MCP `functionSpec` tool and `npx convex run`'s function list read `_system/cli/modules:apiSpecPage` a page at a time (Bulk runtime fork) and fall back to `apiSpec` when the backend lacks it, or for a component. One `apiSpec` response for Bulk's app is over the system result size and nesting limits. Output is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                        | `src/cli/lib/functionSpec.ts`, `run.ts`, `mcp/tools/functionSpec.ts`       | `bulk-tests/function_spec.test.ts`. The runtime fork's `npm-packages/system-udfs/scripts/api-spec-scale-test.mjs` covers the backend side.                                   |
| MCP `functionSpec` filters: optional `identifierPrefix` (matches identifiers with or without `.js`, and HTTP route paths), `includeValidators: false` (identifiers, types and visibility only), `validatorFormat: "compact"` (TypeScript-like validator strings such as `{ id: Id<"users">, n?: int64 }`) and `maxCharacters` (default 80,000, about 20k tokens, under Claude Code's default 25k-token MCP output limit). Over the cap the tool returns an error with the compact and no-validator sizes and the largest narrower prefixes. With a prefix, the backend reads only the matching modules (`apiSpecPage`'s `pathPrefix`, from the part before `:`, or `http.js` for a route path), instead of the whole spec (about 40 MB and 15 s for Bulk's app). Small apps get the same output as upstream. | `src/cli/lib/mcp/tools/functionSpec.ts`                                    | `bulk-tests/mcp_function_spec.test.ts`                                                                                                                                       |
| Release version `<upstream>-bulk.<n>`, set at pack time. `package.json` and `src/index.ts` keep the upstream version, which is what the CLI and clients report to the backend, so upstream release merges never conflict there. `version-check.mjs` accepts `<src/index.ts version>-bulk.<n>` in the packed `package.json`; the release workflow checks the tag against `main` and the merged upstream release (`node bulk/upstream.mjs status --check-release`).                                                                                                                                                                                                                                                                                                                                            | `scripts/version-check.mjs`                                                | —                                                                                                                                                                            |

### CommonJS and static codegen

`generateCommonJSApi` (`convex codegen --commonjs`) writes `api_cjs.d.cts` with
the same text as `api.d.ts`: `apiCjsCodegen` reuses `apiCodegen`'s declarations
and component codegen writes its `api.d.ts` contents twice. So upstream's
CommonJS types collapse exactly like its `api.d.ts`, and the fork's are
segmented without a patch of their own.

Static codegen (`codegen.staticApi`, off in Bulk) writes each function's
`FunctionReference` type out from the backend's validators instead of
`ApiFromModules`, so it has no cliff. It is upstream's code, unpatched. With
TypeScript 7.0.2 on the scale fixtures (whole project, probes included):

| Modules | Output               | `api` file | Check time | Memory  |
| ------- | -------------------- | ---------- | ---------- | ------- |
| 2,621   | upstream (collapses) | 0.2 MB     | 2.4 s      | 1.2 GB  |
| 2,621   | segmented            | 0.2 MB     | 2.8 s      | 2.2 GB  |
| 2,621   | static               | 0.8 MB     | 0.8 s      | 0.8 GB  |
| 4,021   | upstream (collapses) | 0.3 MB     | 3.2 s      | 1.7 GB  |
| 4,021   | segmented            | 0.3 MB     | 3.7 s      | 2.9 GB  |
| 4,021   | static               | 1.2 MB     | 1.3 s      | 1.2 GB  |
| 20,021  | segmented            | 1.7 MB     | 20.1 s     | 11.7 GB |
| 20,021  | static               | 6.2 MB     | 7.4 s      | 5.6 GB  |

The CommonJS file checks in the same time and memory as `api.d.ts`. Static
output grows with the size of the validators, which the fixtures keep small: an
app with large `args` or `returns` validators gets a larger file, but no
type-level limit. Like upstream, static `api` drops a top-level folder that has
no public functions instead of keeping it as `{}`.

`bulk/patches.txt` at the repository root lists every file each patch changes,
and `node bulk/upstream.mjs inventory` prints the package's current diff from
upstream by patch. A patch adds its files there in the same pull request.

### What the scale tests check

`segmented_api_scale.test.ts` generates projects past the cliff (a 600-module
`big/` folder with nested subfolders, an internal-only folder, a root module
that is also a folder) and type-checks them with `typescript@7.0.2` and its
default 4 checkers, as Bulk does. It runs `tsc` through `npx` (set `BULK_TSC` to
a local binary to skip the download). For `api.d.ts` and `api.ts` from
`apiCodegen`, `api_cjs.d.cts` from `apiCjsCodegen` (imported as
`./_generated/api_cjs.cjs`), static codegen's `api.d.ts` and `api.ts`, and both
dynamic component codegen outputs, the probes in `bulk-tests/probes.ts` assert:

- exact `FunctionReference`, `FunctionArgs` and `FunctionReturnType` types
  through `api.<folder>.<file>.<fn>` and `internal.…`, in every chunk;
- the exact key sets at the root, in the split folder and below it;
- that misspelled paths, internal functions through `api`, public functions
  through `internal`, helpers and wrong arguments fail, each with its own error,
  behind `@ts-expect-error`.

Two controls keep the probes honest: upstream's single `ApiFromModules` must
collapse to `never` at each size, as `api.d.ts` and as `api_cjs.d.cts`, and an
`api` typed as `any` must fail the probes. A TypeScript 5 run checks the
segmented types equal upstream's at 2,621 modules.

### The one difference from upstream

A top-level folder or root module with no functions of a visibility stays on
that object as `{}`: for example `api.jobsInternal` when it only has internal
functions. Upstream drops the key. Any access below it (`api.jobsInternal.x`)
fails as before. Wrapping the root in `FilterApi` would drop these keys too, but
makes TypeScript resolve every chunk on first use of `api` (about 35% more check
time and 70% more memory at 4,000 modules).

## Release

1. Merge the change, or the upstream sync pull request, into `main`.
   `bulk_checks.yml` has run the type check, the build and `bulk-tests` on it.
   To run them locally: `pnpm install --frozen-lockfile --filter "convex..."` in
   `npm-packages`, then `pnpm run typecheck` and
   `pnpm exec vitest run bulk-tests` here.
2. Tag the commit on `main` with an annotated tag
   `convex-npm/v<package.json version>-bulk.<n>` and push the tag:

   ```bash
   git fetch origin
   git tag -a convex-npm/v1.49.0-bulk.1 origin/main -m "@bulk-platform/convex 1.49.0-bulk.1"
   git push origin convex-npm/v1.49.0-bulk.1
   ```

   `.github/workflows/bulk_release_convex_npm.yml` checks that the tag is on
   `main` and names `package.json`'s version, that `package.json` is the newest
   upstream release `main` has merged, that `main` has no upstream npm-package
   commits after that release, and that `bulk/patches.txt` is current. It then
   tests, packs and publishes `@bulk-platform/convex` to GitHub Packages with
   dist-tag `latest`. Packing builds the package with
   `uv run --script scripts/build.py` (since upstream 1.48.0), so a local
   `npm pack` needs `uv` too.

3. In `bulk_v3/backend_v3`, bump the alias in `package.json`, run
   `pnpm install`, regenerate `convex/_generated` with
   `pnpm exec convex codegen` and run `pnpm run sync-types:all`. Keep Yogi's
   public `convex` at the same upstream version.

`<n>` starts at 1 for each upstream release. `node bulk/upstream.mjs status`
shows what a release from `HEAD` would contain.

When `main` has merged upstream past a release (to take a runtime fix early),
the package would ship upstream npm changes that are in no upstream release, and
the release check fails, listing them. Release after the next upstream release
is merged, or, after reading the listed commits, add a line
`Allow-Unreleased-Upstream: yes` to the tag message:

```bash
git tag -a convex-npm/v1.49.0-bulk.1 origin/main -m "@bulk-platform/convex 1.49.0-bulk.1

Allow-Unreleased-Upstream: yes"
```

`main` is at that point now: it merged upstream 26f96d6f3, one commit after
1.49.0, which changes the generated management API types
(`src/cli/generatedApi.ts`).

A fix for an older line goes on a `bulk/convex-npm-<version>` maintenance branch
and is tagged there.

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

## Taking a newer upstream release

`.github/workflows/bulk_upstream_sync.yml` opens a pull request that merges each
new upstream npm release into `main` and runs the checks above on the merged
tree (`BULK_FORK.md`, "Upstream sync"). After it merges, release
`<new version>-bulk.1`. There is nothing to cherry-pick: the patches are already
in `main`'s history, and an upstream change to a patched file shows up as a
conflict or under "Upstream commits that change Bulk-patched files" in the pull
request.
