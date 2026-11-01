// Bulk fork: synthetic Convex projects past the `ApiFromModules` cliff, and
// helpers that type-check them with the compilers Bulk uses.

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";
import {
  importPath,
  moduleIdentifier,
} from "../src/cli/codegen_templates/api.js";
import { AnalyzedModule } from "../src/cli/lib/deployApi/modules.js";
import { v } from "../src/values/index.js";

export const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The compiler Bulk type-checks with. TypeScript 6 and 7 collapse upstream's
 * single `ApiFromModules` to `never` near 1,950 modules; the package's own
 * TypeScript 5.0 does not, so scale tests run this one. `BULK_TSC` overrides
 * it with a local `tsc` binary.
 */
export const BULK_TYPESCRIPT = "typescript@7.0.2";

export type ModuleKind = "mixed" | "internalOnly";
export type ScaleModule = { path: string; kind: ModuleKind; index: number };

/**
 * `folders` top-level folders of 50 modules, plus:
 * - `big/`: 600 modules, past the 400-module chunk limit, in 20 subfolders
 *   that each have a nested `deep/` folder, with a root module `big.ts` and a
 *   `big/index.ts`;
 * - `ops/`: 20 modules with only internal functions;
 * - `crons.ts`: a top-level module.
 */
export function scaleModules(folders: number): ScaleModule[] {
  const modules: ScaleModule[] = [];
  const add = (p: string, kind: ModuleKind = "mixed") =>
    modules.push({ path: p, kind, index: modules.length });
  for (let f = 0; f < folders; f++) {
    for (let m = 0; m < 50; m++) {
      add(`f${f}/m${m}.ts`);
    }
  }
  add("big.ts");
  add("big/index.ts");
  for (let i = 0; i < 598; i++) {
    const sub = `s${i % 20}`;
    add(i % 3 === 0 ? `big/${sub}/deep/d${i}.ts` : `big/${sub}/m${i}.ts`);
  }
  for (let m = 0; m < 20; m++) {
    add(`ops/m${m}.ts`, "internalOnly");
  }
  add("crons.ts");
  return modules;
}

/**
 * A `mixed` module has a public query and mutation, an internal query and a
 * plain helper. Return types embed the module index, so a reference to the
 * wrong module does not type like the right one.
 */
export function scaleModuleSource({ kind, index }: ScaleModule) {
  const sweep = `export const sweep = internalQueryGeneric({
  args: { before: v.number() },
  handler: async () => ({ swept: ${index} as const }),
});`;
  if (kind === "internalOnly") {
    return `import { internalQueryGeneric } from "convex/server";
import { v } from "convex/values";
${sweep}
`;
  }
  return `import { queryGeneric, mutationGeneric, internalQueryGeneric } from "convex/server";
import { v } from "convex/values";
export const get = queryGeneric({
  args: { id: v.string(), limit: v.optional(v.number()) },
  handler: async (_ctx, args) => ({ module: ${index} as const, id: args.id }),
});
export const set = mutationGeneric({
  args: { id: v.string(), value: v.union(v.literal("a"), v.literal("b")) },
  handler: async (_ctx, args) => args.value === "a",
});
${sweep}
export const helper = (s: string) => s.trim();
`;
}

/**
 * The functions the backend reports for {@link scaleModuleSource}'s modules,
 * as static codegen (`codegen.staticApi`) reads them, with `returns`
 * validators matching what the handlers return.
 */
export function scaleModuleAnalysis(
  modules: ScaleModule[],
): Record<string, AnalyzedModule> {
  const fn = (
    name: string,
    udfType: "Query" | "Mutation",
    kind: "public" | "internal",
    args: { json: unknown },
    returns: { json: unknown },
  ) => ({
    name,
    pos: null,
    udfType,
    visibility: { kind },
    args: JSON.stringify(args.json),
    returns: JSON.stringify(returns.json),
  });
  return Object.fromEntries(
    modules.map(({ path: modulePath, kind, index }) => {
      const functions = [];
      if (kind === "mixed") {
        functions.push(
          fn(
            "get",
            "Query",
            "public",
            v.object({ id: v.string(), limit: v.optional(v.number()) }),
            v.object({ module: v.literal(index), id: v.string() }),
          ),
          fn(
            "set",
            "Mutation",
            "public",
            v.object({
              id: v.string(),
              value: v.union(v.literal("a"), v.literal("b")),
            }),
            v.boolean(),
          ),
        );
      }
      functions.push(
        fn(
          "sweep",
          "Query",
          "internal",
          v.object({ before: v.number() }),
          v.object({ swept: v.literal(index) }),
        ),
      );
      return [
        modulePath.replace(/\.ts$/, ".js"),
        { functions, httpRoutes: null, cronSpecs: null, sourceMapped: null },
      ];
    }),
  );
}

/** An `api.d.ts` with upstream's imports for `modulePaths` around `declarations`. */
export function apiDts(modulePaths: string[], declarations: string) {
  const imports = modulePaths.map(
    (p) =>
      `import type * as ${moduleIdentifier(p)} from "../${importPath(p)}.js";`,
  );
  return `import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
${imports.join("\n")}
${declarations}
`;
}

/** Upstream `convex@1.46.0`'s api.d.ts: one `ApiFromModules` over every module. */
export function monolithicApiDts(modulePaths: string[]) {
  const entries = modulePaths.map(
    (p) => `  "${importPath(p)}": typeof ${moduleIdentifier(p)},`,
  );
  return apiDts(
    modulePaths,
    `declare const fullApi: ApiFromModules<{
${entries.join("\n")}
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;`,
  );
}

/** Module sources keyed by their path under `convex/`. */
export function moduleFiles(modules: ScaleModule[]): Record<string, string> {
  return Object.fromEntries(
    modules.map((m) => [`convex/${m.path}`, scaleModuleSource(m)]),
  );
}

/**
 * Write `files` (relative to `dir`) and a strict `tsconfig.json` that resolves
 * `convex/*` to this package's sources. Returns the project directory.
 */
export function writeProject(dir: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          types: [],
          paths: {
            "convex/server": [path.join(packageRoot, "src/server/index.ts")],
            "convex/values": [path.join(packageRoot, "src/values/index.ts")],
          },
        },
        include: ["convex/**/*.ts"],
      },
      null,
      2,
    ),
  );
  return dir;
}

// tsc prints this package's sources as relative paths that end like this.
const packageSources = path.join(path.basename(packageRoot), "src") + path.sep;

export type Diagnostic = {
  file: string;
  line: number;
  code: string;
  message: string;
};

/**
 * Type-check a project with {@link BULK_TYPESCRIPT} and its default checker
 * count. Returns diagnostics in `convex/` only: this package's own sources are
 * compiled too and are not what is under test.
 */
export function checkWithBulkTypeScript(projectDir: string): Diagnostic[] {
  const [command, ...args] = process.env.BULK_TSC
    ? [process.env.BULK_TSC]
    : ["npx", "--yes", `--package=${BULK_TYPESCRIPT}`, "--", "tsc"];
  const result = spawnSync(
    command,
    [...args, "-p", "tsconfig.json", "--pretty", "false"],
    { cwd: projectDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  // tsc exits non-zero when it reports errors; anything else is a crash.
  if (result.status !== 0 && !result.stdout.includes("error TS")) {
    throw new Error(
      `tsc exited with ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  const diagnostics: Diagnostic[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.includes("error TS")) {
      continue;
    }
    const match = /^(convex\/[^(]+)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(
      line,
    );
    if (match) {
      diagnostics.push({
        file: match[1],
        line: Number(match[2]),
        code: match[3],
        message: match[4],
      });
    } else if (!line.includes(packageSources)) {
      throw new Error(`Unexpected tsc output: ${line}`);
    }
  }
  return diagnostics;
}

/**
 * Type-check `entries` in-process with the package's TypeScript and return
 * the diagnostics in `convex/` files.
 */
export function checkWithPackageTypeScript(
  projectDir: string,
  entries: string[],
  options: ts.CompilerOptions = {},
): Diagnostic[] {
  const program = ts.createProgram(
    entries.map((entry) => path.join(projectDir, entry)),
    {
      ...options,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: packageRoot,
      paths: {
        "convex/server": ["src/server/index.ts"],
        "convex/values": ["src/values/index.ts"],
      },
    },
  );
  const convexDir = path.join(projectDir, "convex") + path.sep;
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(convexDir))
    .map((d) => ({
      file: path.relative(projectDir, d.file!.fileName),
      line: d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    }));
}
