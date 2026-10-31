// @vitest-environment node
import { describe, expect, test } from "vitest";
import { convexToJson, jsonToConvex, v, Validator } from "convex/values";
import {
  AnalyzedFunctionDoc,
  DEFAULT_ARGS_VALIDATOR,
  DEFAULT_RETURN_VALIDATOR,
  functionSpecJson,
  functionSpecPageEntries,
  httpRouteSpecJson,
  ModuleDoc,
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
