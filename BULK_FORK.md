# Bulk Platform Convex fork

## Purpose

Bulk self-hosts Convex and uses this fork for the production backend runtime and
for `@bulk-platform/convex`, the npm package `bulk_v3/backend_v3` runs codegen
and deploys with (`npm-packages/convex/BULK.md`). The fork exists so
high-capacity installations can tune the runtime and so codegen and the CLI work
for an app of Bulk's size, while keeping the rest of Convex close to upstream.

| Concern                                    | Source of truth                    |
| ------------------------------------------ | ---------------------------------- |
| Convex Runtime Rust source                 | This repository                    |
| `@bulk-platform/convex` npm package        | This repository                    |
| Bulk patch inventory                       | `bulk/patches.txt`                 |
| Convex application functions and schema    | `Bulk-Platform/bulk_v3/backend_v3` |
| Runtime image pins, limits, and deployment | `Bulk-Platform/bulk-infra`         |
| Upstream Convex source                     | `convex/convex-backend`            |

The Bulk-only runtime knobs are:

- `LOCAL_BACKEND_MAX_CONCURRENT_REQUESTS` for the main self-hosted listener.
- `SITE_PROXY_MAX_CONCURRENT_REQUESTS` for the public HTTP-action proxy.
- `EXPORT_MALLOC_TRIM_ENABLED` to run glibc `malloc_trim(0)` on a blocking
  worker after each successful snapshot export. It defaults to `false` and
  should only be enabled after measuring trim duration and query tail latency.
- `ALLOCATOR_MALLOC_TRIM_INTERVAL_SECS` enables a self-hosted periodic cleanup
  timer. It defaults to zero (disabled); positive values below 60 are rejected.
  The timer waits a full interval before its first pass and after each pass.
  Both triggers share a nonblocking lock, so overlapping trims are skipped. Use
  a fixed-load canary before enabling this on another host.

The fork also carries the small self-hosted export-memory fix from upstream PR
#436 while upstream issue #435 remains open. It unregisters `_file_storage`
metadata after each component export and avoids reading a whole local-storage
object merely to determine its size. Keep this patch until upstream ships an
equivalent fix.

Bulk's glibc-based self-hosted image can retain free pages across repeated
exports even after the export buffers are dropped. The opt-in trim hook records
attempts, duration, and observed RSS reclaimed as
`snapshot_export_malloc_trim_total`, `snapshot_export_malloc_trim_seconds`, and
`snapshot_export_malloc_trim_reclaimed_bytes`. Do not combine it with
jemalloc-only `MALLOC_CONF` settings or an artificial glibc arena cap.

The shared hook additionally records `allocator_malloc_trim_total` and
`allocator_malloc_trim_seconds` labeled by `reason` (`export` or `periodic`).
Logs include glibc arena allocated/free bytes and directly mapped bytes before
and after cleanup. These are allocator statistics, not an exact accounting of
resident pages; thread caches are included in the allocated estimate. Existing
export metric names remain available. No database format changes are involved.

The implementations live in `crates/common/src/knobs.rs` and
`crates/local_backend/src/`. Production values belong in `bulk-infra`, not in
this repository.

### Function spec for large apps

`npx convex function-spec`, the MCP `functionSpec` tool and `npx convex run`'s
"available functions" list read `_system/cli/modules:apiSpec`, one query that
returns every function with its validators. Bulk's app has 33.6 MB of validator
JSON across 5,346 functions. Upstream's query parses all of it into values and
ran out of memory with up to 192 MiB of user heap, against the 64 MiB default.
More heap doesn't help: the single response is over the 24 MiB system result
limit, and two `workflow_engine` return validators are nested deeper than the 64
levels a Convex value allows.

The fork adds one query, `apiSpecPage`, to
`npm-packages/system-udfs/convex/_system/cli/modules.ts` (helpers in
`functionSpecPage.ts`), and leaves upstream's `apiSpec` unchanged:

- It returns the spec a page at a time, in module path order, about 4 MiB per
  page (`maxBytes`, at most 8 MiB). A page can end partway through a module, so
  one large module doesn't make a page too big. It takes `cursor` (the previous
  `continueCursor`, an opaque string) and returns
  `{ page, isDone, continueCursor }`.
- Each function entry carries `argsJson` and `returnsJson` as JSON strings
  instead of `args` and `returns` values. Bulk's spec comes back in 8 pages
  using about 17 MiB of V8 heap.
- `pathPrefix` limits the spec to modules whose path starts with it, read
  through the `by_path` index, so a narrow request reads only those modules. The
  MCP `functionSpec` tool uses it for `identifierPrefix`.

The `@bulk-platform/convex` CLI pages with `apiSpecPage` from 1.46.0-bulk.2 and
falls back to `apiSpec` when a backend doesn't have it. Older CLIs call
`apiSpec`, which runs out of memory on Bulk's app at any heap size.

Tests: `pnpm exec vitest run convex/_system/cli` in `npm-packages/system-udfs`
checks the entries against upstream's `apiSpec` encoding, paging and prefixes.
The end-to-end test deploys a generated 4,000-module app (122 MB of spec, more
than Bulk's per module) to a local backend built from this tree, with the
default heap, and reads it in full and under one folder. It fails on a build
without the patch:

```bash
cargo build -p local_backend --bin convex-local-backend
cd npm-packages/system-udfs
node scripts/api-spec-scale-test.mjs \
  --backend ../../target/debug/convex-local-backend --modules 4000
```

## The Bulk line

`main` is the Bulk line. It is upstream `convex/convex-backend` main (formerly
`get-convex/convex-backend`) merged in, plus the Bulk patches as ordinary
commits. Both products build from it:

| Product                             | Built by                                        | Released as                                     |
| ----------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Convex Runtime image                | `.github/workflows/bulk_release_backend.yml`    | `ghcr.io/bulk-platform/convex-backend@sha256:…` |
| `@bulk-platform/convex` npm package | `.github/workflows/bulk_release_convex_npm.yml` | `<upstream release>-bulk.<n>`                   |

Upstream comes in by merge, never by rebase or cherry-pick, so the Bulk patches
stay in history as they were written and an upstream change to a patched file
shows up as a merge conflict or in the sync pull request. Never force-push or
rebase `main`, and merge every pull request into it with a merge commit
(squashing a sync pull request would drop the upstream history the tooling
reads).

By default `main` takes upstream at its npm releases: the
`npm release version X.Y.Z` commit upstream adds to its own main for each
release. At that commit the npm package on `main` is exactly upstream X.Y.Z plus
the Bulk patches, and the runtime is the upstream tree that X.Y.Z shipped with.
Releases come about weekly. When the runtime needs an upstream fix sooner, merge
upstream main or a later upstream commit instead (see "Upstream sync"). `main`
then carries upstream npm-package changes that are in no upstream release yet,
and the npm release workflow refuses to publish until the next upstream release
is merged, unless the tag allows it (`npm-packages/convex/BULK.md`, "Release").

Before November 2026 the npm package lived on `bulk/convex-npm`, rebuilt from
each upstream release by cherry-picking the Bulk commits. That branch was merged
into `main` as it stood at `1.48.0-bulk.1` and takes no new work: retarget a
pull request open against it to `main`, where its diff stays the same.
`bulk/convex-npm-1.46.0` keeps the older line.

## Versions

- npm package: `<upstream release>-bulk.<n>`, for example `1.49.0-bulk.1`. The
  upstream release is the version in `npm-packages/convex/package.json`, the
  newest upstream release merged into `main`. Bulk never edits that version or
  `src/index.ts` (the CLI reports the upstream version to the backend), so
  release merges never conflict there. `<n>` starts at 1 for each upstream
  release and counts Bulk releases of it. The tag is `convex-npm/v<version>` on
  a commit on `main`.
- Runtime image: tagged with the `main` commit SHA and pinned by digest in
  `bulk-infra`. `node bulk/upstream.mjs status` at that commit names its
  upstream base, for example "npm release 1.49.0 + 1 upstream commits".

The two products release independently from the same line. A runtime release
needs no npm release, and the reverse.

## Patch policy

Keep Bulk-only changes narrow, tested, and separable from upstream code. Before
adding a patch, prefer an upstream contribution when it is generally useful.
Every retained patch must have:

- a clear production reason;
- a test or build check at the changed seam;
- an entry in `bulk/patches.txt` for every file it changes, and a description in
  this document (runtime) or `npm-packages/convex/BULK.md` (npm package);
- a compatible `bulk-infra` change when deployment settings must change.

### Patch inventory

`bulk/patches.txt` lists every path where `main` differs from the upstream
commit it last merged, grouped by patch. Upstream main is linear, so that commit
is `git merge-base HEAD upstream/main`, and the Bulk-only diff is the diff from
it to `HEAD`:

```bash
git fetch upstream
node bulk/upstream.mjs status      # merged upstream commit, release, how far behind
node bulk/upstream.mjs inventory   # the Bulk-only diff by patch, and the Bulk commits
```

`inventory --check` fails when a changed file is in no entry or an entry matches
no changed file. `.github/workflows/bulk_checks.yml` runs it on every pull
request to `main`, so the list stays true: a new patch adds its files, and a
patch upstream absorbs (or Bulk drops) removes them.

## Upstream sync

`.github/workflows/bulk_upstream_sync.yml` runs daily. When upstream has an npm
release that `main` hasn't merged, it:

1. merges the release commit into `main` on a branch
   `bulk/upstream-sync/v<X.Y.Z>`;
2. runs `bulk_checks.yml` on the merged tree: the patch inventory, the npm
   package's type check and build, `bulk-tests` (with the TypeScript 7 scale
   tests at 2,621 and 4,021 modules) and the system-udfs function spec tests;
3. pushes the branch and opens a pull request listing the upstream commits that
   change Bulk-patched files, the upstream npm-package changes, conflicts, the
   patch inventory after the merge, and the check result. A merge with conflicts
   or failing checks opens as a draft.

A branch that already exists is left alone, so a pull request with a resolved
merge is never overwritten; a newer upstream release gets its own branch and
pull request, and the older one can be closed. Run the workflow by hand with
`target: main` (upstream main) or an upstream main commit SHA to take upstream
off the release schedule, and with `dry_run: true` to see the pull request
without pushing.

Reviewing a sync pull request:

1. Read "Upstream commits that change Bulk-patched files" and check each patch
   still does what its description says.
2. For a runtime change, build a dev-slot image from the branch before merging
   (`gh workflow run bulk_release_backend.yml --ref bulk/upstream-sync/vX.Y.Z`)
   and run the minimum runtime validation below where practical.
3. Merge with a merge commit. Then release what needs releasing: tag the npm
   package (`npm-packages/convex/BULK.md`, "Release") and run the runtime image
   release on `main`.

When the merge conflicts, the branch holds the merge commit with conflict
markers so the pull request shows them. Redo the merge locally and force-push
the sync branch, so `main` never gets a commit with markers:

```bash
git fetch origin
git fetch upstream
git switch -C bulk/upstream-sync/vX.Y.Z origin/main
git merge --no-ff <upstream commit from the pull request>
# Resolve by keeping upstream's behaviour first, then replaying the Bulk patch.
git commit
node bulk/upstream.mjs inventory --check
git push --force-with-lease origin bulk/upstream-sync/vX.Y.Z
```

The same merge without the workflow, from a fresh branch:

```bash
git switch -c bulk/upstream-sync/vX.Y.Z origin/main
node bulk/upstream.mjs merge --target release --body /tmp/sync-pr.md
```

`--target` takes `release`, `main` or an upstream main commit. Without
`--commit-conflicts` a conflicting merge is aborted and only reported.

One-time repository setup for the workflow:

- Add the upstream remote locally once:
  `git remote add upstream https://github.com/convex/convex-backend.git`.
- Set the `BULK_UPSTREAM_SYNC_TOKEN` secret to a token with contents,
  pull-requests and workflows write on this repository (a fine-grained PAT or a
  GitHub App token). `GITHUB_TOKEN` cannot push a merge that changes
  `.github/workflows`, and pull requests it opens don't run their own checks.
  Without the secret, enable "Allow GitHub Actions to create and approve pull
  requests" under Settings → Actions; upstream merges that change workflows then
  fail with a pointer to the local procedure.
- Allow merge commits for pull requests to `main`.

Minimum local validation for runtime changes:

```bash
cargo fmt --all --check
cargo check -p local_backend
cargo test -p local_backend
```

If a full local test is impractical, explain that in the pull request and rely
on the Linux image build plus its published-binary smoke test before deployment.

## Build and publish

The upstream CLA confirmation and AWS-runner build jobs apply only to
`get-convex/convex-backend`. Bulk's fork validates its runtime through the
GitHub-hosted image release workflow, published binary smoke and isolated dev
canary. Formatting CI selects Node from `.nvmrc` as well.

Bulk's build toolchain and self-hosted Node action executor use the Node.js 24
version pinned in `.nvmrc` (currently 24.22.1, matching upstream since upstream
moved its monorepo to Node 24). The backend Dockerfile installs that exact
NodeSource version and copies the binary into the final runtime image. The
release smoke test checks the final image's Node version against `.nvmrc`,
exercises crypto, and verifies the fetch API before reporting an immutable
digest. When syncing, keep `.nvmrc` on Node 24 or later; take upstream's patch
version unless a Bulk canary has shown a regression.

For an isolated dev-slot test before merging, run the GitHub Actions workflow
from a `bulk/upstream-sync/*` or `codex/upgrade-convex-*` branch:

```bash
gh workflow run bulk_release_backend.yml \
  --repo Bulk-Platform/convex-backend \
  --ref bulk/upstream-sync/vX.Y.Z
```

The branch path still publishes only the commit SHA tag and immutable digest. It
does not update `latest` or any deployment. Pin that digest only on the selected
disposable dev slot.

After the fork pull request is merged to `main`, run the same workflow on
`main`:

```bash
gh workflow run bulk_release_backend.yml \
  --repo Bulk-Platform/convex-backend \
  --ref main
gh run list \
  --repo Bulk-Platform/convex-backend \
  --workflow bulk_release_backend.yml \
  --limit 1
```

The workflow builds Linux AMD64 and ARM64 natively on GitHub-hosted runners,
smoke-tests each published platform image, then pushes a multi-arch index as
`ghcr.io/bulk-platform/convex-backend:<commit-sha>` and prints its immutable
`image@sha256:...` reference in the summary. Pin that multi-arch digest
everywhere: production hosts resolve the AMD64 image and local development on
Apple Silicon resolves the ARM64 image from the same reference.

Do not deploy the commit tag or `latest`. Copy the immutable digest into a
separate `bulk-infra` pull request and follow `runbooks/convex-runtime-fork.md`
there.

## Deployment boundary

Running `./bulk` from `bulk_v3` deploys Convex application functions,
migrations, search initialization, and application version metadata. It does not
build or replace this runtime image.

A runtime release is complete only after:

1. the fork change is merged;
2. the release workflow publishes and smoke-tests an image;
3. `bulk-infra` pins the new digest and passes its image/concurrency guards;
4. the runtime is deployed through the documented canary sequence;
5. backend, site, sync, and application smoke checks pass.

## Rollback and database safety

Convex may apply internal database migrations while starting a newer runtime. Do
not assume that an older image can read a database after a forward upgrade.
Before a runtime upgrade, confirm a recent Convex backup and a tested restore
path.

If the new runtime is unhealthy, stop the rollout. Re-pin the previous known
good digest only when its database compatibility is understood. If it is not,
restore through the `bulk-infra` Convex restore runbook instead of repeatedly
restarting or downgrading the container.
