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

const probe = `import type * as mono from "./_generated/api_mono";
import { api, internal } from "./_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

${TYPE_ASSERTIONS}
type Seg<T, K extends PropertyKey> = K extends keyof T ? T[K] : {};

// Top-level entries without matching functions stay as \`{}\` (see BULK.md).
export type ApiKeys = Expect<Equal<keyof typeof api, keyof typeof mono.api | "helpers" | "jobsInternal">>;
export type InternalKeys = Expect<Equal<keyof typeof internal, keyof typeof mono.internal | "helpers" | "crons">>;
${["auth", "production", "helpers", "jobsInternal", "crons"]
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
    const projectDir = writeProject(
      path.join(dir, String(maxModulesPerChunk ?? "default")),
      {
        ...Object.fromEntries(
          Object.entries(fixtureModules).map(([modulePath, lines]) => [
            `convex/${modulePath}`,
            `import { queryGeneric, internalMutationGeneric } from "convex/server";\nimport { v } from "convex/values";\n${lines.join("\n")}\n`,
          ]),
        ),
        "convex/_generated/api_mono.d.ts": monolithicApiDts(modulePaths),
        "convex/_generated/api.d.ts": apiDts(
          modulePaths,
          segmentedApiDeclarations(modulePaths, {
            useTypeScript: false,
            maxModulesPerChunk,
          }),
        ),
        "convex/probe.ts": probe,
      },
    );
    expect(checkWithPackageTypeScript(projectDir, ["convex/probe.ts"])).toEqual(
      [],
    );
  });

  test("apiCodegen emits the segmented shape", () => {
    const { DTS } = apiCodegen(modulePaths);
    expect(DTS).not.toContain("declare const fullApi:");
    expect(DTS).toContain("export declare const api: {");
    expect(DTS).toContain('"production": ');
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
