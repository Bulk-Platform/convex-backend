// Bulk: helpers for `_system/cli/modules`. They work on the validator JSON
// strings stored in `_modules` instead of parsing them into object trees,
// which for large apps does not fit in the 64 MiB isolate heap.
import { UdfType, Visibility } from "../frontend/common";

export const DEFAULT_ARGS_VALIDATOR = '{ "type": "any" }';
export const DEFAULT_RETURN_VALIDATOR = '{ "type": "any" }';

export type AnalyzedFunctionDoc = {
  name: string;
  udfType: UdfType;
  visibility?: Visibility | null;
  args?: string | null;
  returns?: string | null;
};

export type AnalyzedHttpRouteDoc = {
  route: { method: string; path: string };
};

export type ModuleDoc = {
  path: string;
  analyzeResult?: {
    functions?: AnalyzedFunctionDoc[] | null;
    httpRoutes?: AnalyzedHttpRouteDoc[] | null;
  } | null;
};

/**
 * One `apiSpec` entry as a JSON string, in the same JSON encoding the runtime
 * gives the parsed value (`convexToJson(jsonToConvex(JSON.parse(args)))`).
 * The stored validators are already Convex JSON written by the backend, so they
 * are spliced in unchanged.
 */
export function functionSpecJson(
  modulePath: string,
  fn: AnalyzedFunctionDoc,
): string {
  return (
    `{"identifier":${JSON.stringify(modulePath + ":" + fn.name)}` +
    `,"functionType":${JSON.stringify(fn.udfType)}` +
    `,"visibility":${JSON.stringify(fn.visibility ?? { kind: "public" })}` +
    `,"args":${fn.args ?? DEFAULT_ARGS_VALIDATOR}` +
    `,"returns":${fn.returns ?? DEFAULT_RETURN_VALIDATOR}}`
  );
}

export function httpRouteSpecJson(route: AnalyzedHttpRouteDoc): string {
  return JSON.stringify({
    functionType: "HttpAction",
    method: route.route.method,
    path: route.route.path,
  });
}

/**
 * An `apiSpecPage` entry. Validators stay JSON strings: Bulk's largest are
 * deeper than a Convex value may nest, and parsing them here would cost the
 * heap this query exists to save. Clients `JSON.parse` them.
 */
export type FunctionSpecPageEntry =
  | {
      identifier: string;
      functionType: UdfType;
      visibility: Visibility;
      argsJson: string;
      returnsJson: string;
    }
  | {
      functionType: "HttpAction";
      method: string;
      path: string;
    };

export function functionSpecPageEntries(
  module: ModuleDoc,
): FunctionSpecPageEntry[] {
  const analyzeResult = module.analyzeResult;
  if (!analyzeResult) {
    return [];
  }
  const entries: FunctionSpecPageEntry[] = [];
  for (const fn of analyzeResult.functions || []) {
    entries.push({
      identifier: module.path + ":" + fn.name,
      functionType: fn.udfType,
      visibility: fn.visibility ?? { kind: "public" },
      argsJson: fn.args ?? DEFAULT_ARGS_VALIDATOR,
      returnsJson: fn.returns ?? DEFAULT_RETURN_VALIDATOR,
    });
  }
  for (const httpFn of analyzeResult.httpRoutes || []) {
    entries.push({
      functionType: "HttpAction",
      method: httpFn.route.method,
      path: httpFn.route.path,
    });
  }
  return entries;
}

/** Approximate response bytes of an entry, for page budgeting. */
export function functionSpecPageEntrySize(entry: FunctionSpecPageEntry) {
  if (!("identifier" in entry)) {
    return entry.method.length + entry.path.length + 64;
  }
  return (
    entry.identifier.length +
    entry.argsJson.length +
    entry.returnsJson.length +
    96
  );
}
