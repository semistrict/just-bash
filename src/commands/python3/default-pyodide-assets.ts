import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PyodideAssets } from "../../types.js";

let defaultAssetsPromise: Promise<PyodideAssets> | undefined;

function resolveVendoredPyodidePath(fileName: string): string {
  return fileURLToPath(
    new URL(`../../../vendor/pyodide/${fileName}`, import.meta.url),
  );
}

async function loadDefaultPyodideAssets(): Promise<PyodideAssets> {
  const functionAdaptersPath = resolveVendoredPyodidePath("function-adapters");
  const sentinelPath = resolveVendoredPyodidePath("sentinel.wasm");
  const stdlibPath = resolveVendoredPyodidePath("python_stdlib.zip");
  const wasmPath = resolveVendoredPyodidePath("pyodide.asm.wasm");
  const lockPath = resolveVendoredPyodidePath("pyodide-lock.json");
  const functionAdapterModules = Object.fromEntries(
    await Promise.all(
      (await readdir(functionAdaptersPath))
        .filter((fileName) => fileName.endsWith(".wasm"))
        .map(async (fileName) => {
          const moduleName = fileName.slice(0, -".wasm".length);
          const bytes = await readFile(`${functionAdaptersPath}/${fileName}`);
          return [moduleName, await WebAssembly.compile(bytes)];
        }),
    ),
  );
  const sentinelBytes = await readFile(sentinelPath);
  const wasmBytes = await readFile(wasmPath);

  return {
    functionAdapterModules,
    indexURL: "https://just-bash.invalid/pyodide/",
    lockFileContents: await readFile(lockPath, "utf8"),
    sentinelModule: await WebAssembly.compile(sentinelBytes),
    stdLibURL: pathToFileURL(stdlibPath).toString(),
    wasmModule: await WebAssembly.compile(wasmBytes),
  };
}

export async function getDefaultPyodideAssets(): Promise<PyodideAssets> {
  defaultAssetsPromise ??= loadDefaultPyodideAssets();
  return defaultAssetsPromise;
}
