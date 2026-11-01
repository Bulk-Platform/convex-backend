// Bulk fork: the segmented `api` stays strictly typed far past the module
// count where upstream's single `ApiFromModules` collapses to `never`, in
// every file codegen writes it to: `api.d.ts`, `api.ts` and the CommonJS
// `api_cjs.d.cts`. Static codegen (`codegen.staticApi`) writes explicit
// `FunctionReference` types instead and has no cliff; it is checked at the
// same sizes so that turning it on stays safe.
//
// Projects are type-checked with TypeScript 7.0.2 and its default checker
// count, as in Bulk (see scale_fixture.ts). Monolithic control projects prove
// each size is past the cliff for both upstream file names, and an `any`
// control proves the probes catch a loose `api`.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apiCodegen } from "../src/cli/codegen_templates/api.js";
import { apiCjsCodegen } from "../src/cli/codegen_templates/api_cjs.js";
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
  scaleModuleAnalysis,
  scaleModules,
  writeProject,
} from "./scale_fixture.js";
import {
  NEGATIVE_CASES,
  ProbeOptions,
  TYPE_ASSERTIONS,
  negativeCaseError,
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

function probeFiles(modules: ScaleModule[], options: ProbeOptions = {}) {
  return {
    ...positiveProbes(modules, options),
    ...negativeProbes(options),
  };
}

// Where probes import a generated file from: `api_cjs.d.cts` types the
// `api_cjs.cjs` that CommonJS code requires.
const CJS = { apiModule: "./_generated/api_cjs.cjs" };

/** Diagnostics outside `probe_negative.ts`, which must be empty. */
function unexpected(diagnostics: Diagnostic[]) {
  return diagnostics
    .filter((d) => d.file !== "convex/probe_negative.ts")
    .map((d) => `${d.file}:${d.line} ${d.code} ${d.message.slice(0, 300)}`);
}

/** Each negative case fails exactly once, for its own reason. */
function expectNegativeCasesFail(
  diagnostics: Diagnostic[],
  options: ProbeOptions = {},
) {
  const negative = diagnostics.filter(
    (d) => d.file === "convex/probe_negative.ts",
  );
  const lines = negativeCaseLines();
  const report = NEGATIVE_CASES.map((c, i) => {
    const found = negative.filter((d) => d.line === lines[i]);
    const ok =
      found.length === 1 &&
      found[0].code === c.expect &&
      found[0].message.includes(negativeCaseError(c, options));
    return { case: c.code, ok, found: found.map((d) => d.message) };
  });
  expect(report.filter((r) => !r.ok)).toEqual([]);
  expect(negative.length).toBe(NEGATIVE_CASES.length);
}

/** A generated `api` file and how to type-check it. */
type Output = {
  file: string;
  generate: (modules: ScaleModule[]) => string | Promise<string>;
  probes?: ProbeOptions;
};

const SEGMENTED: Output[] = [
  { file: "api.d.ts", generate: (m) => apiCodegen(m.map((x) => x.path)).DTS! },
  {
    file: "api.ts",
    generate: (m) =>
      apiCodegen(
        m.map((x) => x.path),
        { useTypeScript: true },
      ).TS!,
  },
  // `convex codegen --commonjs` and `generateCommonJSApi`. Component codegen
  // writes the same text as its `api.d.ts` (see `codegen.ts`).
  {
    file: "api_cjs.d.cts",
    generate: (m) => apiCjsCodegen(m.map((x) => x.path)).DTS!,
    probes: CJS,
  },
];

// Static codegen drops top-level folders without public functions from `api`,
// as upstream's `ApiFromModules` does.
const STATIC: Output[] = [
  {
    file: "api.d.ts",
    generate: (m) => staticComponentApi(m, false),
    probes: { emptyTopLevel: "dropped" },
  },
  {
    file: "api.ts",
    generate: (m) => staticComponentApi(m, true),
    probes: { emptyTopLevel: "dropped" },
  },
];

describe.each(SIZES)("$modules modules", (size) => {
  test.each([
    ["api.d.ts", {}],
    ["api_cjs.d.cts", CJS],
  ] as const)(
    "upstream's monolithic %s collapses to never (control)",
    (fileName, probes) => {
      const modules = modulesOfSize(size);
      const dir = writeProject(
        path.join(tmp, `mono-${fileName}-${size.modules}`),
        {
          ...moduleFiles(modules),
          [`convex/_generated/${fileName}`]: monolithicApiDts(
            modules.map((m) => m.path),
          ),
          ...probeFiles(modules, probes),
        },
      );
      const diagnostics = checkWithBulkTypeScript(dir);
      expect(
        diagnostics.some((d) => d.message.includes("on type 'never'")),
      ).toBe(true);
    },
    TIMEOUT,
  );

  test.each([
    ...SEGMENTED.map((o) => ({ kind: "segmented", ...o })),
    ...STATIC.map((o) => ({ kind: "static", ...o })),
  ])(
    "$kind $file is strictly typed",
    async ({ kind, ...output }) => {
      const modules = modulesOfSize(size);
      const generated = await output.generate(modules);
      if (kind === "static") {
        expect(generated).not.toContain("ApiFromModules");
      }
      const dir = writeProject(
        path.join(tmp, `${kind}-${output.file}-${size.modules}`),
        {
          ...moduleFiles(modules),
          [`convex/_generated/${output.file}`]: generated,
          ...probeFiles(modules, output.probes),
        },
      );
      const diagnostics = checkWithBulkTypeScript(dir);
      expect(unexpected(diagnostics)).toEqual([]);
      expectNegativeCasesFail(diagnostics, output.probes);
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
${TYPE_ASSERTIONS}
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

const crashCtx = {
  fs: nodeFs,
  crash: async (args: { printedMessage: string | null }) => {
    throw new Error(args.printedMessage ?? "crash");
  },
} as unknown as Context;

/**
 * Component codegen (`convex dev` with components) for a root component in
 * `dir/convex` with `functions` as the backend's analysis.
 */
async function componentApi(
  dir: string,
  opts: { useTypeScript: boolean; staticApi: boolean; functions?: unknown },
) {
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
      "../convex": {
        definition: { childComponents: [] },
        functions: opts.functions ?? [],
      },
    },
  } as any;
  const codegenOpts = {
    staticApi: opts.staticApi,
    useComponentApiImports: true,
  };
  return opts.useTypeScript
    ? await componentApiTSWithTypes(
        crashCtx,
        startPush,
        root,
        component,
        new Map(),
        codegenOpts,
      )
    : await componentApiDTS(
        crashCtx,
        startPush,
        root,
        component,
        new Map(),
        codegenOpts,
      );
}

/** Static codegen's `api.d.ts` or `api.ts` for `modules`. */
function staticComponentApi(modules: ScaleModule[], useTypeScript: boolean) {
  return componentApi(tmp, {
    useTypeScript,
    staticApi: true,
    functions: scaleModuleAnalysis(modules),
  });
}

describe("component api", () => {
  // A component with as many modules as the smaller project, generated by the
  // component codegen instead of `apiCodegen`.
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
      const generated = await componentApi(dir, {
        useTypeScript,
        staticApi: false,
      });
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
