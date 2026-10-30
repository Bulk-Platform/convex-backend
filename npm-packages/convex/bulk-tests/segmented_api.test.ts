// Bulk fork: the segmented `api.d.ts` must type exactly like upstream's
// single `ApiFromModules` chunk. These tests compile a fixture project with
// both shapes and compare them with the TypeScript compiler.

import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apiCodegen } from "../src/cli/codegen_templates/api.js";
import { segmentedApiDeclarations } from "../src/cli/codegen_templates/segmented_api.js";

const packageRoot = path.resolve(__dirname, "..");

const query = (name: string) =>
  `export const ${name} = queryGeneric({ args: { id: v.string() }, handler: async (_ctx, args) => args.id.length });`;
const internalMutation = (name: string) =>
  `export const ${name} = internalMutationGeneric({ args: { n: v.number() }, handler: async () => null });`;

// A root module that is also a folder (`auth`), nested folders, a module that
// shares a name with a subfolder (`production/jobs`), a folder with no
// functions and one that only has internal functions.
const fixtureModules: Record<string, string[]> = {
  "auth.ts": [query("me"), internalMutation("touch")],
  "auth/session.ts": [query("current")],
  "production/jobs.ts": [query("get")],
  "production/jobs/list.ts": [query("run"), internalMutation("rebuild")],
  "production/orders.ts": [query("byId")],
  "production/orders/lines/edit.ts": [internalMutation("apply")],
  "helpers/format.ts": [`export const format = (s: string) => s.trim();`],
  "jobsInternal/worker.ts": [internalMutation("tick")],
  "crons.ts": [query("status")],
  "ApiSegment.ts": [query("collides")],
};

function monolithicDeclarations(modulePaths: string[]) {
  const entries = modulePaths
    .map((p) => `"${p.replace(/\.ts$/, "")}": typeof ${ident(p)};`)
    .join("\n");
  return `declare const fullApi: ApiFromModules<{\n${entries}\n}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;`;
}

function ident(modulePath: string) {
  return modulePath.replace(/\.ts$/, "").replace(/[/-]/g, "_");
}

function writeProject(dir: string, segmentedDts: string, probe: string) {
  const convexDir = path.join(dir, "convex");
  const modulePaths = Object.keys(fixtureModules);
  for (const [modulePath, lines] of Object.entries(fixtureModules)) {
    const file = path.join(convexDir, modulePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `import { queryGeneric, internalMutationGeneric } from "convex/server";\nimport { v } from "convex/values";\n${lines.join("\n")}\n`,
    );
  }
  const imports = modulePaths
    .map(
      (p) =>
        `import type * as ${ident(p)} from "../${p.replace(/\.ts$/, ".js")}";`,
    )
    .join("\n");
  const header = `import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";\n${imports}\n`;
  fs.mkdirSync(path.join(convexDir, "_generated"), { recursive: true });
  fs.writeFileSync(
    path.join(convexDir, "_generated/api_mono.d.ts"),
    `${header}\n${monolithicDeclarations(modulePaths)}\n`,
  );
  fs.writeFileSync(path.join(convexDir, "_generated/api.d.ts"), segmentedDts);
  fs.writeFileSync(path.join(convexDir, "probe.ts"), probe);
  return path.join(convexDir, "probe.ts");
}

function compile(entry: string) {
  const program = ts.createProgram([entry], {
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
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.endsWith("probe.ts"))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `probe.ts:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
}

const probe = `import type * as mono from "./_generated/api_mono";
import { api, internal } from "./_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Seg<T, K extends PropertyKey> = K extends keyof T ? T[K] : {};

export type ApiKeys = Expect<Equal<Exclude<keyof typeof mono.api, keyof typeof api>, never>>;
export type InternalKeys = Expect<Equal<Exclude<keyof typeof mono.internal, keyof typeof internal>, never>>;
${["auth", "production", "helpers", "jobsInternal", "crons", "ApiSegment"]
  .map(
    (k) =>
      `export type P_${k} = Expect<Equal<Seg<typeof mono.api, "${k}">, (typeof api)["${k}"]>>;\nexport type I_${k} = Expect<Equal<Seg<typeof mono.internal, "${k}">, (typeof internal)["${k}"]>>;`,
  )
  .join("\n")}

const run = api.production.jobs.list.run;
export type RunArgs = Expect<Equal<FunctionArgs<typeof run>, { id: string }>>;
export type RunReturns = Expect<Equal<FunctionReturnType<typeof run>, number>>;
export type RunNotAny = Expect<Equal<IsAny<typeof run>, false>>;
export const me = api.auth.me;
export const current = api.auth.session.current;
export const get = api.production.jobs.get;
export const rebuild = internal.production.jobs.list.rebuild;
export const apply = internal.production.orders.lines.edit.apply;
// @ts-expect-error internal functions are not on api
export const notPublic = api.production.jobs.list.rebuild;
// @ts-expect-error unknown function
export const unknown = api.production.orders.nope;
// @ts-expect-error wrong argument type
export const badArgs: FunctionArgs<typeof run> = { id: 1 };
`;

describe("segmented api codegen", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-segmented-api-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["one chunk per top-level folder", undefined],
    ["nested folders split into their own chunks", 1],
  ])("%s types like the monolithic api", (_name, maxModulesPerChunk) => {
    const modulePaths = Object.keys(fixtureModules);
    const imports = modulePaths
      .map(
        (p) =>
          `import type * as ${ident(p)} from "../${p.replace(/\.ts$/, ".js")}";`,
      )
      .join("\n");
    const dts = `import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";\n${imports}\n${segmentedApiDeclarations(
      modulePaths,
      { useTypeScript: false, maxModulesPerChunk },
    )}\n`;
    const entry = writeProject(
      path.join(dir, String(maxModulesPerChunk ?? "default")),
      dts,
      probe,
    );
    expect(compile(entry)).toEqual([]);
  });

  test("apiCodegen emits the segmented shape", () => {
    const { DTS } = apiCodegen(Object.keys(fixtureModules));
    expect(DTS).not.toContain("declare const fullApi:");
    expect(DTS).toContain("export declare const api: {");
    expect(DTS).toContain('"production": ');
    // The `ApiSegment` module keeps its name; the helper type moves aside.
    expect(DTS).toContain("type _ApiSegment<");
  });

  test("large folders are split by subfolder", () => {
    const decls = segmentedApiDeclarations(Object.keys(fixtureModules), {
      useTypeScript: false,
      maxModulesPerChunk: 1,
    });
    const chunks = [
      ...decls.matchAll(/declare const (\S+): ApiFromModules<\{([^}]*)\}>/g),
    ];
    for (const [, , body] of chunks) {
      expect(body.match(/typeof/g)!.length).toBeLessThanOrEqual(1);
    }
    expect(chunks.length).toBe(Object.keys(fixtureModules).length);
  });
});
