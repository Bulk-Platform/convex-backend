// Bulk fork: the MCP `functionSpec` tool filters by identifier prefix, can
// leave validators out or return them as compact strings, and refuses results
// over `maxCharacters` with a list of narrower prefixes.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { jsonToConvex, v } from "../src/values/index.js";
import type { RequestContext } from "../src/cli/lib/mcp/requestContext.js";
import {
  compactValidator,
  FunctionSpecTool,
} from "../src/cli/lib/mcp/tools/functionSpec.js";

const { fetchFunctionSpecs } = vi.hoisted(() => ({
  fetchFunctionSpecs: vi.fn(),
}));
vi.mock("../src/cli/lib/functionSpec.js", () => ({ fetchFunctionSpecs }));
vi.mock("../src/cli/lib/api.js", () => ({
  loadSelectedDeploymentCredentials: async () => ({
    url: "http://127.0.0.1:3210",
    adminKey: "key",
  }),
}));
vi.mock("../src/cli/lib/mcp/requestContext.js", () => ({
  getMcpDeploymentSelection: async () => ({}),
}));

const ctx = {
  decodeDeploymentSelectorUnchecked: () => ({
    projectDir: process.cwd(),
    deployment: {},
  }),
  crash: async (args: { printedMessage: string }) => {
    throw new Error(args.printedMessage);
  },
} as unknown as RequestContext;

const argsJson = v.object({ n: v.int64() }).json;
const returnsJson = v.array(v.object({ text: v.string() })).json;
function fn(identifier: string, functionType = "Query") {
  return {
    identifier,
    functionType,
    visibility: { kind: "public" },
    args: argsJson,
    returns: returnsJson,
  };
}
const spec = [
  fn("messages.js:list"),
  fn("messages.js:send", "Mutation"),
  fn("workflow/engine/run.js:start", "Action"),
  fn("workflow/engine/run.js:step", "Action"),
  fn("workflow/defs.js:get"),
  { functionType: "HttpAction", method: "POST", path: "/webhooks/stripe" },
];

async function call(args: Record<string, unknown>) {
  return await FunctionSpecTool.handler(ctx, {
    deploymentSelector: "selector",
    ...args,
  });
}

beforeEach(() => {
  fetchFunctionSpecs.mockReset();
  fetchFunctionSpecs.mockResolvedValue(
    spec.map((entry) => jsonToConvex(entry)),
  );
});

describe("functionSpec MCP tool", () => {
  test("returns the whole spec unchanged by default", async () => {
    expect(await call({})).toEqual(spec);
  });

  test("filters by identifier prefix, with or without .js", async () => {
    const identifiers = async (identifierPrefix: string) =>
      ((await call({ identifierPrefix })) as typeof spec).map((entry) =>
        "identifier" in entry ? entry.identifier : entry.path,
      );
    expect(await identifiers("workflow/engine/")).toEqual([
      "workflow/engine/run.js:start",
      "workflow/engine/run.js:step",
    ]);
    expect(await identifiers("messages:send")).toEqual(["messages.js:send"]);
    expect(await identifiers("messages.js:")).toEqual([
      "messages.js:list",
      "messages.js:send",
    ]);
    expect(await identifiers("/webhooks/")).toEqual(["/webhooks/stripe"]);
    expect(await identifiers("nothing")).toEqual([]);
  });

  test("leaves validators out", async () => {
    expect(
      await call({ identifierPrefix: "messages", includeValidators: false }),
    ).toEqual([
      {
        identifier: "messages.js:list",
        functionType: "Query",
        visibility: { kind: "public" },
      },
      {
        identifier: "messages.js:send",
        functionType: "Mutation",
        visibility: { kind: "public" },
      },
    ]);
  });

  test("returns compact validators", async () => {
    expect(
      await call({
        identifierPrefix: "messages:list",
        validatorFormat: "compact",
      }),
    ).toEqual([
      {
        identifier: "messages.js:list",
        functionType: "Query",
        visibility: { kind: "public" },
        args: "{ n: int64 }",
        returns: "Array<{ text: string }>",
      },
    ]);
    const error = await call({
      validatorFormat: "compact",
      maxCharacters: 100,
    }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).not.toContain("validatorFormat");
    expect(error).toContain("Set includeValidators: false");
  });

  test("refuses a result over maxCharacters and suggests prefixes", async () => {
    const size = JSON.stringify(spec).length;
    expect(await call({ maxCharacters: size })).toEqual(spec);

    const error = await call({ maxCharacters: 500 }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain(
      `The function spec is ${size.toLocaleString("en-US")} characters (6 entries), over maxCharacters (500).`,
    );
    expect(error).toContain('Set validatorFormat: "compact"');
    expect(error).toContain("Set includeValidators: false");
    expect(error).toMatch(/"workflow\/": 3 entries/);
    expect(error).toMatch(/"messages\.js:": 2 entries/);
    expect(error).toMatch(/"\/": 1 entries/);
    // Largest group first.
    expect(error!.indexOf('"workflow/"')).toBeLessThan(
      error!.indexOf('"messages.js:"'),
    );

    const nested = await call({
      identifierPrefix: "workflow/",
      maxCharacters: 500,
    }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(nested).toContain('for identifierPrefix "workflow/"');
    expect(nested).toMatch(/"workflow\/engine\/": 2 entries/);
    expect(nested).toMatch(/"workflow\/defs\.js:": 1 entries/);
  });

  test("a single oversized function only suggests the other options", async () => {
    const error = await call({
      identifierPrefix: "messages.js:list",
      maxCharacters: 50,
    }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain("Set includeValidators: false");
    expect(error).not.toContain("Set identifierPrefix");
    expect(error).toContain("Or raise maxCharacters.");
  });
});

describe("compactValidator", () => {
  test("renders every validator type", () => {
    const validator = v.object({
      id: v.id("users"),
      n: v.number(),
      big: v.int64(),
      ok: v.boolean(),
      data: v.bytes(),
      nothing: v.null(),
      anything: v.any(),
      tags: v.optional(v.array(v.string())),
      kind: v.union(v.literal("a"), v.literal(2), v.literal(3n), v.null()),
      byUser: v.record(v.id("users"), v.object({})),
      "odd-name": v.string(),
    });
    expect(compactValidator(validator.json)).toBe(
      '{ id: Id<"users">, n: number, big: int64, ok: boolean, data: bytes, ' +
        "nothing: null, anything: any, tags?: Array<string>, " +
        'kind: "a" | 2 | 3n | null, byUser: Record<Id<"users">, {}>, ' +
        '"odd-name": string }',
    );
  });
});
