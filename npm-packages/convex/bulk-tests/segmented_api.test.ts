// Bulk fork: the segmented `api.d.ts` must type exactly like upstream's
// single `ApiFromModules` chunk. These tests compile a fixture project with
// both shapes and compare them with the TypeScript compiler.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apiCodegen } from "../src/cli/codegen_templates/api.js";
import { segmentedApiDeclarations } from "../src/cli/codegen_templates/segmented_api.js";
import { TYPE_ASSERTIONS } from "./probes.js";
import {
  apiDts,
  checkWithPackageTypeScript,
  monolithicApiDts,
  writeProject,
} from "./scale_fixture.js";

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
};
const modulePaths = Object.keys(fixtureModules);
const moduleFiles = Object.fromEntries(
  Object.entries(fixtureModules).map(([modulePath, lines]) => [
    `convex/${modulePath}`,
    `import { queryGeneric, internalMutationGeneric } from "convex/server";\nimport { v } from "convex/values";\n${lines.join("\n")}\n`,
  ]),
);

// The push analysis of the fixture: each module's functions and visibility.
const functions = Object.fromEntries(
  Object.entries(fixtureModules).map(([modulePath, lines]) => [
    modulePath.replace(/\.ts$/, ".js"),
    {
      functions: lines.flatMap((line) => {
        const match = /^export const (\w+) = (\w+)Generic/.exec(line);
        if (!match) return [];
        const internal = match[2].startsWith("internal");
        return [
          {
            name: match[1],
            udfType: internal ? "Mutation" : "Query",
            visibility: { kind: internal ? "internal" : "public" },
            args: null,
            returns: null,
          } as const,
        ];
      }),
    },
  ]),
);

// With the analysis, the top-level keys are upstream's. Without it, entries
// with no functions of a visibility stay on that object as `{}`.
const keyProbe = (withAnalysis: boolean) =>
  withAnalysis
    ? `export type ApiKeys = Expect<Equal<keyof typeof api, keyof typeof mono.api>>;
export type InternalKeys = Expect<Equal<keyof typeof internal, keyof typeof mono.internal>>;`
    : `export type ApiKeys = Expect<Equal<keyof typeof api, keyof typeof mono.api | "helpers" | "jobsInternal">>;
export type InternalKeys = Expect<Equal<keyof typeof internal, keyof typeof mono.internal | "helpers" | "crons">>;`;

const probe = (
  withAnalysis: boolean,
) => `import type * as mono from "./_generated/api_mono";
import { api, internal } from "./_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

${TYPE_ASSERTIONS}
type Seg<T, K extends PropertyKey> = K extends keyof T ? T[K] : {};

${keyProbe(withAnalysis)}
${["auth", "production", "helpers", "jobsInternal", "crons"]
  .map(
    (k) =>
      `export type P_${k} = Expect<Equal<Seg<typeof mono.api, "${k}">, Seg<typeof api, "${k}">>>;\nexport type I_${k} = Expect<Equal<Seg<typeof mono.internal, "${k}">, Seg<typeof internal, "${k}">>>;`,
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
    ["one chunk per top-level folder", undefined, true],
    ["nested folders split into their own chunks", 1, true],
    ["without an analysis, one chunk per top-level folder", undefined, false],
    ["without an analysis, nested folders split", 1, false],
  ])(
    "%s types like the monolithic api",
    (_name, maxModulesPerChunk, withAnalysis) => {
      const projectDir = writeProject(
        path.join(dir, `${maxModulesPerChunk ?? "default"}-${withAnalysis}`),
        {
          ...moduleFiles,
          "convex/_generated/api_mono.d.ts": monolithicApiDts(modulePaths),
          "convex/_generated/api.d.ts": apiDts(
            modulePaths,
            segmentedApiDeclarations(modulePaths, {
              useTypeScript: false,
              maxModulesPerChunk,
              functions: withAnalysis ? functions : undefined,
            }),
          ),
          "convex/probe.ts": probe(withAnalysis),
        },
      );
      expect(
        checkWithPackageTypeScript(projectDir, ["convex/probe.ts"]),
      ).toEqual([]);
    },
  );

  test("apiCodegen emits the segmented shape", () => {
    const { DTS } = apiCodegen(modulePaths);
    expect(DTS).not.toContain("declare const fullApi:");
    expect(DTS).toContain("export declare const api: {");
    expect(DTS).toContain('"production": ');
  });

  test("api.ts passes noUnusedLocals when a folder has no functions", () => {
    const { TS } = apiCodegen(modulePaths, { useTypeScript: true, functions });
    // `helpers` is on neither object, but its chunk is still declared.
    expect(TS).not.toMatch(/"helpers": /);
    const projectDir = writeProject(path.join(dir, "unused"), {
      ...moduleFiles,
      "convex/_generated/api.ts": TS!,
    });
    const diagnostics = checkWithPackageTypeScript(
      projectDir,
      ["convex/_generated/api.ts"],
      { noUnusedLocals: true },
    );
    // The fixture modules have unused imports of their own.
    expect(
      diagnostics.filter((d) => d.file.startsWith("convex/_generated/")),
    ).toEqual([]);
  });

  test("large folders are split by subfolder", () => {
    const decls = segmentedApiDeclarations(modulePaths, {
      useTypeScript: false,
      maxModulesPerChunk: 1,
    });
    const chunks = [
      ...decls.matchAll(/declare const (\S+): ApiFromModules<\{([^}]*)\}>/g),
    ];
    for (const [, , body] of chunks) {
      expect(body.match(/typeof/g)!.length).toBeLessThanOrEqual(1);
    }
    expect(chunks.length).toBe(modulePaths.length);
  });
});
