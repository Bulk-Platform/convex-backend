# Bulk Convex fork guidance

This repository is the source for Bulk Platform's production **Convex Runtime**.
Application functions, schemas, and migrations are not maintained here; they
live in `Bulk-Platform/bulk_v3/backend_v3`.

Before changing this repository, read [BULK_FORK.md](./BULK_FORK.md).

## Rules

- Keep the Bulk patch set small and easy to replay on upstream Convex.
- Use `get-convex/convex-backend` as the `upstream` remote. Never force-push
  `main`; upgrade on a branch and merge through a pull request.
- Put runtime behavior changes here, image pins and host settings in
  `Bulk-Platform/bulk-infra`, and Convex application code in
  `Bulk-Platform/bulk_v3`.
- Update `BULK_FORK.md` whenever the Bulk-only patch surface, build workflow,
  required environment variables, or upgrade procedure changes.
- Run Rust formatting and the narrowest relevant tests before opening a pull
  request.
- Publish production images only with
  `.github/workflows/bulk_release_backend.yml` after the change is on `main`.
- Deploy immutable image digests. Never point production at a floating tag.

Nested `AGENTS.md` files may add more specific rules for their directories.
