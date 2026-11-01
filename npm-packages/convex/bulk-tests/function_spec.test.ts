// Bulk fork: `fetchFunctionSpecs` pages through `apiSpecPage` and returns what
// `apiSpec` would, falling back to `apiSpec` on backends without it.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexToJson, v } from "../src/values/index.js";
import type { Context } from "../src/bundler/context.js";
import { fetchFunctionSpecs } from "../src/cli/lib/functionSpec.js";

const { runSystemQuery, responses, requests } = vi.hoisted(() => ({
  runSystemQuery: vi.fn(),
  responses: [] as unknown[],
  requests: [] as { path: string; args: unknown }[],
}));
vi.mock("../src/cli/lib/run.js", () => ({ runSystemQuery }));
vi.mock("../src/cli/lib/utils/utils.js", () => ({
  deploymentFetch: () => async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push({ path: body.path, args: body.args });
    return { json: async () => responses.shift() };
  },
}));

const ctx = {
  crash: async (args: { printedMessage: string }) => {
    throw new Error(args.printedMessage);
  },
} as unknown as Context;
const deployment = {
  deploymentUrl: "http://127.0.0.1:3210",
  adminKey: "key",
  componentPath: undefined,
};

const argsJson = JSON.stringify(v.object({ n: v.int64() }).json);
const returnsJson = JSON.stringify(
  v.array(v.object({ text: v.string(), done: v.optional(v.boolean()) })).json,
);

beforeEach(() => {
  responses.length = 0;
  requests.length = 0;
  runSystemQuery.mockReset();
});

describe("fetchFunctionSpecs", () => {
  test("joins pages into the apiSpec shape", async () => {
    responses.push(
      {
        status: "success",
        value: {
          page: [
            {
              identifier: "a.js:list",
              functionType: "Query",
              visibility: { kind: "public" },
              argsJson,
              returnsJson,
            },
          ],
          isDone: false,
          continueCursor: "a.js",
        },
      },
      {
        status: "success",
        value: {
          page: [{ functionType: "HttpAction", method: "GET", path: "/x" }],
          isDone: true,
          continueCursor: "http.js",
        },
      },
    );
    const functions = await fetchFunctionSpecs(ctx, deployment);
    expect(requests).toEqual([
      { path: "_system/cli/modules:apiSpecPage", args: { cursor: null } },
      { path: "_system/cli/modules:apiSpecPage", args: { cursor: "a.js" } },
    ]);
    expect(convexToJson(functions)).toEqual([
      {
        identifier: "a.js:list",
        functionType: "Query",
        visibility: { kind: "public" },
        args: JSON.parse(argsJson),
        returns: JSON.parse(returnsJson),
      },
      { functionType: "HttpAction", method: "GET", path: "/x" },
    ]);
    expect(runSystemQuery).not.toHaveBeenCalled();
  });

  test("asks for a path prefix when given one", async () => {
    responses.push({
      status: "success",
      value: { page: [], isDone: true, continueCursor: null },
    });
    await fetchFunctionSpecs(ctx, { ...deployment, pathPrefix: "orders/" });
    expect(requests).toEqual([
      {
        path: "_system/cli/modules:apiSpecPage",
        args: { cursor: null, pathPrefix: "orders/" },
      },
    ]);
  });

  test("falls back to apiSpec on a backend without apiSpecPage", async () => {
    responses.push({
      status: "error",
      errorMessage:
        'Server Error\nCouldn\'t find "apiSpecPage" in module "_system/cli/modules.js".',
    });
    runSystemQuery.mockResolvedValue([{ identifier: "a.js:list" }]);
    expect(await fetchFunctionSpecs(ctx, deployment)).toEqual([
      { identifier: "a.js:list" },
    ]);
    expect(runSystemQuery.mock.calls[0][1].functionName).toBe(
      "_system/cli/modules:apiSpec",
    );
  });

  test("uses apiSpec for a component", async () => {
    runSystemQuery.mockResolvedValue([]);
    await fetchFunctionSpecs(ctx, { ...deployment, componentPath: "workpool" });
    expect(requests).toEqual([]);
    expect(runSystemQuery.mock.calls[0][1]).toMatchObject({
      functionName: "_system/cli/modules:apiSpec",
      componentPath: "workpool",
    });
  });

  test("reports other errors", async () => {
    responses.push({ status: "error", errorMessage: "Server Error\nboom" });
    await expect(fetchFunctionSpecs(ctx, deployment)).rejects.toThrow(
      "Failed to read the function spec: Server Error\nboom",
    );
    expect(runSystemQuery).not.toHaveBeenCalled();
  });
});
