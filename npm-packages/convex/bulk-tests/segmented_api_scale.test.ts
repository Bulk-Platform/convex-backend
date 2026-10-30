// Bulk fork: the segmented `api` stays strictly typed far past the module
// count where upstream's single `ApiFromModules` collapses to `never`.
//
// Projects are type-checked with TypeScript 7.0.2 and its default checker
// count, as in Bulk (see scale_fixture.ts). A monolithic control project
// proves each size is past the cliff, and an `any` control proves the probes
// catch a loose `api`.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apiCodegen } from "../src/cli/codegen_templates/api.js";
import {
  componentApiDTS,
  componentApiTSWithTypes,
} from "../src/cli/codegen_templates/component_api.js";
import { Context } from "../src/bundler/context.js";
import { nodeFs } from "../src/bundler/fs.js";
import {
  Diagnostic,
  ScaleModule,
  checkWithBulkTypeScript,
  checkWithPackageTypeScript,
  monolithicApiDts,
  moduleFiles,
  scaleModules,
  writeProject,
} from "./scale_fixture.js";
import {
  NEGATIVE_CASES,
  negativeCaseLines,
  negativeProbes,
  positiveProbes,
} from "./probes.js";

// `scaleModules(folders)` has `50 * folders + 621` modules.
const SIZES = [
  { modules: 2_621, folders: 40 },
  { modules: 4_021, folders: 68 },
];
const TIMEOUT = 300_000;

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "convex-segmented-scale-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function modulesOfSize(size: (typeof SIZES)[number]) {
  const modules = scaleModules(size.folders);
  expect(modules.length).toBe(size.modules);
  return modules;
}

function probeFiles(modules: ScaleModule[]) {
  return { ...positiveProbes(modules), ...negativeProbes() };
}

/** Diagnostics outside `probe_negative.ts`, which must be empty. */
function unexpected(diagnostics: Diagnostic[]) {
  return diagnostics
    .filter((d) => d.file !== "convex/probe_negative.ts")
    .map((d) => `${d.file}:${d.line} ${d.code} ${d.message.slice(0, 300)}`);
}

/** Each negative case fails exactly once, for its own reason. */
function expectNegativeCasesFail(diagnostics: Diagnostic[]) {
  const negative = diagnostics.filter(
    (d) => d.file === "convex/probe_negative.ts",
  );
  const lines = negativeCaseLines();
  const report = NEGATIVE_CASES.map((c, i) => {
    const found = negative.filter((d) => d.line === lines[i]);
    const ok =
      found.length === 1 &&
      found[0].code === c.expect &&
      found[0].message.includes(c.error);
    return { case: c.code, ok, found: found.map((d) => d.message) };
  });
  expect(report.filter((r) => !r.ok)).toEqual([]);
  expect(negative.length).toBe(NEGATIVE_CASES.length);
}

describe.each(SIZES)("$modules modules", (size) => {
  test(
    "upstream's monolithic api collapses to never (control)",
    () => {
      const modules = modulesOfSize(size);
      const dir = writeProject(path.join(tmp, `mono-${size.modules}`), {
        ...moduleFiles(modules),
        "convex/_generated/api.d.ts": monolithicApiDts(
          modules.map((m) => m.path),
        ),
        ...probeFiles(modules),
      });
      const diagnostics = checkWithBulkTypeScript(dir);
      expect(
        diagnostics.some((d) => d.message.includes("on type 'never'")),
      ).toBe(true);
    },
    TIMEOUT,
  );

  test.each([
    ["api.d.ts", false],
    ["api.ts", true],
  ] as const)(
    "segmented %s is strictly typed",
    (fileName, useTypeScript) => {
      const modules = modulesOfSize(size);
      const generated = apiCodegen(
        modules.map((m) => m.path),
        { useTypeScript },
      );
      const dir = writeProject(
        path.join(tmp, `seg-${fileName}-${size.modules}`),
        {
          ...moduleFiles(modules),
          [`convex/_generated/${fileName}`]: useTypeScript
            ? generated.TS!
            : generated.DTS!,
          ...probeFiles(modules),
        },
      );
      const diagnostics = checkWithBulkTypeScript(dir);
      expect(unexpected(diagnostics)).toEqual([]);
      expectNegativeCasesFail(diagnostics);
    },
    TIMEOUT,
  );
});

test(
  "probes reject an api typed as any (control)",
  () => {
    const modules = modulesOfSize(SIZES[0]);
    const dir = writeProject(path.join(tmp, "any"), {
      ...moduleFiles(modules),
      "convex/_generated/api.d.ts":
        "export declare const api: any;\nexport declare const internal: any;\n",
      ...probeFiles(modules),
    });
    const diagnostics = checkWithBulkTypeScript(dir);
    const codes = new Set(diagnostics.map((d) => d.code));
    // Unused `@ts-expect-error` guards and failed `Expect<...>` assertions.
    expect(codes).toContain("TS2578");
    expect(codes).toContain("TS2344");
    expect(
      diagnostics.filter((d) => d.file === "convex/probe_negative.ts"),
    ).toEqual([]);
  },
  TIMEOUT,
);

test(
  "segmented api types exactly like upstream at 2,621 modules (TypeScript 5)",
  () => {
    // TypeScript 5.0 still resolves upstream's single chunk at this size, so
    // the two shapes can be compared directly.
    const modules = modulesOfSize(SIZES[0]);
    const paths = modules.map((m) => m.path);
    const topLevel = [...new Set(paths.map((p) => p.split(/[/.]/)[0]))];
    const probe = `import type * as mono from "./_generated/api_mono";
import { api, internal } from "./_generated/api";
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type ApiKeys = Expect<Equal<keyof typeof mono.api | "ops", keyof typeof api>>;
export type InternalKeys = Expect<Equal<keyof typeof mono.internal, keyof typeof internal>>;
export type Ops = Expect<Equal<(typeof api)["ops"], {}>>;
${topLevel
  .map((k) =>
    [
      k === "ops"
        ? ""
        : `export type P_${k} = Expect<Equal<(typeof mono.api)["${k}"], (typeof api)["${k}"]>>;`,
      `export type I_${k} = Expect<Equal<(typeof mono.internal)["${k}"], (typeof internal)["${k}"]>>;`,
    ].join("\n"),
  )
  .join("\n")}
`;
    const dir = writeProject(path.join(tmp, "equal"), {
      ...moduleFiles(modules),
      "convex/_generated/api.d.ts": apiCodegen(paths).DTS!,
      "convex/_generated/api_mono.d.ts": monolithicApiDts(paths),
      "convex/probe_equal.ts": probe,
    });
    expect(checkWithPackageTypeScript(dir, ["convex/probe_equal.ts"])).toEqual(
      [],
    );
  },
  TIMEOUT,
);

describe("component api", () => {
  // A component with as many modules as the smaller project, generated by the
  // component codegen (`convex dev` with components) instead of `apiCodegen`.
  async function generateComponentApi(dir: string, useTypeScript: boolean) {
    const ctx = {
      fs: nodeFs,
      crash: async (args: { printedMessage: string | null }) => {
        throw new Error(args.printedMessage ?? "crash");
      },
    } as unknown as Context;
    const root = {
      isRoot: true,
      path: path.join(dir, "app"),
      definitionPath: path.join(dir, "app/convex.config.ts"),
      isRootWithoutConfig: false,
    };
    const component = {
      isRoot: false,
      path: path.join(dir, "convex"),
      definitionPath: path.join(dir, "convex/convex.config.ts"),
      isRootWithoutConfig: false,
    };
    const startPush = {
      analysis: {
        "../convex": { definition: { childComponents: [] }, functions: [] },
      },
    } as any;
    const opts = { staticApi: false, useComponentApiImports: true };
    return useTypeScript
      ? await componentApiTSWithTypes(
          ctx,
          startPush,
          root,
          component,
          new Map(),
          opts,
        )
      : await componentApiDTS(ctx, startPush, root, component, new Map(), opts);
  }

  test.each([
    ["api.d.ts", false],
    ["api.ts", true],
  ] as const)(
    "segmented component %s is strictly typed at 2,621 modules",
    async (fileName, useTypeScript) => {
      const modules = modulesOfSize(SIZES[0]);
      const dir = path.join(tmp, `component-${fileName}`);
      writeProject(dir, {
        ...moduleFiles(modules),
        "convex/convex.config.ts": `export default {};\n`,
      });
      const generated = await generateComponentApi(dir, useTypeScript);
      expect(generated).not.toContain("fullApi:");
      expect(generated).toMatch(/fullApi\$\d+: ApiFromModules/);
      writeProject(dir, {
        [`convex/_generated/${fileName}`]: generated,
        ...probeFiles(modules),
      });
      const diagnostics = checkWithBulkTypeScript(dir);
      expect(unexpected(diagnostics)).toEqual([]);
      expectNegativeCasesFail(diagnostics);
    },
    TIMEOUT,
  );
});
