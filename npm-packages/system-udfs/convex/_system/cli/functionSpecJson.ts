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

export type FunctionSpecPage = {
  page: FunctionSpecPageEntry[];
  isDone: boolean;
  // Pass back as `cursor` for the next page: `[modulePath, entriesRead]`
  // as JSON, so a page can end partway through a module.
  continueCursor: string | null;
};

export function parseFunctionSpecCursor(
  cursor: string | null | undefined,
): { path: string; skip: number } | null {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(cursor);
  if (
    !Array.isArray(parsed) ||
    typeof parsed[0] !== "string" ||
    !Number.isInteger(parsed[1])
  ) {
    throw new Error(`Invalid function spec cursor: ${cursor}`);
  }
  return { path: parsed[0], skip: parsed[1] };
}

/**
 * Reads entries from `modules` (in path order, starting at `start.path`)
 * until the page reaches `budget` bytes. The budget is checked between
 * entries, so a module bigger than a page is split across pages.
 */
export async function readFunctionSpecPage(
  modules: AsyncIterable<ModuleDoc>,
  start: { path: string; skip: number } | null,
  budget: number,
): Promise<FunctionSpecPage> {
  const page: FunctionSpecPageEntry[] = [];
  let bytes = 0;
  let continueCursor = start && JSON.stringify([start.path, start.skip]);
  for await (const module of modules) {
    const entries = functionSpecPageEntries(module);
    const first = module.path === start?.path ? start.skip : 0;
    for (let i = first; i < entries.length; i++) {
      if (page.length > 0 && bytes >= budget) {
        return {
          page,
          isDone: false,
          continueCursor: JSON.stringify([module.path, i]),
        };
      }
      page.push(entries[i]);
      bytes += functionSpecPageEntrySize(entries[i]);
    }
    continueCursor = JSON.stringify([module.path, entries.length]);
  }
  return { page, isDone: true, continueCursor };
}

/**
 * A lower bound on the size the backend gives the value that Convex JSON
 * `json` decodes to (`crates/value/src/size.rs`). It counts strings in UTF-16
 * code units; the backend counts UTF-8 bytes, which are never fewer.
 */
export function convexJsonValueSize(json: unknown): number {
  if (json === null || typeof json === "boolean") {
    return 1;
  }
  if (typeof json === "number") {
    return 1 + 8;
  }
  if (typeof json === "string") {
    return 1 + json.length + 1;
  }
  if (Array.isArray(json)) {
    let size = 2;
    for (const item of json) {
      size += convexJsonValueSize(item);
    }
    return size;
  }
  const object = json as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1 && (keys[0] === "$integer" || keys[0] === "$float")) {
    return 1 + 8;
  }
  if (keys.length === 1 && keys[0] === "$bytes") {
    const base64 = String(object.$bytes);
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return 1 + (base64.length / 4) * 3 - padding + 1;
  }
  let size = 2;
  for (const key of keys) {
    size += key.length + 1 + convexJsonValueSize(object[key]);
  }
  return size;
}
