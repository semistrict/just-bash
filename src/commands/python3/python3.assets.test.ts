import { describe, expect, it } from "vitest";
import { _fingerprintPyodideAssetsForTests } from "./python3.js";
import type { PyodideAssets } from "../../types.js";

describe("python3 asset fingerprinting", () => {
  it("treats equivalent asset wrapper objects as the same configuration", () => {
    const sharedLockContents = '{"packages":[]}';
    const sharedWasmModule = {} as WebAssembly.Module;
    const sharedSentinelModule = {} as WebAssembly.Module;
    const sharedAdapters = {
      v: {} as WebAssembly.Module,
      vi: {} as WebAssembly.Module,
    };

    const first: PyodideAssets = {
      stdLibURL: "https://example.test/python_stdlib.zip",
      indexURL: "https://example.test/",
      lockFileContents: sharedLockContents,
      wasmModule: sharedWasmModule,
      sentinelModule: sharedSentinelModule,
      functionAdapterModules: sharedAdapters,
    };
    const second: PyodideAssets = {
      stdLibURL: "https://example.test/python_stdlib.zip",
      indexURL: "https://example.test/",
      lockFileContents: sharedLockContents,
      wasmModule: sharedWasmModule,
      sentinelModule: sharedSentinelModule,
      functionAdapterModules: {
        v: sharedAdapters.v,
        vi: sharedAdapters.vi,
      },
    };

    expect(_fingerprintPyodideAssetsForTests(first)).toBe(
      _fingerprintPyodideAssetsForTests(second),
    );
  });

  it("changes when the effective asset configuration changes", () => {
    const sharedWasmModule = {} as WebAssembly.Module;
    const base: PyodideAssets = {
      stdLibURL: "https://example.test/python_stdlib.zip",
      indexURL: "https://example.test/",
      lockFileContents: '{"packages":[]}',
      wasmModule: sharedWasmModule,
    };
    const changed: PyodideAssets = {
      ...base,
      stdLibURL: "https://example.test/other_stdlib.zip",
    };

    expect(_fingerprintPyodideAssetsForTests(base)).not.toBe(
      _fingerprintPyodideAssetsForTests(changed),
    );
  });
});
