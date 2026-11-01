import { UdfType, Visibility } from "../frontend/common";
import { queryPrivateSystem } from "../secretSystemTables";
import { v, Value, jsonToConvex } from "convex/values";
import {
  FunctionSpecPage,
  parseFunctionSpecCursor,
  readFunctionSpecPage,
} from "./functionSpecPage";

type FunctionSpec = {
  identifier: string;
  functionType: UdfType;
  visibility: Visibility;
  args?: Value;
  returns?: Value;
};

type HttpFunctionSpec = {
  functionType: "HttpAction";
  method: string;
  path: string;
};

type FunctionSpecs = (FunctionSpec | HttpFunctionSpec)[];

export const DEFAULT_ARGS_VALIDATOR = '{ "type": "any" }';
export const DEFAULT_RETURN_VALIDATOR = '{ "type": "any" }';

export const apiSpec = queryPrivateSystem("ViewData")({
  args: {
    componentId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async ({ db }): Promise<FunctionSpecs> => {
    const result: FunctionSpecs = [];
    for await (const module of db.query("_modules")) {
      const analyzeResult = module.analyzeResult;
      if (!analyzeResult) {
        // `Skipping ${module.path}`
        continue;
      }
      for (const fn of analyzeResult.functions || []) {
        const argsValidator = fn.args ?? DEFAULT_ARGS_VALIDATOR;
        const returnsValidator = fn.returns ?? DEFAULT_RETURN_VALIDATOR;
        result.push({
          identifier: module.path + ":" + fn.name,
          functionType: fn.udfType,
          visibility: fn.visibility ?? { kind: "public" },
          args: jsonToConvex(JSON.parse(argsValidator)),
          returns: jsonToConvex(JSON.parse(returnsValidator)),
        });
      }

      for (const httpFn of analyzeResult.httpRoutes || []) {
        result.push({
          functionType: "HttpAction",
          method: httpFn.route.method,
          path: httpFn.route.path,
        });
      }
    }

    return result;
  },
});

const DEFAULT_PAGE_BYTES = 4 * (1 << 20);
const MAX_PAGE_BYTES = 8 * (1 << 20);

/**
 * Bulk: the function spec a page at a time, in module path order, for apps
 * whose spec `apiSpec` can't return in one response. A page ends once it holds
 * `maxBytes` of validators (default 4 MiB), partway through a module if need
 * be. Validators are returned as JSON strings (`argsJson`, `returnsJson`), so a
 * page costs little heap and no validator can exceed the value nesting limit.
 * `pathPrefix` limits the spec to modules whose path starts with it.
 */
export const apiSpecPage = queryPrivateSystem("ViewData")({
  args: {
    componentId: v.optional(v.union(v.string(), v.null())),
    cursor: v.optional(v.union(v.string(), v.null())),
    maxBytes: v.optional(v.number()),
    pathPrefix: v.optional(v.string()),
  },
  handler: async (
    { db },
    { cursor, maxBytes, pathPrefix },
  ): Promise<FunctionSpecPage> => {
    const budget = Math.min(
      Math.max(maxBytes ?? DEFAULT_PAGE_BYTES, 1),
      MAX_PAGE_BYTES,
    );
    const start = parseFunctionSpecCursor(cursor);
    const from = start?.path ?? pathPrefix ?? null;
    const modules = db
      .query("_modules")
      .withIndex("by_path", (q) => (from === null ? q : q.gte("path", from)));
    return await readFunctionSpecPage(modules, start, budget, pathPrefix ?? "");
  },
});
