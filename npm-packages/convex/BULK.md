# Bulk fork of the `convex` npm package

`Bulk-Platform/bulk_v3` installs this package as
`"convex": "npm:@bulk-platform/convex@<version>"` in `backend_v3`, where the
Convex CLI runs codegen and deploys. Clients (Yogi, services) keep using the
public `convex` package: the generated files only use public `convex/server`
types, and the client runtime is unchanged.

The `bulk/convex-npm` branch starts at the upstream commit that released the
version in `package.json`. It is separate from the backend runtime fork on
`main`, which versions independently.

## Patches

| Patch                                                                                                                                                                                                                                                                                             | Files                                                                      | Test                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Segmented `api.d.ts`: one `ApiFromModules` chunk per top-level folder, nested folders split again past 400 modules. Upstream's single chunk collapses to `never` near 1,950 modules because TypeScript evaluates it within one statement's instantiation budget. Types are identical to upstream. | `src/cli/codegen_templates/segmented_api.ts`, `api.ts`, `component_api.ts` | `bulk-tests/segmented_api.test.ts` compiles a fixture project and asserts the segmented `api` / `internal` equal upstream's. |
| Release version `<upstream>-bulk.<n>`. `src/index.ts` keeps the upstream version, which is what the CLI and clients report to the backend.                                                                                                                                                        | `scripts/version-check.mjs`                                                | —                                                                                                                            |

`api_cjs.ts` (`generateCommonJSApi`) and static codegen (`staticApi`) are not
patched.

## Release

1. Run `pnpm install --frozen-lockfile --filter "convex..."` in `npm-packages`,
   then `pnpm run typecheck` and `pnpm exec vitest run bulk-tests` here.
2. Push `bulk/convex-npm`, then tag the commit
   `convex-npm/v<package.json version>-bulk.<n>` and push the tag.
   `.github/workflows/bulk_release_convex_npm.yml` tests, packs and publishes
   `@bulk-platform/convex` to GitHub Packages.
3. In `bulk_v3/backend_v3`, bump the alias, run `pnpm install`, regenerate
   `convex/_generated` and sync client types.

Installs need a token with `read:packages` and this `.npmrc` entry:

```ini
@bulk-platform:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

## Moving to a newer upstream release

Create a new branch from the upstream `npm release version X.Y.Z` commit,
cherry-pick the Bulk commits from `bulk/convex-npm`, run the tests above, and
release `X.Y.Z-bulk.1`. Keep the runtime image fork on `main` separate.
