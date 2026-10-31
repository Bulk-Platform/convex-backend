import { UdfType, Visibility } from "../frontend/common";
import { queryPrivateSystem } from "../secretSystemTables";
import { v, Value } from "convex/values";
import {
  convexJsonValueSize,
  DEFAULT_ARGS_VALIDATOR,
  DEFAULT_RETURN_VALIDATOR,
  FunctionSpecPage,
  functionSpecJson,
  httpRouteSpecJson,
  parseFunctionSpecCursor,
  readFunctionSpecPage,
} from "./functionSpecJson";

export { DEFAULT_ARGS_VALIDATOR, DEFAULT_RETURN_VALIDATOR };
export type { FunctionSpecPage };

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

// Bulk: `apiSpec` used to parse every validator into a value and let the
// runtime serialize the result twice (return validation, then the response),
// which runs out of the 64 MiB isolate heap on large apps. The handler now
// builds the response JSON from the stored validator strings, and the wrapped
// `invokeQuery` below returns that string as the query result. The response is
// unchanged. A spec whose value is over the backend's 32 MiB limit for any
// value (`MAX_SIZE` in `crates/value/src/size.rs`), so can never be returned,
// fails early with an error that points at `apiSpecPage`, rather than running
// out of memory. The backend still applies the result size limit itself.
const MAX_VALUE_SIZE = 1 << 25;
let apiSpecResultJson: string | null = null;

const apiSpecQuery = queryPrivateSystem("ViewData")({
  args: {
    componentId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async ({ db }): Promise<FunctionSpecs> => {
    const parts: string[] = [];
    // The size of the result array (see `convexJsonValueSize`).
    let size = 2;
    const add = (json: string) => {
      size += convexJsonValueSize(JSON.parse(json));
      if (size > MAX_VALUE_SIZE) {
        throw new Error(
          `The function spec is over ${MAX_VALUE_SIZE >> 20} MiB, too ` +
            "large for one response. Read it a page at a time with " +
            "`_system/cli/modules:apiSpecPage`; `npx convex function-spec` " +
            "does from @bulk-platform/convex 1.46.0-bulk.2.",
        );
      }
      parts.push(json);
    };
    for await (const module of db.query("_modules")) {
      const analyzeResult = module.analyzeResult;
      if (!analyzeResult) {
        // `Skipping ${module.path}`
        continue;
      }
      for (const fn of analyzeResult.functions || []) {
        add(functionSpecJson(module.path, fn));
      }
      for (const httpFn of analyzeResult.httpRoutes || []) {
        add(httpRouteSpecJson(httpFn));
      }
    }
    apiSpecResultJson = "[" + parts.join(",") + "]";
    // The real result is `apiSpecResultJson`; see `invokeQuery` below.
    return [];
  },
});

const invokeApiSpecQuery = apiSpecQuery.invokeQuery;
apiSpecQuery.invokeQuery = async (argsStr: string) => {
  apiSpecResultJson = null;
  try {
    const result = await invokeApiSpecQuery(argsStr);
    // With a `componentId` the handler above does not run: the wrapper runs
    // the query in that component and returns its value as usual.
    return apiSpecResultJson ?? result;
  } finally {
    apiSpecResultJson = null;
  }
};

export const apiSpec = apiSpecQuery;

const DEFAULT_PAGE_BYTES = 4 * (1 << 20);
const MAX_PAGE_BYTES = 8 * (1 << 20);

/**
 * Bulk: the function spec a page at a time, in module path order. A page ends
 * once it holds `maxBytes` of validators (default 4 MiB), partway through a
 * module if need be. Validators are returned as JSON strings (`argsJson`,
 * `returnsJson`), so a page costs little heap and no validator can exceed the
 * value nesting limit.
 */
export const apiSpecPage = queryPrivateSystem("ViewData")({
  args: {
    componentId: v.optional(v.union(v.string(), v.null())),
    cursor: v.optional(v.union(v.string(), v.null())),
    maxBytes: v.optional(v.number()),
  },
  handler: async ({ db }, { cursor, maxBytes }): Promise<FunctionSpecPage> => {
    const budget = Math.min(
      Math.max(maxBytes ?? DEFAULT_PAGE_BYTES, 1),
      MAX_PAGE_BYTES,
    );
    const start = parseFunctionSpecCursor(cursor);
    const modules = db
      .query("_modules")
      .withIndex("by_path", (q) =>
        start === null ? q : q.gte("path", start.path),
      );
    return await readFunctionSpecPage(modules, start, budget);
  },
});
