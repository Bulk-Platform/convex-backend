import { z } from "zod";
import { ConvexTool } from "./index.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { fetchFunctionSpecs } from "../../functionSpec.js";
import { getMcpDeploymentSelection } from "../requestContext.js";
import {
  convexToJson,
  jsonToConvex,
  JSONValue,
  ValidatorJSON,
} from "../../../../values/index.js";

// Bulk: about 20k tokens, under Claude Code's default 25k-token limit on MCP
// tool output. A small app's spec is well under this; Bulk's is 40 MB.
const DEFAULT_MAX_CHARACTERS = 80_000;
const MAX_SUGGESTIONS = 15;

const inputSchema = z.object({
  deploymentSelector: z
    .string()
    .describe(
      "Deployment selector (from the status tool) to get function metadata from.",
    ),
  identifierPrefix: z
    .string()
    .optional()
    .describe(
      'Only return functions whose identifier starts with this prefix, e.g. "messages" or "folder/file:" (the ".js" in identifiers is optional). HTTP actions are matched on their route path, e.g. "/webhooks/". Omit for all functions.',
    ),
  includeValidators: z
    .boolean()
    .optional()
    .describe(
      "If false, leave out the args and returns validators: return only identifiers, types and visibility. Defaults to true.",
    ),
  validatorFormat: z
    .enum(["json", "compact"])
    .optional()
    .describe(
      'How to return validators. "json" (default) returns validator JSON. "compact" returns each validator as a TypeScript-like string, e.g. "{ id: Id<\\"users\\">, tags?: Array<string> }", usually several times smaller.',
    ),
  maxCharacters: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum size of the JSON result in characters (about 4 per token). Over it, the tool returns an error suggesting narrower prefixes instead of the result. Defaults to ${DEFAULT_MAX_CHARACTERS}.`,
    ),
});

const outputSchema = z
  .any()
  .describe("Function metadata including arguments and return values");

const description = `
Get the function metadata from a Convex deployment.

Returns an array of structured objects for each function the deployment. Each function's
metadata contains its identifier (which is its path within the convex/ folder joined
with its exported name), its argument validator, its return value validator, its type
(i.e. is it a query, mutation, or action), and its visibility (i.e. is it public or
internal).

For a large app, filter with identifierPrefix, set validatorFormat to "compact", or set
includeValidators to false to list functions without their validators. If the result is
over maxCharacters, the tool returns an error listing narrower prefixes and their sizes.
`.trim();

type FunctionSpecEntry = Record<string, unknown>;
type Shape = {
  includeValidators: boolean;
  validatorFormat: "json" | "compact";
};

export const FunctionSpecTool: ConvexTool<
  typeof inputSchema,
  typeof outputSchema
> = {
  name: "functionSpec",
  description,
  inputSchema,
  outputSchema,
  handler: async (ctx, args) => {
    const { projectDir, deployment } = ctx.decodeDeploymentSelectorUnchecked(
      args.deploymentSelector,
    );
    process.chdir(projectDir);
    const deploymentSelection = await getMcpDeploymentSelection(
      ctx,
      deployment,
    );
    const credentials = await loadSelectedDeploymentCredentials(
      ctx,
      deploymentSelection,
    );
    const prefix = args.identifierPrefix ?? "";
    const functions = await fetchFunctionSpecs(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      componentPath: undefined,
      pathPrefix: modulePathPrefix(prefix),
    });
    const shape: Shape = {
      includeValidators: args.includeValidators ?? true,
      validatorFormat: args.validatorFormat ?? "json",
    };
    const maxCharacters = args.maxCharacters ?? DEFAULT_MAX_CHARACTERS;

    const matched: { key: string; entry: FunctionSpecEntry }[] = [];
    for (const entry of convexToJson(functions) as FunctionSpecEntry[]) {
      const key = matchKey(entry, prefix);
      if (key !== null) {
        matched.push({ key, entry });
      }
    }
    const result = matched.map(({ entry }) => shapeEntry(entry, shape));
    const size = JSON.stringify(result).length;
    if (size <= maxCharacters) {
      return result;
    }
    return await ctx.crash({
      exitCode: 1,
      errorType: "fatal",
      printedMessage: tooLargeMessage({
        matched,
        prefix,
        shape,
        size,
        maxCharacters,
      }),
    });
  },
};

// The module path prefix that holds every entry `prefix` can match, so the
// backend reads only those modules. The part before ":" also prefixes the path
// when ".js" is left out, and HTTP routes are all defined in `http.js`.
export function modulePathPrefix(prefix: string): string | undefined {
  if (prefix === "") {
    return undefined;
  }
  if (prefix.startsWith("/")) {
    return "http.js";
  }
  return prefix.split(":")[0];
}

// The string `prefix` matched for this entry, or null. Function identifiers
// look like "folder/file.js:name" and match with or without the ".js"; HTTP
// actions match on their route path.
function matchKey(entry: FunctionSpecEntry, prefix: string): string | null {
  const candidates =
    typeof entry.identifier === "string"
      ? [entry.identifier, entry.identifier.replace(/\.js:/, ":")]
      : typeof entry.path === "string"
        ? [entry.path]
        : [];
  return candidates.find((candidate) => candidate.startsWith(prefix)) ?? null;
}

function shapeEntry(entry: FunctionSpecEntry, shape: Shape): FunctionSpecEntry {
  if (!("args" in entry) && !("returns" in entry)) {
    return entry;
  }
  const { args, returns, ...rest } = entry;
  if (!shape.includeValidators) {
    return rest;
  }
  if (shape.validatorFormat === "json") {
    return entry;
  }
  return {
    ...rest,
    args: compactValidator(args as ValidatorJSON),
    returns: compactValidator(returns as ValidatorJSON),
  };
}

/**
 * A validator as a TypeScript-like string, named after the `v` builders where
 * TypeScript has no equivalent: `{ id: Id<"users">, n?: int64 }`.
 */
export function compactValidator(validator: ValidatorJSON): string {
  switch (validator.type) {
    case "null":
    case "number":
    case "boolean":
    case "string":
    case "bytes":
    case "any":
    case "commitTs":
      return validator.type;
    case "bigint":
      return "int64";
    case "literal":
      return compactLiteral(validator.value);
    case "id":
      return `Id<${JSON.stringify(validator.tableName)}>`;
    case "array":
      return `Array<${compactValidator(validator.value)}>`;
    case "record":
      return `Record<${compactValidator(validator.keys)}, ${compactValidator(validator.values.fieldType)}>`;
    case "object": {
      const fields = Object.entries(validator.value).map(
        ([name, field]) =>
          `${compactFieldName(name)}${field.optional ? "?" : ""}: ${compactValidator(field.fieldType)}`,
      );
      return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
    }
    case "union":
      return validator.value.map(compactValidator).join(" | ");
    default:
      return JSON.stringify(validator);
  }
}

function compactLiteral(value: JSONValue): string {
  const decoded = jsonToConvex(value);
  return typeof decoded === "bigint" ? `${decoded}n` : JSON.stringify(value);
}

function compactFieldName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function tooLargeMessage(args: {
  matched: { key: string; entry: FunctionSpecEntry }[];
  prefix: string;
  shape: Shape;
  size: number;
  maxCharacters: number;
}): string {
  const { matched, prefix, shape, size, maxCharacters } = args;
  const sizeAs = (other: Shape) =>
    JSON.stringify(matched.map(({ entry }) => shapeEntry(entry, other))).length;
  const scope = prefix === "" ? "" : ` for identifierPrefix "${prefix}"`;
  const lines = [
    `The function spec${scope} is ${size.toLocaleString("en-US")} characters (${matched.length.toLocaleString("en-US")} entries), over maxCharacters (${maxCharacters.toLocaleString("en-US")}). Narrow the request:`,
  ];
  if (shape.includeValidators && shape.validatorFormat === "json") {
    const compact = sizeAs({ ...shape, validatorFormat: "compact" });
    lines.push(
      `- Set validatorFormat: "compact" for TypeScript-like validator strings (${compact.toLocaleString("en-US")} characters).`,
    );
  }
  if (shape.includeValidators) {
    const withoutValidators = sizeAs({ ...shape, includeValidators: false });
    lines.push(
      `- Set includeValidators: false for identifiers, types and visibility only (${withoutValidators.toLocaleString("en-US")} characters).`,
    );
  }
  // Group by the next folder, module or function below the prefix.
  const groups = new Map<string, { entries: number; characters: number }>();
  for (const { key, entry } of matched) {
    const rest = key.slice(prefix.length);
    const end = rest.search(/[/:]/);
    const next = end === -1 ? key : prefix + rest.slice(0, end + 1);
    const group = groups.get(next) ?? { entries: 0, characters: 0 };
    group.entries += 1;
    group.characters += JSON.stringify(shapeEntry(entry, shape)).length + 1;
    groups.set(next, group);
  }
  const largest = [...groups.entries()].sort(
    (a, b) => b[1].characters - a[1].characters,
  );
  if (largest.length > 1 || largest[0]?.[0] !== prefix) {
    lines.push(
      `- Set identifierPrefix to one of these (${groups.size.toLocaleString("en-US")} in all, largest first):`,
    );
    for (const [next, group] of largest.slice(0, MAX_SUGGESTIONS)) {
      lines.push(
        `  "${next}": ${group.entries.toLocaleString("en-US")} entries, ${group.characters.toLocaleString("en-US")} characters`,
      );
    }
  }
  lines.push(`- Or raise maxCharacters.`);
  return lines.join("\n");
}
