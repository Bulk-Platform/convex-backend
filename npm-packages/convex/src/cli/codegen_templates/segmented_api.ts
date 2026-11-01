// Bulk fork: emit `api` / `internal` as one `ApiFromModules` chunk per
// top-level folder instead of a single chunk over every module.
//
// TypeScript evaluates `ApiFromModules<{ ...every module... }>` inside the first
// statement that touches `api`, and that statement has a fixed instantiation
// budget. Past roughly 1,950 modules the type collapses to `never`. Chunking
// keeps the same types (each chunk is still `ApiFromModules` + `FilterApi`)
// while TypeScript only resolves the chunks a file actually uses.

import { importPath, moduleIdentifier } from "./api.js";
import { apiComment } from "./common.js";

/** Folders with more modules than this are split again by their subfolders. */
export const MAX_MODULES_PER_API_CHUNK = 400;

// The backend only accepts `[A-Za-z0-9_.]` in module path components
// (`sync_types/src/path.rs`), so names with a `$` never collide with a module.
const SEGMENT_TYPE = "ApiSegment$";
const CHUNK_PREFIX = "fullApi$";

type Visibility = "public" | "internal";
type Chunk = { name: string; prefix: string[]; modulePaths: string[] };
type ApiNode =
  | { type: "chunk"; chunk: Chunk }
  // A folder over the chunk limit: its own module (`foo.ts` for `foo/`), if
  // any, and its subfolders and modules.
  | { type: "folder"; self: Chunk | null; children: ApiChildren };
type ApiChildren = Map<string, ApiNode>;

export function segmentedApiDeclarations(
  modulePaths: string[],
  opts: { useTypeScript: boolean; maxModulesPerChunk?: number | undefined },
): string {
  const maxModules = opts.maxModulesPerChunk ?? MAX_MODULES_PER_API_CHUNK;
  const chunks: Chunk[] = [];
  const addChunk = (prefix: string[], paths: string[]): Chunk => {
    const chunk = {
      name: `${CHUNK_PREFIX}${chunks.length}`,
      prefix,
      modulePaths: paths,
    };
    chunks.push(chunk);
    return chunk;
  };
  const buildChildren = (prefix: string[], groups: Map<string, string[]>) => {
    const children: ApiChildren = new Map();
    for (const [key, paths] of groups) {
      children.set(key, buildNode([...prefix, key], paths));
    }
    return children;
  };
  const buildNode = (prefix: string[], paths: string[]): ApiNode => {
    if (paths.length <= maxModules) {
      return { type: "chunk", chunk: addChunk(prefix, paths) };
    }
    const { self, groups } = groupByNextSegment(prefix, paths);
    return {
      type: "folder",
      self: self.length > 0 ? addChunk(prefix, self) : null,
      children: buildChildren(prefix, groups),
    };
  };
  // Every module path has at least one segment, so the root is never a module.
  const root = buildChildren([], groupByNextSegment([], modulePaths).groups);

  const declareConst = (nameAndType: string) =>
    opts.useTypeScript
      ? `const ${nameAndType} = anyApi as any;`
      : `declare const ${nameAndType};`;
  const lines = [
    `type ${SEGMENT_TYPE}<T, Path extends string[]> = Path extends [infer Head extends string, ...infer Rest extends string[]] ? (Head extends keyof T ? ${SEGMENT_TYPE}<T[Head], Rest> : {}) : T;`,
  ];
  for (const chunk of chunks) {
    const entries = chunk.modulePaths
      .map(
        (modulePath) =>
          `  "${importPath(modulePath)}": typeof ${moduleIdentifier(modulePath)},`,
      )
      .join("\n");
    lines.push(declareConst(`${chunk.name}: ApiFromModules<{\n${entries}\n}>`));
  }
  for (const [name, visibility] of [
    ["api", "public"],
    ["internal", "internal"],
  ] as const) {
    lines.push(apiComment(name, visibility));
    // The root stays a plain object type so TypeScript resolves each
    // top-level folder only when it is used.
    lines.push(
      `export ${declareConst(`${name}: ${objectType(root, visibility)}`)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Split `paths` under the folder `prefix` into the module at `prefix` itself
 * and groups keyed by the next path segment.
 */
function groupByNextSegment(prefix: string[], paths: string[]) {
  const self: string[] = [];
  const groups = new Map<string, string[]>();
  for (const modulePath of paths) {
    const parts = importPath(modulePath).split("/");
    if (parts.length === prefix.length) {
      self.push(modulePath);
      continue;
    }
    const key = parts[prefix.length];
    const group = groups.get(key);
    if (group) {
      group.push(modulePath);
    } else {
      groups.set(key, [modulePath]);
    }
  }
  return { self, groups };
}

function filterApi(type: string, visibility: Visibility) {
  return `FilterApi<${type}, FunctionReference<any, "${visibility}">>`;
}

function chunkType(chunk: Chunk, visibility: Visibility) {
  return `${SEGMENT_TYPE}<${filterApi(`typeof ${chunk.name}`, visibility)}, ${JSON.stringify(chunk.prefix)}>`;
}

function objectType(children: ApiChildren, visibility: Visibility) {
  const members = [...children].map(
    ([key, child]) => `${JSON.stringify(key)}: ${nodeType(child, visibility)};`,
  );
  return `{\n${members.join("\n")}\n}`;
}

function nodeType(node: ApiNode, visibility: Visibility): string {
  if (node.type === "chunk") {
    return chunkType(node.chunk, visibility);
  }
  // A folder split into several chunks: merge and filter again so it types
  // exactly like the single-chunk shape (empty subfolders dropped).
  const children = objectType(node.children, visibility);
  return filterApi(
    node.self ? `${chunkType(node.self, visibility)} & ${children}` : children,
    visibility,
  );
}
