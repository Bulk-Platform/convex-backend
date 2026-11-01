// Bulk fork: type probes for a synthetic project from scale_fixture.ts. Each
// probe file imports `api` and `internal` from `./_generated/api` (or another
// generated module, see {@link ProbeOptions}) and fails to compile if a path
// resolves to `any` or `never`, to the wrong function, or if a path that
// should not exist type-checks.

import { ScaleModule } from "./scale_fixture.js";

/** Exact-type assertions for probe files: `Expect<Equal<A, B>>` and friends. */
export const TYPE_ASSERTIONS = `type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;
type Concrete<T> = IsAny<T> extends true ? false : IsNever<T> extends true ? false : true;
`;

export type ProbeOptions = {
  /** Where probes import `api` and `internal` from. */
  apiModule?: string;
  /**
   * How a top-level folder without public functions (`ops/`) appears on
   * `api`: `"kept"` as `{}` (segmented codegen, see BULK.md) or `"dropped"`
   * (upstream and static codegen).
   */
  emptyTopLevel?: "kept" | "dropped";
};

const prelude = ({ apiModule = "./_generated/api" }: ProbeOptions = {}) =>
  `import { api, internal } from "${apiModule}";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

${TYPE_ASSERTIONS}type Get<I extends number> = FunctionReference<"query", "public", { id: string; limit?: number | undefined }, { module: I; id: string }>;
type Set = FunctionReference<"mutation", "public", { id: string; value: "a" | "b" }, boolean>;
type Sweep<I extends number> = FunctionReference<"query", "internal", { before: number }, { swept: I }>;
`;

/** `api.big.s3.deep.d3` for `big/s3/deep/d3.ts`, `api.crons` for `crons.ts`. */
export function accessPath(root: "api" | "internal", modulePath: string) {
  return [root, ...modulePath.replace(/\.ts$/, "").split("/")].join(".");
}

/** Sorted string-literal union, or `never`. */
function union(keys: Iterable<string>) {
  const sorted = [...new Set(keys)].sort();
  return sorted.length
    ? sorted.map((k) => JSON.stringify(k)).join(" | ")
    : "never";
}

/**
 * The keys `api` / `internal` should have at `prefix` (a folder path),
 * computed from the module list: subfolders and modules, plus the functions
 * of a module at that exact path.
 */
export function expectedKeys(
  modules: ScaleModule[],
  prefix: string[],
  visibility: "public" | "internal",
) {
  const keys: string[] = [];
  for (const module of modules) {
    const parts = module.path.replace(/\.ts$/, "").split("/");
    const isPrefix = prefix.every((p, i) => parts[i] === p);
    if (!isPrefix) continue;
    if (parts.length === prefix.length) {
      keys.push(...functionNames(module, visibility));
    } else if (functionNames(module, visibility).length > 0) {
      keys.push(parts[prefix.length]);
    }
  }
  return keys;
}

function functionNames(module: ScaleModule, visibility: string) {
  if (visibility === "internal") return ["sweep"];
  return module.kind === "mixed" ? ["get", "set"] : [];
}

/** One module per top-level folder and per `big/` subfolder, plus first and last. */
export function sampleModules(modules: ScaleModule[]) {
  const seen = new Set<string>();
  const sample: ScaleModule[] = [];
  for (const module of modules) {
    const parts = module.path.split("/");
    const key =
      parts[0] === "big" && parts.length > 2
        ? parts.slice(0, 2).join("/")
        : parts[0];
    if (!seen.has(key)) {
      seen.add(key);
      sample.push(module);
    }
  }
  sample.push(modules[modules.length - 1]);
  return sample;
}

/**
 * Probe files with exact-type assertions, spread over `fileCount` files so
 * that each of tsc's checkers resolves `api` on its own.
 */
export function positiveProbes(
  modules: ScaleModule[],
  options: ProbeOptions = {},
  fileCount = 8,
) {
  const sample = sampleModules(modules);
  const files: Record<string, string> = {};
  for (let f = 0; f < fileCount; f++) {
    const lines = [prelude(options)];
    lines.push(
      `export type ApiConcrete = Expect<Concrete<typeof api>>;`,
      `export type InternalConcrete = Expect<Concrete<typeof internal>>;`,
    );
    sample.forEach((module, i) => {
      if (i % fileCount !== f) return;
      const n = module.index;
      const pub = accessPath("api", module.path);
      const int = accessPath("internal", module.path);
      if (module.kind === "mixed") {
        lines.push(
          `export type G${n} = Expect<Equal<typeof ${pub}.get, Get<${n}>>>;`,
          `export type S${n} = Expect<Equal<typeof ${pub}.set, Set>>;`,
          `export type C${n} = Expect<Concrete<typeof ${pub}>>;`,
          `export type A${n} = Expect<Equal<FunctionArgs<typeof ${pub}.get>, { id: string; limit?: number | undefined }>>;`,
          `export type R${n} = Expect<Equal<FunctionReturnType<typeof ${pub}.get>, { module: ${n}; id: string }>>;`,
          `export const ref${n}: FunctionReference<"query", "public"> = ${pub}.get;`,
        );
      }
      lines.push(
        `export type W${n} = Expect<Equal<typeof ${int}.sweep, Sweep<${n}>>>;`,
        `export type WR${n} = Expect<Equal<FunctionReturnType<typeof ${int}.sweep>, { swept: ${n} }>>;`,
      );
    });
    files[`convex/probe_${f}.ts`] = lines.join("\n") + "\n";
  }
  files["convex/probe_keys.ts"] = keyProbes(modules, options);
  return files;
}

/** The exact key sets at the root, in the split `big/` folder and below it. */
function keyProbes(modules: ScaleModule[], options: ProbeOptions) {
  const kept = (options.emptyTopLevel ?? "kept") === "kept";
  const lines = [prelude(options)];
  const prefixes = [
    [],
    ["big"],
    ["big", "s0"],
    ["big", "s0", "deep"],
    ["f0"],
    ["ops"],
  ];
  prefixes.forEach((prefix, i) => {
    for (const visibility of ["public", "internal"] as const) {
      const root = visibility === "public" ? "api" : "internal";
      let keys = expectedKeys(modules, prefix, visibility);
      const target =
        prefix.length === 0
          ? `typeof ${root}`
          : `typeof ${accessPath(root, prefix.join("/"))}`;
      if (prefix.length === 0 && visibility === "public" && kept) {
        // Top-level folders without public functions stay on `api` as `{}`
        // (see BULK.md); everything below the top level matches upstream.
        keys = [...keys, ...topLevelWithoutPublic(modules)];
      }
      if (prefix[0] === "ops" && visibility === "public") {
        lines.push(
          kept
            ? `export type K${i}${root} = Expect<Equal<${target}, {}>>;`
            : `export type K${i}${root} = Expect<Equal<"ops" extends keyof typeof api ? true : false, false>>;`,
        );
        continue;
      }
      lines.push(
        `export type K${i}${root} = Expect<Equal<keyof ${target}, ${union(keys)}>>;`,
      );
    }
  });
  return lines.join("\n") + "\n";
}

function topLevelWithoutPublic(modules: ScaleModule[]) {
  const all = new Set(
    modules.map((m) => m.path.replace(/\.ts$/, "").split("/")[0]),
  );
  const withPublic = new Set(expectedKeys(modules, [], "public"));
  return [...all].filter((k) => !withPublic.has(k));
}

/**
 * Paths and assignments that must not type-check, each with a fragment of the
 * error it must produce. A `never` or `any` api fails these: `never` reports
 * a different property, `any` reports nothing.
 */
export const NEGATIVE_CASES: { code: string; expect: string; error: string }[] =
  [
    {
      code: `export const e = api.f0.m0.sweep;`,
      expect: "TS2339",
      error: "Property 'sweep' does not exist",
    },
    {
      code: `export const e = internal.f0.m0.get;`,
      expect: "TS2339",
      error: "Property 'get' does not exist",
    },
    {
      code: `export const e = api.f0.m0.helper;`,
      expect: "TS2339",
      error: "Property 'helper' does not exist",
    },
    {
      code: `export const e = api.f0.m0.gett;`,
      expect: "TS2551",
      error: "Property 'gett' does not exist",
    },
    {
      code: `export const e = api.f0.mNope.get;`,
      expect: "TS2339",
      error: "Property 'mNope' does not exist",
    },
    {
      code: `export const e = api.fNope.m0.get;`,
      expect: "TS2339",
      error: "Property 'fNope' does not exist",
    },
    {
      code: `export const e = api.ops.m0.sweep;`,
      expect: "TS2339",
      error: "Property 'm0' does not exist",
    },
    {
      code: `export const e = api.big.s0.m1.get;`,
      expect: "TS2339",
      error: "Property 'm1' does not exist",
    },
    {
      code: `export const e = api.big.s0.deep.d0.sweep;`,
      expect: "TS2339",
      error: "Property 'sweep' does not exist",
    },
    {
      code: `export const e = internal.big.get;`,
      expect: "TS2339",
      error: "Property 'get' does not exist",
    },
    {
      code: `export const e: FunctionArgs<typeof api.f0.m0.set> = { id: "x", value: "c" };`,
      expect: "TS2322",
      error: `Type '"c"' is not assignable`,
    },
    {
      code: `export const e: FunctionReturnType<typeof api.f0.m1.get> = { module: 0, id: "x" };`,
      expect: "TS2322",
      error: "Type '0' is not assignable to type '1'",
    },
    {
      code: `export const e: FunctionReference<"mutation"> = api.f0.m0.get;`,
      expect: "TS2322",
      error: "is not assignable",
    },
  ];

/**
 * `probe_guards.ts` wraps each negative case in `@ts-expect-error`, so an
 * unused guard fails the build. `probe_negative.ts` has them without the
 * guard, one per line after the prelude, so tests can check each one fails
 * for the right reason.
 */
export function negativeProbes(options: ProbeOptions = {}) {
  return {
    "convex/probe_guards.ts":
      prelude(options) +
      NEGATIVE_CASES.map(
        (c, i) =>
          `// @ts-expect-error ${negativeCaseError(c, options)}\n${c.code.replace("const e", `const e${i}`)}`,
      ).join("\n") +
      "\n",
    "convex/probe_negative.ts":
      prelude(options) +
      NEGATIVE_CASES.map((c, i) =>
        c.code.replace("const e", `const e${i}`),
      ).join("\n") +
      "\n",
  };
}

/**
 * Negative cases that fail on a different property when `ProbeOptions`
 * has `emptyTopLevel: "dropped"`.
 */
const DROPPED_ERRORS: Record<string, string> = {
  "export const e = api.ops.m0.sweep;": "Property 'ops' does not exist",
};

/** The error fragment a negative case must produce under `options`. */
export function negativeCaseError(
  c: (typeof NEGATIVE_CASES)[number],
  options: ProbeOptions = {},
) {
  return (
    (options.emptyTopLevel === "dropped" && DROPPED_ERRORS[c.code]) || c.error
  );
}

/** 1-based line of each negative case in `probe_negative.ts`. */
export function negativeCaseLines() {
  const preludeLines = prelude().split("\n").length - 1;
  return NEGATIVE_CASES.map((_, i) => preludeLines + i + 1);
}
