#!/usr/bin/env node
// Bulk: end-to-end scale test for `_system/cli/modules:apiSpec` and
// `apiSpecPage`, the queries behind `npx convex function-spec` and the MCP
// `functionSpec` tool.
//
// Generates a project with `--modules` function files (default 4,000) whose
// validators are sized like Bulk's app (most small, a tail of very large ones,
// one deeper than a Convex value may nest), deploys it to a fresh local backend
// started from `--backend`, then checks that:
//
// - `apiSpecPage` returns the whole spec, page by page, under the default
//   64 MiB isolate heap, and that it equals the spec the generator expects;
// - `apiSpec` does not run out of memory. A spec this size is too large for one
//   response, so it fails early with an error that points to `apiSpecPage`.
//
// Usage (from npm-packages/system-udfs, after `cargo build -p local_backend`):
//   node scripts/api-spec-scale-test.mjs \
//     --backend ../../target/debug/convex-local-backend [--modules 4000] [--keep]
//
// The backend runs with Bulk's hosted UDF timeouts (10 s user, 60 s system) and
// no heap override; pass `--env KEY=VALUE` to change a knob.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const convexPackage = path.resolve(here, "../../convex");

const options = { modules: 4000, keep: false, backend: null, env: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--backend") options.backend = path.resolve(argv[++i]);
  else if (arg === "--modules") options.modules = Number(argv[++i]);
  else if (arg === "--keep") options.keep = true;
  else if (arg === "--env") options.env.push(argv[++i]);
  else throw new Error(`Unknown argument ${arg}`);
}
if (!options.backend) {
  throw new Error("--backend <path to convex-local-backend> is required");
}

const FUNCTIONS_PER_MODULE = 3;
const HTTP_ROUTES = 3;

// Validator sizes by module index, calibrated on Bulk's app: 1,954 modules,
// 34 MB of validator JSON, median 0.7 KB, p99 128 KB and max 1.6 MB per
// function. Large validators are unions of 40-field objects, since a Convex
// object has at most 1,024 fields.
function returnVariants(i) {
  if (i % 1000 === 1) return 500;
  if (i % 50 === 0) return 80;
  if (i % 4 === 0) return 8;
  return 1;
}

function generateProject(dir, modules) {
  const convexDir = path.join(dir, "convex");
  fs.mkdirSync(path.join(convexDir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "api-spec-scale",
      private: true,
      type: "module",
      dependencies: { convex: "*" },
    }),
  );
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.symlinkSync(convexPackage, path.join(dir, "node_modules", "convex"));
  fs.writeFileSync(
    path.join(convexDir, "lib", "shapes.ts"),
    `import { v } from "convex/values";

const kinds = [
  v.string(),
  v.number(),
  v.boolean(),
  v.int64(),
  v.null(),
  v.array(v.string()),
  v.union(v.literal("open"), v.literal("closed")),
  v.optional(v.string()),
];

export function wide(fields: number, seed: number) {
  const shape: Record<string, (typeof kinds)[number]> = {};
  for (let i = 0; i < fields; i++) {
    shape[\`field_\${seed}_\${i}\`] = kinds[(i + seed) % kinds.length];
  }
  return v.object(shape);
}

export function shape(variants: number, seed: number) {
  if (variants === 1) {
    return wide(30, seed);
  }
  const members = [];
  for (let k = 0; k < variants; k++) {
    members.push(wide(40, seed * 1000 + k));
  }
  return v.union(...members);
}

// Each level adds three levels of validator JSON.
export function deep(levels: number) {
  let shape = v.object({ leaf: v.string() });
  for (let i = 0; i < levels; i++) {
    shape = v.object({ child: shape, label: v.string() });
  }
  return shape;
}
`,
  );
  for (let i = 0; i < modules; i++) {
    const folder = path.join(convexDir, `f${String(i % 40).padStart(2, "0")}`);
    fs.mkdirSync(folder, { recursive: true });
    const deepReturn = i === 7 ? "deep(25)" : "v.null()";
    fs.writeFileSync(
      path.join(folder, `mod_${i}.ts`),
      `import { queryGeneric, mutationGeneric, internalQueryGeneric } from "convex/server";
import { v } from "convex/values";
import { wide, shape, deep } from "../lib/shapes";

export const get = queryGeneric({
  args: { id: v.string(), cursor: v.optional(v.string()), filter: wide(12, ${i}) },
  returns: v.array(shape(${returnVariants(i)}, ${i})),
  handler: async () => [],
});

export const set = mutationGeneric({
  args: { value: shape(${Math.ceil(returnVariants(i) / 2)}, ${i + 1}) },
  returns: ${deepReturn},
  handler: async () => null as any,
});

export const internalGet = internalQueryGeneric({
  args: {},
  returns: v.union(v.null(), wide(20, ${i + 2})),
  handler: async () => null,
});
`,
    );
  }
  fs.writeFileSync(
    path.join(convexDir, "http.ts"),
    `import { httpRouter, httpActionGeneric } from "convex/server";

const http = httpRouter();
const ok = httpActionGeneric(async () => new Response("ok"));
${Array.from({ length: HTTP_ROUTES }, (_, i) => `http.route({ path: "/route${i}", method: "POST", handler: ok });`).join("\n")}
export default http;
`,
  );
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitFor(url, child, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if (child.exitCode !== null) throw new Error("backend exited");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not start within ${seconds}s`);
}

function deploy(args, cwd) {
  try {
    execFileSync(process.execPath, args, {
      cwd,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    // The error message would repeat the command line and its admin key.
    throw new Error("npx convex deploy failed");
  }
}

async function query(url, adminKey, functionPath, args) {
  const response = await fetch(`${url}/api/query`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: functionPath, args, format: "json" }),
  });
  const text = await response.text();
  const body = JSON.parse(text);
  if (body.status !== "success") {
    throw new Error(
      body.errorMessage.replace(/\[Request ID: \w+\] /, "").replace(/\n/g, " "),
    );
  }
  return { value: body.value, bytes: text.length };
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "api-spec-scale-"));
  const project = path.join(work, "project");
  const data = path.join(work, "backend");
  fs.mkdirSync(project);
  fs.mkdirSync(data);
  let backend = null;
  const results = {};
  try {
    generateProject(project, options.modules);

    const port = await freePort();
    const sitePort = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const instanceName = "api-spec-scale";
    const instanceSecret = randomBytes(32).toString("hex");
    const adminKey = execFileSync(options.backend, [
      "keygen",
      "admin-key",
      "--instance-name",
      instanceName,
      "--instance-secret",
      instanceSecret,
    ])
      .toString()
      .trim();
    const env = {
      ...process.env,
      DISABLE_BEACON: "1",
      DATABASE_UDF_USER_TIMEOUT_SECONDS: "10",
      DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS: "60",
    };
    for (const pair of options.env) {
      const [key, ...value] = pair.split("=");
      env[key] = value.join("=");
    }
    const log = fs.openSync(path.join(work, "backend.log"), "w");
    backend = spawn(
      options.backend,
      [
        path.join(data, "db.sqlite3"),
        "--port",
        String(port),
        "--site-proxy-port",
        String(sitePort),
        "--local-storage",
        path.join(data, "storage"),
        "--instance-name",
        instanceName,
        "--instance-secret",
        instanceSecret,
      ],
      { env, stdio: ["ignore", log, log] },
    );
    await waitFor(`${url}/version`, backend, 120);

    const deployStart = Date.now();
    deploy(
      [
        path.join(convexPackage, "bin", "main.js"),
        "deploy",
        "--url",
        url,
        "--admin-key",
        adminKey,
        "--codegen",
        "disable",
        "--typecheck",
        "disable",
        "-y",
      ],
      project,
    );
    results.deploySeconds = (Date.now() - deployStart) / 1000;

    const legacyStart = Date.now();
    try {
      const { value, bytes } = await query(
        url,
        adminKey,
        "_system/cli/modules:apiSpec",
        {},
      );
      results.apiSpec = { ok: true, entries: value.length, bytes };
    } catch (e) {
      results.apiSpec = { ok: false, error: e.message };
    }
    results.apiSpec.seconds = (Date.now() - legacyStart) / 1000;

    const pagedStart = Date.now();
    try {
      const entries = [];
      let cursor = null;
      let pages = 0;
      let bytes = 0;
      let maxPageBytes = 0;
      for (;;) {
        const page = await query(
          url,
          adminKey,
          "_system/cli/modules:apiSpecPage",
          { cursor },
        );
        pages++;
        bytes += page.bytes;
        maxPageBytes = Math.max(maxPageBytes, page.bytes);
        entries.push(...page.value.page);
        if (page.value.isDone) break;
        cursor = page.value.continueCursor;
      }
      results.apiSpecPage = { ok: true, pages, bytes, maxPageBytes };
      results.apiSpecPage.seconds = (Date.now() - pagedStart) / 1000;
      results.apiSpecPage.problems = checkSpec(entries, options.modules);
      results.apiSpecPage.ok = results.apiSpecPage.problems.length === 0;
    } catch (e) {
      results.apiSpecPage = {
        ok: false,
        error: e.message,
        seconds: (Date.now() - pagedStart) / 1000,
      };
    }
  } finally {
    if (backend && backend.exitCode === null) {
      backend.kill();
    }
    if (options.keep) {
      console.error(`Kept ${work}`);
    } else {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  console.log(
    JSON.stringify({ modules: options.modules, ...results }, null, 2),
  );
  const legacyOutOfMemory = /out of memory/.test(results.apiSpec?.error ?? "");
  if (!results.apiSpecPage?.ok || legacyOutOfMemory) {
    console.error(
      "FAIL: " +
        (results.apiSpecPage?.ok
          ? "apiSpec ran out of memory"
          : "apiSpecPage did not return the expected spec"),
    );
    process.exit(1);
  }
  console.error("PASS");
}

// The spec the generator wrote, checked without materializing validators the
// test did not generate: identifiers, types, visibility and field counts.
function checkSpec(entries, modules) {
  const problems = [];
  const expected = modules * FUNCTIONS_PER_MODULE + HTTP_ROUTES;
  if (entries.length !== expected) {
    problems.push(`expected ${expected} entries, got ${entries.length}`);
  }
  const byId = new Map();
  for (const entry of entries) {
    if (entry.identifier !== undefined) byId.set(entry.identifier, entry);
  }
  for (let i = 0; i < modules && problems.length < 5; i++) {
    const modulePath = `f${String(i % 40).padStart(2, "0")}/mod_${i}.js`;
    const get = byId.get(`${modulePath}:get`);
    const internalGet = byId.get(`${modulePath}:internalGet`);
    if (!get || !internalGet || !byId.has(`${modulePath}:set`)) {
      problems.push(`missing functions of ${modulePath}`);
      continue;
    }
    const item = JSON.parse(get.returnsJson).value;
    const variants = item.type === "union" ? item.value.length : 1;
    if (
      get.functionType !== "Query" ||
      get.visibility.kind !== "public" ||
      internalGet.visibility.kind !== "internal" ||
      variants !== returnVariants(i)
    ) {
      problems.push(`unexpected spec for ${modulePath}`);
    }
  }
  const routes = entries.filter((e) => e.functionType === "HttpAction");
  if (routes.length !== HTTP_ROUTES) {
    problems.push(`expected ${HTTP_ROUTES} http routes, got ${routes.length}`);
  }
  return problems;
}

await main();
