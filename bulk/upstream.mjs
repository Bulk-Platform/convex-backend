#!/usr/bin/env node
// Bulk fork: where the Bulk line (`main`) stands against upstream
// convex/convex-backend, the Bulk-only diff, and the upstream merge the sync
// workflow opens a pull request for. See BULK_FORK.md.
//
//   node bulk/upstream.mjs status [--check-release] [--allow-unreleased]
//   node bulk/upstream.mjs inventory [--check] [--markdown]
//   node bulk/upstream.mjs merge --target release|main|<upstream commit>
//       [--commit-conflicts | --require-clean] [--body <file>]
//
// Every command takes `--upstream <ref>` (default `upstream/main`), upstream's
// main branch as fetched. In GitHub Actions, `merge` also writes its results
// to $GITHUB_OUTPUT. Upstream main is linear, so the newest upstream
// commit the Bulk line has merged is `git merge-base HEAD <upstream>`, and the
// Bulk-only diff is the diff from that commit to HEAD.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const UPSTREAM_REPO = "convex/convex-backend";
const NPM_PACKAGE = "npm-packages/convex";
const RELEASE_GREP = "^npm release version [0-9]+\\.[0-9]+\\.[0-9]+";
const RELEASE_SUBJECT = /^npm release version (\d+\.\d+\.\d+)\b/;
const SYNC_BRANCH_PREFIX = "bulk/upstream-sync/";
const LIST_LIMIT = 60;
// Upstream bumps these all the time; a commit that changes only them is
// counted, not listed.
const LOCKFILES = new Set(["Cargo.lock", "npm-packages/pnpm-lock.yaml"]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "bulk", "patches.txt");

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (result.error) throw result.error;
  if (allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trimEnd();
}

const lines = (text) => text.split("\n").filter((line) => line !== "");
const short = (sha) => sha.slice(0, 9);
const rev = (ref) =>
  git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
const isAncestor = (a, b) =>
  git(["merge-base", "--is-ancestor", a, b], { allowFailure: true }).status ===
  0;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// The newest upstream npm release at or before `commit` on upstream main.
function releaseAt(commit) {
  const out = git([
    "log",
    "-1",
    "--first-parent",
    "-E",
    `--grep=${RELEASE_GREP}`,
    "--format=%H%x09%s",
    commit,
  ]);
  if (out === "") return null;
  const [sha, subject] = out.split("\t");
  return { sha, version: subject.match(RELEASE_SUBJECT)[1] };
}

function commitsIn(range, paths = []) {
  const args = ["log", "--format=%H%x09%s", range];
  if (paths.length > 0) args.push("--", ...paths);
  return lines(git(args)).map((line) => {
    const [sha, subject] = line.split("\t");
    return { sha, subject };
  });
}

function upstreamState(upstreamRef) {
  let upstream;
  try {
    upstream = rev(upstreamRef);
  } catch {
    fail(
      `cannot resolve ${upstreamRef}; fetch upstream first:\n` +
        `  git fetch https://github.com/${UPSTREAM_REPO}.git +refs/heads/main:refs/remotes/upstream/main`,
    );
  }
  const merged = git(["merge-base", "HEAD", upstream], {
    allowFailure: true,
  }).stdout.trim();
  if (merged === "") fail(`HEAD shares no history with ${upstreamRef}`);
  const mergedRelease = releaseAt(merged);
  const latestRelease = releaseAt(upstream);
  const packageVersion = JSON.parse(
    git(["show", `HEAD:${NPM_PACKAGE}/package.json`]),
  ).version;
  // Upstream commits to the npm package after the release it is labelled
  // with: a `<release>-bulk.<n>` package built from HEAD would include them.
  const unreleasedNpm = mergedRelease
    ? commitsIn(`${mergedRelease.sha}..${merged}`, [NPM_PACKAGE])
    : [];
  return {
    upstreamRef,
    upstream,
    merged,
    mergedSubject: git(["log", "-1", "--format=%s", merged]),
    mergedRelease,
    sinceRelease: mergedRelease
      ? Number(git(["rev-list", "--count", `${mergedRelease.sha}..${merged}`]))
      : null,
    behind: Number(git(["rev-list", "--count", `${merged}..${upstream}`])),
    latestRelease,
    packageVersion,
    unreleasedNpm,
  };
}

function describeBase(state) {
  const { mergedRelease, sinceRelease } = state;
  if (!mergedRelease) return "no upstream npm release";
  return sinceRelease === 0
    ? `npm release ${mergedRelease.version}`
    : `npm release ${mergedRelease.version} + ${sinceRelease} upstream commits`;
}

// --- Patch inventory -------------------------------------------------------

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

// bulk/patches.txt: `[Patch name] doc/where/it/is/described.md` starts an
// entry, and each following line is a path glob (`*` within a directory, `**`
// across directories). Lines starting with `#` are comments.
function readManifest() {
  const patches = [];
  let current = null;
  readFileSync(manifestPath, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      const header = line.match(/^\[(.+)\]\s*(\S*)$/);
      if (header) {
        current = { name: header[1], doc: header[2], globs: [] };
        patches.push(current);
      } else if (current === null) {
        fail(`bulk/patches.txt:${index + 1}: path before the first [patch]`);
      } else {
        current.globs.push({ glob: line, re: globToRegExp(line) });
      }
    });
  return patches;
}

function bulkDiff(merged) {
  return lines(
    git(["diff", "--no-renames", "--name-status", merged, "HEAD"]),
  ).map((line) => {
    const [status, path] = line.split("\t");
    return { status, path };
  });
}

function inventory(state) {
  const patches = readManifest().map((patch) => ({ ...patch, files: [] }));
  const files = bulkDiff(state.merged);
  const uncovered = [];
  for (const file of files) {
    let covered = false;
    for (const patch of patches) {
      if (patch.globs.some((g) => g.re.test(file.path))) {
        patch.files.push(file);
        covered = true;
      }
    }
    if (!covered) uncovered.push(file);
  }
  const stale = patches.flatMap((patch) =>
    patch.globs
      .filter((glob) => !files.some((f) => glob.re.test(f.path)))
      .map((glob) => ({ patch: patch.name, glob: glob.glob })),
  );
  return { patches, files, uncovered, stale };
}

function inventoryMarkdown(inv) {
  const out = [
    "| Patch | Described in | Files changed from upstream |",
    "| --- | --- | --- |",
  ];
  for (const patch of inv.patches) {
    const files = patch.files
      .map((f) => `\`${f.status} ${f.path}\``)
      .join("<br>");
    out.push(
      `| ${patch.name} | ${patch.doc ? `\`${patch.doc}\`` : ""} | ${files || "—"} |`,
    );
  }
  if (inv.uncovered.length > 0) {
    out.push("", "**Not in `bulk/patches.txt`:**", "");
    for (const f of inv.uncovered) out.push(`- \`${f.status} ${f.path}\``);
  }
  if (inv.stale.length > 0) {
    out.push(
      "",
      "**Entries in `bulk/patches.txt` that match no changed file:**",
      "",
    );
    for (const s of inv.stale) out.push(`- ${s.patch}: \`${s.glob}\``);
  }
  return out.join("\n");
}

function printInventoryProblems(inv) {
  for (const f of inv.uncovered) {
    console.error(`not in bulk/patches.txt: ${f.status} ${f.path}`);
  }
  for (const s of inv.stale) {
    console.error(
      `bulk/patches.txt [${s.patch}] ${s.glob} matches no file that differs from upstream`,
    );
  }
}

// --- Commands --------------------------------------------------------------

function printStatus(state) {
  const { mergedRelease, latestRelease } = state;
  console.log(
    `Upstream ref:      ${state.upstreamRef} ${short(state.upstream)}`,
  );
  console.log(
    `Merged upstream:   ${short(state.merged)} ${state.mergedSubject}`,
  );
  console.log(`Upstream base:     ${describeBase(state)}`);
  console.log(`npm package.json:  ${state.packageVersion}`);
  console.log(
    `Upstream ahead:    ${state.behind} commits` +
      (latestRelease && mergedRelease && latestRelease.sha !== mergedRelease.sha
        ? `, latest npm release ${latestRelease.version} (${short(latestRelease.sha)}) not merged`
        : ""),
  );
  if (state.unreleasedNpm.length > 0) {
    console.log(
      `\nUpstream npm-package commits after ${mergedRelease.version} (not in any upstream release yet):`,
    );
    for (const c of state.unreleasedNpm) {
      console.log(`  ${short(c.sha)} ${c.subject}`);
    }
  }
}

function statusCommand(values) {
  const state = upstreamState(values.upstream);
  printStatus(state);
  if (!values["check-release"]) return;
  const errors = [];
  if (!state.mergedRelease) {
    errors.push("HEAD has merged no upstream npm release");
  } else if (state.packageVersion !== state.mergedRelease.version) {
    errors.push(
      `${NPM_PACKAGE}/package.json is ${state.packageVersion}, but the newest merged upstream release is ${state.mergedRelease.version}`,
    );
  }
  if (state.unreleasedNpm.length > 0 && !values["allow-unreleased"]) {
    errors.push(
      `HEAD carries ${state.unreleasedNpm.length} upstream npm-package commits that are not in upstream ${state.mergedRelease.version}. ` +
        "Release after the next upstream release is merged, or tag with an " +
        "`Allow-Unreleased-Upstream: yes` line in the annotated tag message.",
    );
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`\nerror: ${e}`);
    process.exit(1);
  }
}

function inventoryCommand(values) {
  const state = upstreamState(values.upstream);
  const inv = inventory(state);
  if (values.markdown) {
    console.log(
      `Bulk-only diff against upstream ${short(state.merged)} (${describeBase(state)}): ${inv.files.length} files.\n`,
    );
    console.log(inventoryMarkdown(inv));
  } else {
    console.log(
      `Bulk-only diff against upstream ${short(state.merged)} (${describeBase(state)}), ${inv.files.length} files:`,
    );
    for (const patch of inv.patches) {
      console.log(`\n[${patch.name}] ${patch.doc}`);
      for (const f of patch.files) console.log(`  ${f.status} ${f.path}`);
      if (patch.files.length === 0) console.log("  (no changes)");
    }
    const commits = lines(
      git(["log", "--no-merges", "--format=%h %s", `${state.merged}..HEAD`]),
    );
    console.log(`\nBulk commits (${commits.length}, merges left out):`);
    for (const c of commits) console.log(`  ${c}`);
  }
  if (inv.uncovered.length > 0 || inv.stale.length > 0) {
    printInventoryProblems(inv);
    if (values.check) process.exit(1);
  }
}

function resolveTarget(spec, state) {
  if (spec === "release") {
    if (!state.latestRelease) fail(`${state.upstreamRef} has no npm release`);
    return {
      sha: state.latestRelease.sha,
      release: state.latestRelease.version,
    };
  }
  let sha = state.upstream;
  if (spec !== "main") {
    try {
      sha = rev(spec);
    } catch {
      fail(`cannot resolve ${spec}`);
    }
  }
  if (!isAncestor(sha, state.upstream)) {
    fail(
      `${spec} is not on ${state.upstreamRef}; only upstream main is merged`,
    );
  }
  const release = releaseAt(sha);
  return { sha, release: release?.sha === sha ? release.version : null };
}

function setOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(
    file,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}

function bulletList(commits, limit = LIST_LIMIT) {
  const out = commits
    .slice(0, limit)
    .map(
      (c) =>
        `- [\`${short(c.sha)}\`](https://github.com/${UPSTREAM_REPO}/commit/${c.sha}) ${c.subject}`,
    );
  if (commits.length > limit)
    out.push(`- … and ${commits.length - limit} more`);
  return out.length > 0 ? out.join("\n") : "None.";
}

function mergeCommand(values) {
  if (!values.target)
    fail("merge needs --target release|main|<upstream commit>");
  const state = upstreamState(values.upstream);
  const target = resolveTarget(values.target, state);
  const label = target.release ? `v${target.release}` : short(target.sha);
  const branch = `${SYNC_BRANCH_PREFIX}${label}`;
  const what = target.release
    ? `upstream npm release ${target.release}`
    : `upstream main at ${short(target.sha)}`;

  if (isAncestor(target.sha, "HEAD")) {
    console.log(
      `Up to date: HEAD already contains ${what} (${short(target.sha)}).`,
    );
    printStatus(state);
    setOutputs({ changed: "false" });
    return;
  }

  const range = `${state.merged}..${target.sha}`;
  const commits = commitsIn(range);
  const npmCommits = commitsIn(range, [NPM_PACKAGE]);
  const before = inventory(state);
  const bulkPaths = before.files.map((f) => f.path);
  // Upstream commits that change a file the Bulk line also changes: where
  // conflicts and silent behaviour changes to the patches come from.
  const touchingBulk =
    bulkPaths.length > 0
      ? commitsIn(range, bulkPaths).map((c) => ({
          ...c,
          files: lines(
            git([
              "diff-tree",
              "--no-commit-id",
              "--name-only",
              "-r",
              c.sha,
              "--",
              ...bulkPaths,
            ]),
          ),
        }))
      : [];
  const lockOnly = touchingBulk.filter((c) =>
    c.files.every((f) => LOCKFILES.has(f)),
  );
  const touchingPatches = touchingBulk.filter((c) => !lockOnly.includes(c));
  const title = `Merge ${what}`;
  const message = `${title} (${short(target.sha)})\n\nMerges ${commits.length} upstream commits from ${short(state.merged)} to ${target.sha}.`;

  const head = rev("HEAD");
  const merge = git(
    ["merge", "--no-ff", "--no-edit", "-m", message, target.sha],
    {
      allowFailure: true,
    },
  );
  let conflicts = [];
  if (merge.status !== 0) {
    conflicts = lines(git(["diff", "--name-only", "--diff-filter=U"]));
    if (conflicts.length === 0) {
      fail(`git merge failed:\n${merge.stdout}${merge.stderr}`);
    }
    if (values["commit-conflicts"]) {
      git(["add", "-A", "--", ...conflicts]);
      git([
        "commit",
        "--no-verify",
        "-m",
        `${message}\n\nCommitted with unresolved conflicts in:\n${conflicts.map((c) => `  ${c}`).join("\n")}`,
      ]);
    } else {
      git(["merge", "--abort"]);
    }
  }
  const merged = rev("HEAD") !== head;
  // GITHUB_TOKEN cannot push a commit that changes a workflow file.
  const touchesWorkflows =
    lines(
      git([
        "diff",
        "--name-only",
        state.merged,
        target.sha,
        "--",
        ".github/workflows",
      ]),
    ).length > 0;
  const after =
    merged && conflicts.length === 0
      ? inventory(upstreamState(values.upstream))
      : null;

  const compare = `https://github.com/${UPSTREAM_REPO}/compare/${state.merged}...${target.sha}`;
  const body = [
    `Merges ${what} ([\`${short(target.sha)}\`](https://github.com/${UPSTREAM_REPO}/commit/${target.sha})) into the Bulk line. Opened by \`.github/workflows/bulk_upstream_sync.yml\`; see BULK_FORK.md, "Upstream sync".`,
    "",
    "| | |",
    "| --- | --- |",
    `| Upstream merged before | \`${short(state.merged)}\` (${describeBase(state)}) |`,
    `| Merging | \`${short(target.sha)}\` (${target.release ? `npm release ${target.release}` : "upstream main, not an npm release"}) |`,
    `| Upstream commits | ${commits.length} ([compare](${compare})) |`,
    `| …that change \`${NPM_PACKAGE}\` | ${npmCommits.length} |`,
    `| …that change a Bulk-patched file | ${touchingPatches.length}${lockOnly.length > 0 ? ` (and ${lockOnly.length} that change only a lockfile)` : ""} |`,
    `| Changes \`.github/workflows\` | ${touchesWorkflows ? "yes" : "no"} |`,
    "",
    "### Conflicts",
    "",
    conflicts.length === 0
      ? "None."
      : [
          "This merge has conflicts, and the branch holds the merge commit with the conflict markers. Redo the merge locally and force-push this branch, so `main` never gets a commit with markers:",
          "",
          "```bash",
          `git fetch origin && git fetch https://github.com/${UPSTREAM_REPO}.git +refs/heads/main:refs/remotes/upstream/main`,
          `git switch -C ${branch} origin/main`,
          `git merge --no-ff ${target.sha}`,
          "# resolve, then: git commit && node bulk/upstream.mjs inventory --check",
          `git push --force-with-lease origin ${branch}`,
          "```",
          "",
          ...conflicts.map((c) => `- \`${c}\``),
          ...(conflicts.includes("Cargo.lock")
            ? [
                "",
                "For `Cargo.lock`, keep both sides' entries (Bulk's added dependencies and upstream's bumps), then check it with `cargo metadata --locked --format-version 1 > /dev/null`.",
              ]
            : []),
        ].join("\n"),
    "",
    "### Upstream commits that change Bulk-patched files",
    "",
    [
      ...touchingPatches.map(
        (c) =>
          `- [\`${short(c.sha)}\`](https://github.com/${UPSTREAM_REPO}/commit/${c.sha}) ${c.subject}: ${c.files.map((f) => `\`${f}\``).join(", ")}`,
      ),
      ...(lockOnly.length > 0
        ? [
            `- ${lockOnly.length} more change only ${[...new Set(lockOnly.flatMap((c) => c.files))].map((f) => `\`${f}\``).join(" and ")}: ${lockOnly.map((c) => `[\`${short(c.sha)}\`](https://github.com/${UPSTREAM_REPO}/commit/${c.sha})`).join(", ")}`,
          ]
        : []),
    ].join("\n") || "None.",
    "",
    `### Upstream commits that change \`${NPM_PACKAGE}\``,
    "",
    bulletList(npmCommits),
    "",
    "### Bulk patch inventory after the merge",
    "",
    after ? inventoryMarkdown(after) : "Not computed: the merge has conflicts.",
    "",
    "### After merging",
    "",
    target.release
      ? `- npm: tag the merge commit on \`main\` \`convex-npm/v${target.release}-bulk.1\` (\`npm-packages/convex/BULK.md\`, "Release"), then bump \`bulk_v3\`.`
      : "- npm: this is not an upstream release, so `main` now carries unreleased upstream npm changes. Release the npm package after the next upstream release is merged, or tag with `Allow-Unreleased-Upstream: yes`.",
    `- Runtime: before merging, \`gh workflow run bulk_release_backend.yml --ref ${branch}\` builds a commit-SHA image for a dev slot. After merging, run it on \`main\` and pin the digest in \`bulk-infra\`.`,
  ].join("\n");

  console.log(
    `${title}: ${commits.length} upstream commits, ${npmCommits.length} change the npm package, ${touchingPatches.length} change Bulk-patched files (${lockOnly.length} more only a lockfile).`,
  );
  if (conflicts.length > 0) {
    console.log(
      `Conflicts (${values["commit-conflicts"] ? "committed with markers" : "merge aborted"}):`,
    );
    for (const c of conflicts) console.log(`  ${c}`);
  }
  if (after && (after.uncovered.length > 0 || after.stale.length > 0)) {
    printInventoryProblems(after);
  }
  if (values.body) writeFileSync(values.body, `${body}\n`);
  setOutputs({
    changed: "true",
    conflicts: String(conflicts.length > 0),
    target: target.sha,
    label,
    branch,
    title,
    touches_workflows: String(touchesWorkflows),
  });
  if (conflicts.length > 0 && values["require-clean"]) {
    fail(`merging ${what} conflicts`);
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    upstream: { type: "string", default: "upstream/main" },
    target: { type: "string" },
    body: { type: "string" },
    check: { type: "boolean", default: false },
    markdown: { type: "boolean", default: false },
    "check-release": { type: "boolean", default: false },
    "allow-unreleased": { type: "boolean", default: false },
    "commit-conflicts": { type: "boolean", default: false },
    "require-clean": { type: "boolean", default: false },
  },
});

const commands = {
  status: statusCommand,
  inventory: inventoryCommand,
  merge: mergeCommand,
};
const command = commands[positionals[0]];
if (!command)
  fail(
    `usage: node bulk/upstream.mjs ${Object.keys(commands).join("|")} [options]`,
  );
command(values);
