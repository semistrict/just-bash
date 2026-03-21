function installUint8ArrayBase64Polyfill(): void {
  const Uint8ArrayWithFromBase64 = Uint8Array as typeof Uint8Array & {
    fromBase64?: (input: string) => Uint8Array;
  };

  if (typeof Uint8ArrayWithFromBase64.fromBase64 === "function") {
    return;
  }

  Uint8ArrayWithFromBase64.fromBase64 = (input: string): Uint8Array => {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(input, "base64"));
    }

    if (typeof atob === "function") {
      const decoded = atob(input);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
      return bytes;
    }

    throw new Error("Base64 decoding is unavailable in this runtime");
  };
}

export async function ensureVendoredPyodideAsmLoaded(): Promise<void> {
  installUint8ArrayBase64Polyfill();
  // Avoid sharing a module-local Promise across Durable Objects. workerd treats
  // some async resources as context-bound, so per-call loading is safer here.
  // @ts-ignore -- vendored upstream JS runtime consumed via Vite/ESM bundling.
  await import("../../../vendor/pyodide/pyodide.asm.js");
}

export async function importVendoredPyodideModule(): Promise<{
  loadPyodide: (config?: unknown) => Promise<unknown>;
}> {
  installUint8ArrayBase64Polyfill();
  // @ts-ignore -- vendored upstream JS runtime consumed via Vite/ESM bundling.
  return import("../../../vendor/pyodide/pyodide.mjs");
}
