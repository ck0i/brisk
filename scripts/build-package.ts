import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import solidPlugin from "@opentui/solid/bun-plugin";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_OUTPUT_DIRECTORY = join(ROOT, "dist", "npm");
const BUNDLED_DEPENDENCIES = new Set(["@opentui/solid", "solid-js"]);

interface PackageDocument {
  readonly dependencies: Readonly<Record<string, string>>;
}

export async function buildPackageBundle(
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
): Promise<string> {
  const packageDocument = await readPackageDocument();
  const external = Object.keys(packageDocument.dependencies)
    .filter((name) => !BUNDLED_DEPENDENCIES.has(name))
    .sort();

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "main.ts")],
    outdir: outputDirectory,
    target: "bun",
    format: "esm",
    external,
    plugins: [solidPlugin],
    sourcemap: "none",
    naming: "brisk.js",
  });
  if (!result.success) {
    const detail = result.logs.map((log) => log.message).join("\n");
    throw new Error(`npm executable bundle failed${detail ? `:\n${detail}` : ""}`);
  }
  if (result.outputs.length !== 1) {
    throw new Error(`npm executable bundle produced ${result.outputs.length} files instead of one`);
  }

  const executablePath = join(outputDirectory, "brisk.js");
  if (!(await Bun.file(executablePath).exists())) {
    throw new Error(`npm executable bundle is missing at ${executablePath}`);
  }
  await chmod(executablePath, 0o755);
  return executablePath;
}

async function readPackageDocument(): Promise<PackageDocument> {
  const value: unknown = await Bun.file(join(ROOT, "package.json")).json();
  if (typeof value !== "object" || value === null || !("dependencies" in value)) {
    throw new Error("package.json dependencies are missing");
  }
  const dependencies = value.dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new Error("package.json dependencies must be an object");
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== "string") {
      throw new Error(`package.json dependency ${name} must have a string version`);
    }
  }
  return { dependencies: dependencies as Readonly<Record<string, string>> };
}

if (import.meta.main) {
  await buildPackageBundle()
    .then((path) => process.stdout.write(`Built ${path}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`build-package: ${message}\n`);
      process.exitCode = 1;
    });
}
