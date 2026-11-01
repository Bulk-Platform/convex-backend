# Bulk Convex fork guidance

This repository is the source for Bulk Platform's production **Convex Runtime**
and the `@bulk-platform/convex` npm package, both built from `main`. Application
functions, schemas, and migrations are not maintained here; they live in
`Bulk-Platform/bulk_v3/backend_v3`.

Before changing this repository, read [BULK_FORK.md](./BULK_FORK.md).

## Rules

- Keep the Bulk patch set small and easy to replay on upstream Convex.
- Use `convex/convex-backend` as the `upstream` remote. Never force-push or
  rebase `main`; take upstream by merging it on a branch (the
  `bulk_upstream_sync.yml` pull request, or `node bulk/upstream.mjs merge`) and
  merge pull requests with a merge commit.
- List every file a patch changes in `bulk/patches.txt`;
  `node bulk/upstream.mjs inventory --check` must pass.
- Put runtime behavior changes here, image pins and host settings in
  `Bulk-Platform/bulk-infra`, and Convex application code in
  `Bulk-Platform/bulk_v3`.
- Update `BULK_FORK.md` (runtime) or `npm-packages/convex/BULK.md` (npm package)
  whenever the Bulk-only patch surface, build workflow, required environment
  variables, or upgrade procedure changes.
- Run Rust formatting and the narrowest relevant tests before opening a pull
  request.
- Publish production images only with
  `.github/workflows/bulk_release_backend.yml` after the change is on `main`. A
  `bulk/upstream-sync/*` or `codex/upgrade-convex-*` branch may use the same
  manual workflow to publish a commit-SHA-only image for an isolated dev-slot
  test. It must not update a floating tag or any production image pin.
- Deploy immutable image digests. Never point production at a floating tag.

Nested `AGENTS.md` files may add more specific rules for their directories.
