import { header } from "./common.js";
import { segmentedApiDeclarations } from "./segmented_api.js";
import { AnalyzedModule } from "../lib/deployApi/modules.js";

export function importPath(modulePath: string) {
  // Replace backslashes with forward slashes.
  const filePath = modulePath.replace(/\\/g, "/");
  // Strip off the file extension.
  const lastDot = filePath.lastIndexOf(".");
  return filePath.slice(0, lastDot === -1 ? undefined : lastDot);
}

export function moduleIdentifier(modulePath: string) {
  // TODO: This encoding is ambiguous (`foo/bar` vs `foo_bar` vs `foo-bar`).
  // Also we should be renaming keywords like `delete`.
  let safeModulePath = importPath(modulePath)
    .replace(/\//g, "_")
    .replace(/-/g, "_");
  // Escape existing variable names in this file
  if (["fullApi", "api", "internal", "components"].includes(safeModulePath)) {
    safeModulePath = `${safeModulePath}_`;
  }
  // Escape reserved words which are legal property names unescaped but are not
  // legal identifiers.
  // see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Lexical_grammar#reserved_words
  const reserved = [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "let",
    "static",
    "yield",
    "await",
    "enum",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
  ];
  if (reserved.includes(safeModulePath)) {
    safeModulePath = `${safeModulePath}_`;
  }
  return safeModulePath;
}

export function apiCodegen(
  modulePaths: string[],
  opts?: {
    useTypeScript?: boolean;
    functions?: Record<string, AnalyzedModule> | undefined;
  },
) {
  const useTypeScript = opts?.useTypeScript ?? false;
  const functions = opts?.functions;
  const imports = modulePaths
    .map(
      (modulePath) =>
        `import type * as ${moduleIdentifier(modulePath)} from "../${importPath(
          modulePath,
        )}.js";`,
    )
    .join("\n");

  if (!useTypeScript) {
    // Generate separate .js and .d.ts files
    const apiDTS = `${header("Generated `api` utility.")}
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
${imports}

${segmentedApiDeclarations(modulePaths, { useTypeScript: false, functions })}
`;

    const apiJS = `${header("Generated `api` utility.")}
  import { anyApi } from "convex/server";

  /**
   * A utility for referencing Convex functions in your app's API.
   *
   * Usage:
   * \`\`\`js
   * const myFunctionReference = api.myModule.myFunction;
   * \`\`\`
   */
  export const api = anyApi;
  export const internal = anyApi;
  `;
    return {
      DTS: apiDTS,
      JS: apiJS,
    };
  } else {
    // Generate combined .ts file
    const apiTS = `${header("Generated `api` utility.")}
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi } from "convex/server";
${imports}

${segmentedApiDeclarations(modulePaths, { useTypeScript: true, functions })}
`;
    return {
      TS: apiTS,
    };
  }
}
