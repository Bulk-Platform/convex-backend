// Bulk: helpers for `_system/cli/modules:apiSpecPage`. They keep the
// validator JSON strings stored in `_modules` as strings instead of parsing
// them into object trees, which for large apps does not fit in the 64 MiB
// isolate heap.
import { UdfType, Visibility } from "../frontend/common";

// The same defaults as `apiSpec` in `modules.ts`.
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
 * until the page reaches `budget` bytes or a module path no longer starts
 * with `pathPrefix`. The budget is checked between entries, so a module bigger
 * than a page is split across pages.
 */
export async function readFunctionSpecPage(
  modules: AsyncIterable<ModuleDoc>,
  start: { path: string; skip: number } | null,
  budget: number,
  pathPrefix: string,
): Promise<FunctionSpecPage> {
  const page: FunctionSpecPageEntry[] = [];
  let bytes = 0;
  let continueCursor = start && JSON.stringify([start.path, start.skip]);
  for await (const module of modules) {
    if (!module.path.startsWith(pathPrefix)) {
      // Paths with the prefix sort together, so none come after this one.
      break;
    }
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
