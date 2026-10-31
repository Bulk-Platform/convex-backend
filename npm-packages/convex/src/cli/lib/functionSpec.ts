// eslint-disable-next-line no-restricted-imports -- chalk used for formatting stdout via logOutput()
import chalk from "chalk";
import { logOutput } from "../../bundler/log.js";
import { runSystemQuery } from "./run.js";
import { Context } from "../../bundler/context.js";
import { deploymentFetch } from "./utils/utils.js";
import { convexToJson, jsonToConvex, Value } from "../../values/value.js";

export async function functionSpecForDeployment(
  ctx: Context,
  options: {
    deploymentUrl: string;
    adminKey: string;
    file: boolean;
  },
) {
  const functions = await fetchFunctionSpecs(ctx, {
    deploymentUrl: options.deploymentUrl,
    adminKey: options.adminKey,
    componentPath: undefined,
  });
  const url = (await runSystemQuery(ctx, {
    deploymentUrl: options.deploymentUrl,
    adminKey: options.adminKey,
    functionName: "_system/cli/convexUrl:cloudUrl",
    componentPath: undefined,
    args: {},
  })) as string;

  const output = JSON.stringify(
    { url, functions: convexToJson(functions) },
    null,
    2,
  );

  if (options.file) {
    const fileName = `function_spec_${Date.now().valueOf()}.json`;
    ctx.fs.writeUtf8File(fileName, output);
    logOutput(chalk.green(`Wrote function spec to ${fileName}`));
  } else {
    logOutput(output);
  }
}

type FunctionSpecPage = {
  page: (
    | {
        identifier: string;
        functionType: string;
        visibility: Value;
        argsJson: string;
        returnsJson: string;
      }
    | { functionType: "HttpAction"; method: string; path: string }
  )[];
  isDone: boolean;
  continueCursor: string | null;
};

/**
 * Bulk: the deployment's function spec, in the shape
 * `_system/cli/modules:apiSpec` returns. Reads the app's spec a page at a time
 * with `apiSpecPage` (Bulk's runtime fork), because one `apiSpec` response for
 * a large app is over the system function result size and value nesting
 * limits. Uses `apiSpec` for a component, and on backends without
 * `apiSpecPage`.
 */
export async function fetchFunctionSpecs(
  ctx: Context,
  args: {
    deploymentUrl: string;
    adminKey: string;
    componentPath: string | undefined;
  },
): Promise<Value[]> {
  const legacyApiSpec = async () =>
    (await runSystemQuery(ctx, {
      deploymentUrl: args.deploymentUrl,
      adminKey: args.adminKey,
      functionName: "_system/cli/modules:apiSpec",
      componentPath: args.componentPath,
      args: {},
    })) as Value[];
  // `/api/query` runs system queries but takes no component path.
  if (args.componentPath !== undefined) {
    return await legacyApiSpec();
  }
  const fetch = deploymentFetch(ctx, {
    deploymentUrl: args.deploymentUrl,
    adminKey: args.adminKey,
  });
  const functions: Value[] = [];
  let cursor: string | null = null;
  for (;;) {
    const response = await fetch("/api/query", {
      method: "POST",
      body: JSON.stringify({
        path: "_system/cli/modules:apiSpecPage",
        args: { cursor },
        format: "convex_encoded_json",
      }),
    });
    const body = (await response.json()) as
      | { status: "success"; value: FunctionSpecPage }
      | { status: "error"; errorMessage: string };
    if (body.status !== "success") {
      if (cursor === null && isMissingApiSpecPage(body.errorMessage)) {
        return await legacyApiSpec();
      }
      return await ctx.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage: `Failed to read the function spec: ${body.errorMessage}`,
      });
    }
    const page = body.value;
    for (const entry of page.page) {
      if ("argsJson" in entry) {
        const { argsJson, returnsJson, ...rest } = entry;
        functions.push({
          ...rest,
          args: jsonToConvex(JSON.parse(argsJson)),
          returns: jsonToConvex(JSON.parse(returnsJson)),
        });
      } else {
        functions.push(entry);
      }
    }
    if (page.isDone) {
      return functions;
    }
    cursor = page.continueCursor;
  }
}

// Backends before Bulk's `apiSpecPage`, including upstream Convex.
function isMissingApiSpecPage(errorMessage: string) {
  return (
    errorMessage.includes("apiSpecPage") &&
    (errorMessage.includes("Couldn't find") ||
      errorMessage.includes("Could not find"))
  );
}
