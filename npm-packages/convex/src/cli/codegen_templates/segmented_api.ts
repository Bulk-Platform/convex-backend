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

type ApiNode =
  | { type: "chunk"; prefix: string[]; modulePaths: string[] }
  | {
      type: "branch";
      self: ApiNode | null;
      children: Map<string, ApiNode>;
    };

export function segmentedApiDeclarations(
  modulePaths: string[],
  opts: { useTypeScript: boolean; maxModulesPerChunk?: number | undefined },
): string {
  const maxModules = opts.maxModulesPerChunk ?? MAX_MODULES_PER_API_CHUNK;
  const taken = new Set(modulePaths.map(moduleIdentifier));
  const uniqueName = (base: string) => {
    let name = base;
    while (taken.has(name)) {
      name = `_${name}`;
    }
    taken.add(name);
    return name;
  };
  const segmentType = uniqueName("ApiSegment");
  const chunkPrefix = uniqueName("fullApi$");

  const chunks: { name: string; modulePaths: string[] }[] = [];
  const root = buildNode([], modulePaths, maxModules, true);

  const nameChunks = (node: ApiNode) => {
    if (node.type === "chunk") {
      chunks.push({
        name: `${chunkPrefix}${chunks.length}`,
        modulePaths: node.modulePaths,
      });
      return;
    }
    if (node.self) {
      nameChunks(node.self);
    }
    for (const child of node.children.values()) {
      nameChunks(child);
    }
  };
  nameChunks(root);
  const chunkNames = new Map(
    chunks.map((chunk) => [chunk.modulePaths, chunk.name]),
  );

  const typeOf = (node: ApiNode, visibility: string): string => {
    if (node.type === "chunk") {
      const name = chunkNames.get(node.modulePaths)!;
      return `${segmentType}<FilterApi<typeof ${name}, FunctionReference<any, "${visibility}">>, ${JSON.stringify(node.prefix)}>`;
    }
    const members = [...node.children].map(
      ([key, child]) => `${JSON.stringify(key)}: ${typeOf(child, visibility)};`,
    );
    const branch = `{\n${members.join("\n")}\n}`;
    if (node === root) {
      // Kept as a plain object type so TypeScript resolves each top-level
      // folder only when it is used.
      return branch;
    }
    // A folder split into several chunks: merge and filter again so it types
    // exactly like the single-chunk shape (empty subfolders dropped).
    const merged = node.self
      ? `${typeOf(node.self, visibility)} & ${branch}`
      : branch;
    return `FilterApi<${merged}, FunctionReference<any, "${visibility}">>`;
  };

  const lines: string[] = [];
  lines.push(
    `type ${segmentType}<T, Path extends string[]> = Path extends [infer Head extends string, ...infer Rest extends string[]] ? (Head extends keyof T ? ${segmentType}<T[Head], Rest> : {}) : T;`,
  );
  for (const chunk of chunks) {
    const entries = chunk.modulePaths
      .map(
        (modulePath) =>
          `  "${importPath(modulePath)}": typeof ${moduleIdentifier(modulePath)},`,
      )
      .join("\n");
    lines.push(
      opts.useTypeScript
        ? `const ${chunk.name}: ApiFromModules<{\n${entries}\n}> = anyApi as any;`
        : `declare const ${chunk.name}: ApiFromModules<{\n${entries}\n}>;`,
    );
  }
  for (const [name, visibility] of [
    ["api", "public"],
    ["internal", "internal"],
  ] as const) {
    lines.push(apiComment(name, visibility));
    lines.push(
      opts.useTypeScript
        ? `export const ${name}: ${typeOf(root, visibility)} = anyApi as any;`
        : `export declare const ${name}: ${typeOf(root, visibility)};`,
    );
  }
  return lines.join("\n");
}

function buildNode(
  prefix: string[],
  modulePaths: string[],
  maxModules: number,
  isRoot: boolean,
): ApiNode {
  if (!isRoot && modulePaths.length <= maxModules) {
    return { type: "chunk", prefix, modulePaths };
  }
  let selfPaths: string[] = [];
  const groups = new Map<string, string[]>();
  for (const modulePath of modulePaths) {
    const parts = importPath(modulePath).split("/");
    if (parts.length === prefix.length) {
      selfPaths = [modulePath];
      continue;
    }
    const key = parts[prefix.length];
    groups.set(key, [...(groups.get(key) ?? []), modulePath]);
  }
  const children = new Map<string, ApiNode>();
  for (const [key, paths] of groups) {
    children.set(key, buildNode([...prefix, key], paths, maxModules, false));
  }
  return {
    type: "branch",
    self:
      selfPaths.length > 0
        ? { type: "chunk", prefix, modulePaths: selfPaths }
        : null,
    children,
  };
}
