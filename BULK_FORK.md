# Bulk Platform Convex Runtime fork

## Purpose

Bulk self-hosts Convex and uses this fork for the production backend runtime.
The fork exists so high-capacity installations can tune the two self-hosted HTTP
listeners independently while keeping the rest of Convex close to upstream.

| Concern                                    | Source of truth                    |
| ------------------------------------------ | ---------------------------------- |
| Convex Runtime Rust source                 | This repository                    |
| Convex application functions and schema    | `Bulk-Platform/bulk_v3/backend_v3` |
| Runtime image pins, limits, and deployment | `Bulk-Platform/bulk-infra`         |
| Upstream Convex source                     | `get-convex/convex-backend`        |

The Bulk-only runtime knobs are:

- `LOCAL_BACKEND_MAX_CONCURRENT_REQUESTS` for the main self-hosted listener.
- `SITE_PROXY_MAX_CONCURRENT_REQUESTS` for the public HTTP-action proxy.

The implementations live in `crates/common/src/knobs.rs` and
`crates/local_backend/src/`. Production values belong in `bulk-infra`, not in
this repository.

## Patch policy

Keep Bulk-only changes narrow, tested, and separable from upstream code. Before
adding a patch, prefer an upstream contribution when it is generally useful.
Every retained patch must have:

- a clear production reason;
- a test or build check at the changed seam;
- an entry in this document when it changes the supported runtime contract;
- a compatible `bulk-infra` change when deployment settings must change.

## Sync with upstream

Add the upstream remote once:

```bash
git remote add upstream https://github.com/get-convex/convex-backend.git
git fetch origin --prune
git fetch upstream --prune
```

Prepare an upgrade without rewriting shared history:

```bash
git switch -c codex/upgrade-convex-YYYYMMDD origin/main
git rebase upstream/main
git log --oneline upstream/main..HEAD
git diff --stat upstream/main...HEAD
```

Resolve conflicts by preserving current upstream behavior first, then replaying
the small Bulk patch set. Do not force-push `main`. Open a pull request and make
the upstream commit or release being adopted clear in its description.

Minimum local validation for runtime changes:

```bash
cargo fmt --all --check
cargo check -p local_backend
cargo test -p local_backend
```

If a full local test is impractical, explain that in the pull request and rely
on the Linux image build plus its published-binary smoke test before deployment.

## Build and publish

After the fork pull request is merged to `main`, run the GitHub Actions workflow
`Release Bulk Convex Backend`:

```bash
gh workflow run bulk_release_backend.yml \
  --repo Bulk-Platform/convex-backend \
  --ref main
gh run list \
  --repo Bulk-Platform/convex-backend \
  --workflow bulk_release_backend.yml \
  --limit 1
```

The workflow builds Linux AMD64, pushes
`ghcr.io/bulk-platform/convex-backend:<commit-sha>`, smoke-tests the published
binary, and prints the immutable `image@sha256:...` reference in its summary.

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
