#!/usr/bin/env node

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json version
const packageJsonPath = join(__dirname, "../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const packageVersion = packageJson.version;

// Read src/index.ts version
const indexTsPath = join(__dirname, "../src/index.ts");
const indexTsContent = readFileSync(indexTsPath, "utf-8");
const versionMatch = indexTsContent.match(
  /^export const version = "(.+)";\s*$/m,
);

if (!versionMatch) {
  console.error(
    'Error: Could not parse version from src/index.ts (expected `export const version = "..."`;).',
  );
  process.exit(1);
}

const tsVersion = versionMatch[1];

// Compare versions. Bulk fork releases publish `<upstream>-bulk.<n>` while
// src/index.ts keeps reporting the upstream version to the backend.
const isBulkRelease = new RegExp(
  `^${tsVersion.replace(/\./g, "\\.")}-bulk\\.\\d+$`,
).test(packageVersion);
if (packageVersion !== tsVersion && !isBulkRelease) {
  console.error(
    `Version mismatch!\n` +
      `  package.json:  ${packageVersion}\n` +
      `  src/index.ts:  ${tsVersion}\n` +
      `\nPlease update src/index.ts to match package.json before publishing.`,
  );
  process.exit(1);
}

console.log(
  `✓ The version in src/index.ts (${packageVersion}) matches package.json`,
);
