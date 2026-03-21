import { importVendoredPyodideModule } from "./vendored-pyodide-asm.js";

export async function loadPyodide(config?: unknown): Promise<unknown> {
  const pyodideModule = await importVendoredPyodideModule();
  return pyodideModule.loadPyodide(config);
}
