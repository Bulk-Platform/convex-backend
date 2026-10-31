// @vitest-environment node
import { describe, expect, test } from "vitest";
import { convexToJson, jsonToConvex, v, Validator } from "convex/values";
import {
  AnalyzedFunctionDoc,
  DEFAULT_ARGS_VALIDATOR,
  DEFAULT_RETURN_VALIDATOR,
  functionSpecPageEntries,
  ModuleDoc,
  parseFunctionSpecCursor,
  readFunctionSpecPage,
} from "./functionSpecPage";

// How a validator is stored in `_modules` (its JSON is already Convex JSON).
function stored(validator: Validator<any, any, any>): string {
  return JSON.stringify(validator.json);
}

const doc = v.object({
  _id: v.id("orders"),
  _creationTime: v.number(),
  status: v.union(
    v.literal("open"),
    v.literal("closed"),
    v.literal(BigInt(10)),
  ),
  quantity: v.int64(),
  blob: v.optional(v.bytes()),
  lines: v.array(
    v.object({
      sku: v.string(),
      qty: v.number(),
      meta: v.record(v.string(), v.union(v.null(), v.boolean())),
    }),
  ),
});

const functions: AnalyzedFunctionDoc[] = [
  {
    name: "list",
    udfType: "Query",
    visibility: { kind: "public" },
    args: stored(v.object({ cursor: v.optional(v.string()), n: v.int64() })),
    returns: stored(v.array(doc)),
  },
  {
    name: "default",
    udfType: "Mutation",
    visibility: { kind: "internal" },
    args: stored(v.object({ order: doc })),
    returns: stored(v.null()),
  },
  // Old modules may have no validators or visibility.
  { name: "legacy", udfType: "Action" },
];

// An `apiSpec` entry, as the response JSON.
function previousApiSpecEntry(path: string, fn: AnalyzedFunctionDoc) {
  return convexToJson({
    identifier: path + ":" + fn.name,
    functionType: fn.udfType,
    visibility: fn.visibility ?? { kind: "public" },
    args: jsonToConvex(JSON.parse(fn.args ?? DEFAULT_ARGS_VALIDATOR)),
    returns: jsonToConvex(JSON.parse(fn.returns ?? DEFAULT_RETURN_VALIDATOR)),
  });
}

describe("apiSpecPage entries", () => {
  test("carry the same validators as `apiSpec`, as JSON strings", () => {
    const module: ModuleDoc = {
      path: "orders/queries.js",
      analyzeResult: {
        functions,
        httpRoutes: [{ route: { method: "GET", path: "/health" } }],
      },
    };
    const entries = functionSpecPageEntries(module);
    expect(entries).toHaveLength(4);
    entries.slice(0, 3).forEach((entry, i) => {
      if (!("identifier" in entry)) {
        throw new Error("expected a function entry");
      }
      const { argsJson, returnsJson, ...rest } = entry;
      expect({
        ...rest,
        args: JSON.parse(argsJson),
        returns: JSON.parse(returnsJson),
      }).toEqual(previousApiSpecEntry(module.path, functions[i]));
    });
    expect(entries[3]).toEqual({
      functionType: "HttpAction",
      method: "GET",
      path: "/health",
    });
  });

  test("skip modules without an analyze result", () => {
    expect(
      functionSpecPageEntries({ path: "_deps/A.js", analyzeResult: null }),
    ).toEqual([]);
  });
});

describe("apiSpecPage paging", () => {
  // Modules as `apiSpecPage` reads them from `_modules`: in path order, from
  // the cursor's module, or else the prefix, on.
  async function* from(
    modules: ModuleDoc[],
    from: string | null,
  ): AsyncIterable<ModuleDoc> {
    for (const module of modules) {
      if (from === null || module.path >= from) {
        yield module;
      }
    }
  }

  async function readAll(
    modules: ModuleDoc[],
    budget: number,
    pathPrefix?: string,
  ) {
    const pages = [];
    let cursor: string | null = null;
    for (;;) {
      const start = parseFunctionSpecCursor(cursor);
      const page = await readFunctionSpecPage(
        from(modules, start?.path ?? pathPrefix ?? null),
        start,
        budget,
        pathPrefix ?? "",
      );
      pages.push(page.page);
      if (page.isDone) {
        return pages;
      }
      cursor = page.continueCursor;
    }
  }

  const big = "x".repeat(1000);
  const modules: ModuleDoc[] = [
    {
      path: "a.js",
      analyzeResult: {
        functions: ["f1", "f2", "f3", "f4", "f5"].map((name) => ({
          name,
          udfType: "Query",
          args: JSON.stringify({ type: "literal", value: big }),
        })),
        httpRoutes: [{ route: { method: "GET", path: "/a" } }],
      },
    },
    { path: "b.js", analyzeResult: null },
    {
      path: "c.js",
      analyzeResult: { functions: [{ name: "g", udfType: "Mutation" }] },
    },
  ];
  const all = modules.flatMap(functionSpecPageEntries);

  test("splits a module bigger than a page", async () => {
    const pages = await readAll(modules, 2000);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 3]);
    expect(pages.flat()).toEqual(all);
  });

  test("returns everything in one page when it fits", async () => {
    expect(await readAll(modules, 1 << 20)).toEqual([all]);
  });

  test("returns one entry per page at the smallest budget", async () => {
    const pages = await readAll(modules, 1);
    expect(pages.map((page) => page.length)).toEqual(all.map(() => 1));
    expect(pages.flat()).toEqual(all);
  });

  test("reads only modules under a path prefix", async () => {
    const tree: ModuleDoc[] = [
      "orders.js",
      "orders/a.js",
      "orders/b.js",
      "orders_old.js",
      "users/a.js",
    ].map((path) => ({
      path,
      analyzeResult: {
        functions: [
          { name: "f", udfType: "Query", args: JSON.stringify(big) },
          { name: "g", udfType: "Query", args: JSON.stringify(big) },
        ],
      },
    }));
    const identifiers = async (prefix: string, budget: number) =>
      (await readAll(tree, budget, prefix))
        .flat()
        .map((entry) => ("identifier" in entry ? entry.identifier : null));
    for (const budget of [1, 2000, 1 << 20]) {
      expect(await identifiers("orders/", budget)).toEqual([
        "orders/a.js:f",
        "orders/a.js:g",
        "orders/b.js:f",
        "orders/b.js:g",
      ]);
      expect(await identifiers("orders/b.js", budget)).toEqual([
        "orders/b.js:f",
        "orders/b.js:g",
      ]);
      expect(await identifiers("zzz", budget)).toEqual([]);
      expect(await identifiers("", budget)).toHaveLength(10);
    }
  });

  test("rejects a malformed cursor", () => {
    expect(() => parseFunctionSpecCursor("a.js")).toThrow();
    expect(() => parseFunctionSpecCursor('["a.js", "1"]')).toThrow(
      "Invalid function spec cursor",
    );
  });
});
