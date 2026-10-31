// @vitest-environment node
import { describe, expect, test } from "vitest";
import { convexToJson, jsonToConvex, v, Validator } from "convex/values";
import {
  AnalyzedFunctionDoc,
  convexJsonValueSize,
  DEFAULT_ARGS_VALIDATOR,
  DEFAULT_RETURN_VALIDATOR,
  functionSpecJson,
  functionSpecPageEntries,
  httpRouteSpecJson,
  ModuleDoc,
  parseFunctionSpecCursor,
  readFunctionSpecPage,
} from "./functionSpecJson";

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

// The previous `apiSpec` implementation, as the response JSON.
function previousApiSpecEntry(path: string, fn: AnalyzedFunctionDoc) {
  return convexToJson({
    identifier: path + ":" + fn.name,
    functionType: fn.udfType,
    visibility: fn.visibility ?? { kind: "public" },
    args: jsonToConvex(JSON.parse(fn.args ?? DEFAULT_ARGS_VALIDATOR)),
    returns: jsonToConvex(JSON.parse(fn.returns ?? DEFAULT_RETURN_VALIDATOR)),
  });
}

describe("apiSpec JSON", () => {
  test("matches the previous encoding", () => {
    for (const fn of functions) {
      const json = functionSpecJson("orders/queries.js", fn);
      expect(JSON.parse(json)).toEqual(
        previousApiSpecEntry("orders/queries.js", fn),
      );
    }
  });

  test("keeps int64 and bytes in Convex JSON form", () => {
    const parsed = JSON.parse(functionSpecJson("a.js", functions[0]));
    expect(parsed.args.value.n).toEqual({
      fieldType: { type: "bigint" },
      optional: false,
    });
    expect(parsed.returns.value.value.status.fieldType.value[2].value).toEqual(
      convexToJson(BigInt(10)),
    );
    // It also round-trips through the client's decoder.
    expect(convexToJson(jsonToConvex(parsed))).toEqual(parsed);
  });

  test("escapes identifiers", () => {
    const fn: AnalyzedFunctionDoc = { name: 'we"ird', udfType: "Query" };
    expect(JSON.parse(functionSpecJson('dir\\x".js', fn)).identifier).toBe(
      'dir\\x".js:we"ird',
    );
  });

  test("http routes", () => {
    expect(
      JSON.parse(httpRouteSpecJson({ route: { method: "POST", path: "/x" } })),
    ).toEqual({ functionType: "HttpAction", method: "POST", path: "/x" });
  });
});

describe("apiSpecPage entries", () => {
  test("carry the same validators as JSON strings", () => {
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
  // Modules as `_modules` returns them for a cursor: in path order, from the
  // cursor's module on.
  async function* from(
    modules: ModuleDoc[],
    start: { path: string } | null,
  ): AsyncIterable<ModuleDoc> {
    for (const module of modules) {
      if (start === null || module.path >= start.path) {
        yield module;
      }
    }
  }

  async function readAll(modules: ModuleDoc[], budget: number) {
    const pages = [];
    let cursor: string | null = null;
    for (;;) {
      const start = parseFunctionSpecCursor(cursor);
      const page = await readFunctionSpecPage(
        from(modules, start),
        start,
        budget,
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

  test("rejects a malformed cursor", () => {
    expect(() => parseFunctionSpecCursor("a.js")).toThrow();
    expect(() => parseFunctionSpecCursor('["a.js", "1"]')).toThrow(
      "Invalid function spec cursor",
    );
  });
});

describe("convexJsonValueSize", () => {
  test("follows the backend's size rules", () => {
    // { "a": "xy", "b": [1, null, true] }:
    // 1 + (1 + 1 + 4) + (1 + 1 + (1 + 9 + 1 + 1 + 1)) + 1
    expect(convexJsonValueSize({ a: "xy", b: [1, null, true] })).toBe(23);
    expect(convexJsonValueSize(convexToJson(BigInt(10)))).toBe(9);
    expect(convexJsonValueSize(convexToJson(new ArrayBuffer(6)))).toBe(8);
    expect(convexJsonValueSize(convexToJson(new ArrayBuffer(5)))).toBe(7);
    expect(convexJsonValueSize(convexToJson(new ArrayBuffer(4)))).toBe(6);
  });

  test("measures validators smaller than their JSON", () => {
    const json = functionSpecJson("orders/queries.js", functions[0]);
    const size = convexJsonValueSize(JSON.parse(json));
    expect(size).toBeGreaterThan(json.length / 2);
    expect(size).toBeLessThan(json.length);
  });
});
