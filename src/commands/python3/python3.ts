/**
 * python3 - Execute Python code via Pyodide (Python in WebAssembly)
 *
 * Runs Python inline in the current JS runtime so it works in browser-like
 * environments such as workerd. The Pyodide runtime is cached per filesystem
 * instance and stdout/stderr are streamed through the command context.
 */

import type { IFileSystem, SyncFs } from "../../fs/interface.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { mapToRecord } from "../../helpers/env.js";
import { DefenseInDepthBox } from "../../security/defense-in-depth-box.js";
import { _clearTimeout, _setTimeout } from "../../timers.js";
import { ensureVendoredPyodideAsmLoaded } from "./vendored-pyodide-asm.js";
import { loadPyodide } from "./vendored-pyodide.js";
import type {
  Command,
  CommandContext,
  CommandResult,
  ExecResult,
  PyodideAssets,
} from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

/** Default Python execution timeout in milliseconds */
const DEFAULT_PYTHON_TIMEOUT_MS = 10000;
/** Default Python execution timeout when network is enabled */
const DEFAULT_PYTHON_NETWORK_TIMEOUT_MS = 60000;
const PYODIDE_VERSION = "0.29.3";
const PYTHON_EXECUTOR_SOURCE = `
import json
import ast
import inspect
import importlib.util
import runpy
import sys
import traceback

_cfg = __jb_input
_mode = _cfg["mode"]
_argv0 = _cfg["argv0"]
_args = list(_cfg["args"])

async def _exec_async_source(_source, _filename, _globals):
    _flags = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0)
    _code = compile(_source, _filename, "exec", flags=_flags, dont_inherit=True)
    _result = eval(_code, _globals)
    if inspect.isawaitable(_result):
        await _result

async def _exec_code_mode():
    sys.argv = [_argv0, *_args]
    _globals = {"__name__": "__main__"}
    if _argv0 not in ("-c", "<stdin>"):
        _globals["__file__"] = _argv0
    await _exec_async_source(_cfg["code"], _argv0, _globals)

async def _exec_file_mode():
    sys.argv = [_argv0, *_args]
    _globals = {"__name__": "__main__", "__file__": _cfg["path"]}
    with open(_cfg["path"], "r", encoding="utf-8") as _file:
        _source = _file.read()
    await _exec_async_source(_source, _cfg["path"], _globals)

async def _exec_module_mode():
    _module = _cfg["module"]
    sys.argv = [_module, *_args]
    _spec = importlib.util.find_spec(_module)
    _source = (
        None
        if _spec is None or _spec.loader is None or not hasattr(_spec.loader, "get_source")
        else _spec.loader.get_source(_module)
    )
    if _source is None:
        runpy.run_module(_module, run_name="__main__", alter_sys=True)
        return

    _globals = {
        "__name__": "__main__",
        "__package__": _spec.parent if _spec is not None else None,
        "__spec__": _spec,
    }
    if _spec is not None and _spec.origin:
        _globals["__file__"] = _spec.origin
    await _exec_async_source(_source, _spec.origin or _module, _globals)

try:
    if _mode == "code":
        await _exec_code_mode()
    elif _mode == "file":
        await _exec_file_mode()
    elif _mode == "module":
        await _exec_module_mode()
    else:
        raise ValueError(f"Unsupported execution mode: {_mode}")
    __jb_output = json.dumps({"exitCode": 0, "stderr": ""})
except SystemExit as exc:
    _code = exc.code
    if _code is None:
        _exit_code = 0
        _stderr = ""
    elif isinstance(_code, int):
        _exit_code = _code
        _stderr = ""
    else:
        _exit_code = 1
        _stderr = f"{_code}\\n"
    __jb_output = json.dumps({"exitCode": _exit_code, "stderr": _stderr})
except BaseException:
    __jb_output = json.dumps(
        {"exitCode": 1, "stderr": traceback.format_exc()}
    )
`;

type PythonMode = "code" | "file" | "module";

interface PyodideConfig {
  env?: Record<string, string>;
  indexURL?: string;
  lockFileContents?: string | Promise<unknown>;
  packageBaseUrl?: string;
  stdin?: () => number | string | Uint8Array | null | undefined;
  stdLibURL?: string | Uint8Array | ArrayBuffer;
  stderr?: (output: string) => void;
  stdout?: (output: string) => void;
}

interface PyProxyValue {
  destroy?: () => void;
}

interface PyodideGlobals {
  delete(name: string): void;
  set(name: string, value: unknown): void;
}

interface PyodideInterface {
  FS: unknown;
  globals: PyodideGlobals;
  loadPackage(names: string | string[], options?: { messageCallback?: (msg: string) => void; errorCallback?: (msg: string) => void; checkIntegrity?: boolean }): Promise<void>;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  toPy(value: unknown, options?: { depth?: number }): PyProxyValue;
}

interface PythonExecutionInput {
  mode: PythonMode;
  argv0: string;
  args: string[];
  code?: string;
  module?: string;
  path?: string;
}

interface PythonExecutionOutput {
  exitCode: number;
  stderr: string;
}

interface ParsedArgs {
  code: string | null;
  module: string | null;
  scriptFile: string | null;
  showVersion: boolean;
  scriptArgs: string[];
}

interface PyodideFs {
  analyzePath(path: string): { exists: boolean };
  chdir(path: string): void;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  isLink(mode: number): boolean;
  lstat(path: string): { mode: number };
  mkdir(path: string): void;
  readFile(path: string, options?: { encoding?: string }): Uint8Array | string;
  readdir(path: string): string[];
  readlink(path: string): string;
  rmdir(path: string): void;
  symlink(target: string, path: string): void;
  unlink(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
}

interface PyodideStreamApi {
  setInterruptBuffer(buffer: Int32Array | Uint8Array | undefined): void;
  setStderr(options?: {
    raw?: (charCode: number) => void;
    batched?: (output: string) => void;
  }): void;
  setStdout(options?: {
    raw?: (charCode: number) => void;
    batched?: (output: string) => void;
  }): void;
  setStdin(options?: {
    read?: (buffer: Uint8Array) => number;
    isatty?: boolean;
    autoEOF?: boolean;
  }): void;
}

interface PythonRuntime {
  ioState: RuntimeIoState;
  pyodide: PyodideInterface;
  pyodideFs: PyodideFs;
  streamApi: PyodideStreamApi;
  version: string;
}

interface RuntimeIoState {
  readStdinChunk: () => number | string | Uint8Array | null | undefined;
  writeStderr: (chunk: string) => void;
  writeStdout: (chunk: string) => void;
}

function summarizeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      type: error.constructor.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    let json: string | undefined;
    try {
      json = JSON.stringify(error);
    } catch {
      json = undefined;
    }
    return {
      type: record.constructor?.name ?? "Object",
      name: record.name,
      message: record.message,
      keys: Object.keys(record),
      json,
      string: String(error),
    };
  }

  return {
    type: typeof error,
    string: String(error),
  };
}

declare global {
  var _createPyodideModule: unknown;
}

type CreatePyodideModule = (
  moduleArg?: Record<string, unknown>,
) => Promise<PyodideInterface>;

interface SentinelImport extends Record<string, WebAssembly.ImportValue> {
  create_sentinel: () => symbol;
  is_sentinel: (value: unknown) => boolean;
}

type WasmValueType = "externref" | "f32" | "f64" | "i32" | "i64";
type WasmFunctionDescriptor = {
  parameters?: WasmValueType[];
  results?: WasmValueType[];
};

const python3Help = {
  name: "python3",
  summary: "Execute Python code via Pyodide",
  usage: "python3 [OPTIONS] [-c CODE | -m MODULE | FILE] [ARGS...]",
  description: [
    "Execute Python code using Pyodide compiled to WebAssembly.",
    "",
    "This command runs Python inline with access to the virtual filesystem.",
    "Standard output and standard error stream while the program runs.",
  ],
  options: [
    "-c CODE     Execute CODE as Python script",
    "-m MODULE   Run library module as a script",
    "--version   Show Python version",
    "--help      Show this help",
  ],
  examples: [
    'python3 -c "print(1 + 2)"',
    'python3 -c "import sys; print(sys.version)"',
    "python3 script.py",
    "python3 script.py arg1 arg2",
    "echo 'print(\"hello\")' | python3",
  ],
  notes: [
    "Pyodide runs inline in the current runtime. Each invocation creates a fresh Python environment.",
    "Standard library modules are available (no pip install).",
    "Streaming output follows the shell pipeline instead of buffering until process exit.",
  ],
};

/** Serialization queue per filesystem — Pyodide is single-threaded. */
let executionQueues = new WeakMap<IFileSystem, Promise<void>>();

/** @internal Reset runtime state — for tests only */
export function _resetExecutionQueue(): void {
  executionQueues = new WeakMap();
}

function parseArgs(args: string[]): ParsedArgs | ExecResult {
  const result: ParsedArgs = {
    code: null,
    module: null,
    scriptFile: null,
    showVersion: false,
    scriptArgs: [],
  };

  if (args.length === 0) {
    return result;
  }

  const firstArgIndex = args.findIndex((arg) => {
    return !arg.startsWith("-") || arg === "-" || arg === "--";
  });

  for (
    let i = 0;
    i < (firstArgIndex === -1 ? args.length : firstArgIndex);
    i++
  ) {
    const arg = args[i];

    if (arg === "-c") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'c'\n",
          exitCode: 2,
        };
      }
      result.code = args[i + 1];
      result.scriptArgs = args.slice(i + 2);
      return result;
    }

    if (arg === "-m") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'm'\n",
          exitCode: 2,
        };
      }
      result.module = args[i + 1];
      result.scriptArgs = args.slice(i + 2);
      return result;
    }

    if (arg === "--version" || arg === "-V") {
      result.showVersion = true;
      return result;
    }

    // Accept common CPython flags as no-ops (e.g. -u unbuffered, -B no .pyc)
    if (/^-[uBsSEORI]+$/.test(arg)) {
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      return {
        stdout: "",
        stderr: `python3: unrecognized option '${arg}'\n`,
        exitCode: 2,
      };
    }
  }

  if (firstArgIndex !== -1) {
    const arg = args[firstArgIndex];
    if (arg === "--") {
      if (firstArgIndex + 1 < args.length) {
        result.scriptFile = args[firstArgIndex + 1];
        result.scriptArgs = args.slice(firstArgIndex + 2);
      }
    } else {
      result.scriptFile = arg;
      result.scriptArgs = args.slice(firstArgIndex + 1);
    }
  }

  return result;
}

function normalizeAssetUrl(url: string): string {
  if (/^[a-z]+:/i.test(url)) {
    return url;
  }

  const locationHref =
    typeof globalThis.location === "object" &&
    globalThis.location &&
    typeof globalThis.location.href === "string"
      ? globalThis.location.href
      : undefined;

  if (locationHref) {
    return new URL(url, locationHref).toString();
  }

  return url;
}

function deriveIndexUrl(stdLibURL: string): string {
  return stdLibURL.slice(0, stdLibURL.lastIndexOf("/") + 1);
}

const objectFingerprintIds = new WeakMap<object, number>();
let nextObjectFingerprintId = 1;

function getObjectFingerprintId(value: object): number {
  let id = objectFingerprintIds.get(value);
  if (!id) {
    id = nextObjectFingerprintId++;
    objectFingerprintIds.set(value, id);
  }
  return id;
}

function fingerprintUnknown(value: unknown): string {
  if (typeof value === "string") return `str:${value}`;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return `${typeof value}:${String(value)}`;
  }
  if (typeof value === "object" || typeof value === "function") {
    return `ref:${getObjectFingerprintId(value)}`;
  }
  return `${typeof value}:${String(value)}`;
}

function fingerprintFunctionAdapterModules(
  modules: Record<string, WebAssembly.Module> | undefined,
): string {
  if (!modules) return "none";
  const keys = Object.keys(modules).sort();
  return keys.map((key) => `${key}:${fingerprintUnknown(modules[key])}`).join("|");
}

export function _fingerprintPyodideAssetsForTests(
  assets: PyodideAssets,
): string {
  return [
    `stdlib:${fingerprintUnknown(assets.stdLibURL)}`,
    `index:${assets.indexURL ?? ""}`,
    `lock:${fingerprintUnknown(assets.lockFileContents)}`,
    `wasm:${fingerprintUnknown(assets.wasmModule)}`,
    `sentinel:${fingerprintUnknown(assets.sentinelModule)}`,
    `init:${fingerprintUnknown(assets.initWasm)}`,
    `adapters:${fingerprintFunctionAdapterModules(assets.functionAdapterModules)}`,
  ].join(";");
}

async function getPyodideAssets(ctx?: CommandContext): Promise<PyodideAssets> {
  if (ctx?.pyodideAssets) {
    const stdLibURL = typeof ctx.pyodideAssets.stdLibURL === "string"
      ? normalizeAssetUrl(ctx.pyodideAssets.stdLibURL)
      : ctx.pyodideAssets.stdLibURL;
    return {
      ...ctx.pyodideAssets,
      indexURL:
        ctx.pyodideAssets.indexURL !== undefined
          ? normalizeAssetUrl(ctx.pyodideAssets.indexURL)
          : typeof stdLibURL === "string" ? deriveIndexUrl(stdLibURL) : undefined,
      stdLibURL,
    };
  }

  const { getDefaultPyodideAssets } = await DefenseInDepthBox.runTrustedAsync(
    async () =>
      import(
        "./default-pyodide-assets.js"
      ),
  );
  const assets = await DefenseInDepthBox.runTrustedAsync(async () =>
    getDefaultPyodideAssets(),
  );
  const stdLibURL = typeof assets.stdLibURL === "string"
    ? normalizeAssetUrl(assets.stdLibURL)
    : assets.stdLibURL;
  const indexURL = assets.indexURL !== undefined
    ? normalizeAssetUrl(assets.indexURL)
    : typeof stdLibURL === "string" ? deriveIndexUrl(stdLibURL) : undefined;
  return {
    ...assets,
    indexURL,
    stdLibURL,
  };
}

function ensureCloudflareCompatibleWasmLoader(
  assets: PyodideAssets,
): void {
  installWebAssemblyFunctionPolyfill(assets);

  const createPyodideModule = globalThis._createPyodideModule;
  if (typeof createPyodideModule !== "function") {
    throw new Error("Pyodide bootstrap module did not register correctly");
  }

  const wrappedCreatePyodideModule = createPyodideModule as CreatePyodideModule & {
    __jbCloudflareWrapped?: boolean;
  };

  if (wrappedCreatePyodideModule.__jbCloudflareWrapped) {
    return;
  }

  const originalCreatePyodideModule =
    wrappedCreatePyodideModule as CreatePyodideModule;
  const sentinelImportPromise = getSentinelImport(assets);

  const instantiateWasm = (
    imports: WebAssembly.Imports,
    receiveInstance: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ): Record<string, never> => {
    void (async () => {
      imports.sentinel = await sentinelImportPromise;

      if (assets.initWasm) {
        const instance = await assets.initWasm(imports);
        receiveInstance(
          instance,
          undefined as unknown as WebAssembly.Module,
        );
        return;
      }

      if (!assets.wasmModule) {
        throw new Error("Pyodide assets must provide wasmModule or initWasm");
      }

      const instance = await WebAssembly.instantiate(
        assets.wasmModule,
        imports,
      );
      receiveInstance(instance, assets.wasmModule);
    })().catch((error) => {
      console.error("[just-bash/python3] instantiateWasm:error", error);
    });
    return {};
  };

  const wrapped = (async (
    moduleArg: Record<string, unknown> = {},
  ): Promise<PyodideInterface> => {
    return originalCreatePyodideModule({
      ...moduleArg,
      instantiateWasm,
    });
  }) as CreatePyodideModule & {
    __jbCloudflareWrapped?: boolean;
  };

  wrapped.__jbCloudflareWrapped = true;
  globalThis._createPyodideModule = wrapped;
}

const polyfilledFunctionTypes = new WeakMap<Function, WasmFunctionDescriptor>();
const polyfilledFunctionCache = new WeakMap<
  Function,
  Map<string, (...args: unknown[]) => unknown>
>();

function installWebAssemblyFunctionPolyfill(assets: PyodideAssets): void {
  const webAssemblyWithPolyfill = WebAssembly as typeof WebAssembly & {
    Function?: new (
      type: WasmFunctionDescriptor,
      callback: (...args: unknown[]) => unknown,
    ) => (...args: unknown[]) => unknown;
    __jbFunctionProbeInstalled?: boolean;
  };

  if (typeof webAssemblyWithPolyfill.Function === "function") {
    return;
  }

  if (!assets.functionAdapterModules) {
    throw new Error("Pyodide assets must provide functionAdapterModules");
  }

  if (webAssemblyWithPolyfill.__jbFunctionProbeInstalled) {
    return;
  }

  const FunctionPolyfill = function (
    this: unknown,
    type: WasmFunctionDescriptor,
    callback: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => unknown {
    const signature = descriptorToCanonicalSignature(type);
    const module = assets.functionAdapterModules?.[signature];
    if (!module) {
      throw new Error(
        `Missing static WebAssembly.Function adapter for signature ${signature}`,
      );
    }

    let wrappedBySignature = polyfilledFunctionCache.get(callback);
    if (!wrappedBySignature) {
      wrappedBySignature = new Map();
      polyfilledFunctionCache.set(callback, wrappedBySignature);
    }

    const cachedWrappedFunction = wrappedBySignature.get(signature);
    if (cachedWrappedFunction) {
      return cachedWrappedFunction;
    }

    const instance = new WebAssembly.Instance(module, { e: { f: callback } });
    const wrappedFunction = instance.exports.f as (...args: unknown[]) => unknown;
    polyfilledFunctionTypes.set(wrappedFunction, {
      parameters: [...(type.parameters ?? [])],
      results: [...(type.results ?? [])],
    });
    wrappedBySignature.set(signature, wrappedFunction);
    return wrappedFunction;
  } as unknown as new (
    type: WasmFunctionDescriptor,
    callback: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => unknown;

  Object.defineProperty(FunctionPolyfill, "type", {
    value: (wasmFunction: Function): WasmFunctionDescriptor => {
      const type = polyfilledFunctionTypes.get(wasmFunction);
      if (type) {
        return type;
      }

      const reflectedType = (
        wasmFunction as Function & {
          type?: () => WasmFunctionDescriptor;
        }
      ).type;
      if (typeof reflectedType === "function") {
        return reflectedType.call(wasmFunction);
      }

      throw new Error("No type reflection");
    },
  });

  webAssemblyWithPolyfill.Function = FunctionPolyfill;
  webAssemblyWithPolyfill.__jbFunctionProbeInstalled = true;
}

function descriptorToCanonicalSignature(type: WasmFunctionDescriptor): string {
  const results = type.results ?? [];
  if (results.length > 1) {
    throw new Error(
      `Unsupported multi-result WebAssembly.Function signature: ${JSON.stringify(type)}`,
    );
  }

  return `${results[0] ? wasmValueTypeToSigChar(results[0]) : "v"}${(type.parameters ?? [])
    .map(wasmValueTypeToSigChar)
    .join("")}`;
}

function wasmValueTypeToSigChar(type: WasmValueType): string {
  switch (type) {
    case "i32":
      return "i";
    case "i64":
      return "j";
    case "f32":
      return "f";
    case "f64":
      return "d";
    case "externref":
      return "e";
    default:
      throw new Error(`Unsupported WebAssembly value type: ${String(type)}`);
  }
}

function createSentinelFallback(): SentinelImport {
  const errorMarker = Symbol("error marker");
  return {
    create_sentinel: () => errorMarker,
    is_sentinel: (value: unknown): boolean => value === errorMarker,
  };
}

function isIOSWorkaroundNeeded(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" &&
      typeof navigator.maxTouchPoints !== "undefined" &&
      navigator.maxTouchPoints > 1)
  );
}

async function getSentinelImport(
  assets: PyodideAssets,
): Promise<SentinelImport> {
  if (isIOSWorkaroundNeeded() || !assets.sentinelModule) {
    return createSentinelFallback();
  }

  try {
    const instance = await WebAssembly.instantiate(assets.sentinelModule);
    return instance.exports as unknown as SentinelImport;
  } catch (error) {
    if (error instanceof WebAssembly.CompileError) {
      return createSentinelFallback();
    }
    throw error;
  }
}

/**
 * Extract a SyncFs from an IFileSystem. Both InMemoryFs and SqliteFs implement
 * SyncFs directly. Throws if the filesystem doesn't provide sync access.
 */
function getSyncFs(fs: IFileSystem): SyncFs {
  const sync = fs as unknown as SyncFs;
  if (typeof sync.existsSync !== "function" || typeof sync.lstatSync !== "function") {
    throw new Error(
      "python3 requires a filesystem that implements SyncFs (e.g., InMemoryFs, SqliteFs)",
    );
  }
  return sync;
}

/**
 * Emscripten FS type definitions for the JBFS mount.
 * Based on the same pattern as createHOSTFS in worker.ts.
 */

interface EmscriptenNode {
  name: string;
  mode: number;
  parent: EmscriptenNode;
  mount: EmscriptenMount;
  id: number;
  node_ops?: EmscriptenNodeOps;
  stream_ops?: EmscriptenStreamOps;
}

interface EmscriptenStream {
  node: EmscriptenNode;
  flags: number;
  position: number;
  filePtr?: number;
}

interface EmscriptenMount {
  opts: { root: string };
}

interface EmscriptenNodeOps {
  getattr: (node: EmscriptenNode) => EmscriptenStat;
  setattr: (
    node: EmscriptenNode,
    attr: { mode?: number; size?: number },
  ) => void;
  lookup: (parent: EmscriptenNode, name: string) => EmscriptenNode;
  mknod: (
    parent: EmscriptenNode,
    name: string,
    mode: number,
    dev: number,
  ) => EmscriptenNode;
  rename: (
    oldNode: EmscriptenNode,
    newDir: EmscriptenNode,
    newName: string,
  ) => void;
  unlink: (parent: EmscriptenNode, name: string) => void;
  rmdir: (parent: EmscriptenNode, name: string) => void;
  readdir: (node: EmscriptenNode) => string[];
  symlink: (parent: EmscriptenNode, newName: string, oldPath: string) => void;
  readlink: (node: EmscriptenNode) => string;
}

interface EmscriptenStreamOps {
  open: (stream: EmscriptenStream) => void;
  close: (stream: EmscriptenStream) => void;
  fsync: (stream: EmscriptenStream) => void;
  read: (
    stream: EmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  write: (
    stream: EmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  llseek: (stream: EmscriptenStream, offset: number, whence: number) => number;
}

interface EmscriptenStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  blksize: number;
  blocks: number;
}

interface EmscriptenFSApi {
  isDir: (mode: number) => boolean;
  isFile: (mode: number) => boolean;
  isLink: (mode: number) => boolean;
  createNode: (
    parent: EmscriptenNode | null,
    name: string,
    mode: number,
    dev?: number,
  ) => EmscriptenNode;
  ErrnoError: new (errno: number) => Error;
  mount: (
    type: EmscriptenFSType,
    opts: { root: string },
    mountpoint: string,
  ) => void;
}

interface EmscriptenFSType {
  mount: (mount: EmscriptenMount) => EmscriptenNode;
  createNode: (
    parent: EmscriptenNode | null,
    name: string,
    mode: number,
    dev?: number,
  ) => EmscriptenNode;
  node_ops: EmscriptenNodeOps;
  stream_ops: EmscriptenStreamOps;
}

/** Simple POSIX path join — avoids dependency on Emscripten's PATH module. */
const emscriptenPATH = {
  join(...paths: string[]): string {
    return paths
      .filter(Boolean)
      .join("/")
      .replace(/\/+/g, "/");
  },
  join2(path1: string, path2: string): string {
    return `${path1}/${path2}`.replace(/\/+/g, "/");
  },
};

// @banned-pattern-ignore: prototype nulled below; Emscripten errno codes
const JBFS_ERRNO_CODES: Record<string, number> = Object.assign(
  Object.create(null) as Record<string, number>,
  {
    EPERM: 63,
    ENOENT: 44,
    EIO: 29,
    EBADF: 8,
    EAGAIN: 6,
    EACCES: 2,
    EBUSY: 10,
    EEXIST: 20,
    ENOTDIR: 54,
    EISDIR: 31,
    EINVAL: 28,
    EMFILE: 33,
    ENOSPC: 51,
    ESPIPE: 70,
    EROFS: 69,
    ENOTEMPTY: 55,
    ENOSYS: 52,
    ENOTSUP: 138,
    ENODATA: 42,
  },
);

/**
 * Create a JBFS (just-bash filesystem) Emscripten FS backend that delegates
 * directly to an IFileSystem instance. Both bash and Python operate on the
 * same filesystem object — no copying or syncing required.
 *
 * Adapted from createHOSTFS in worker.ts but calls SyncFs methods directly
 * instead of SyncBackend.
 */
function createJBFS(
  sync: SyncFs,
  FS: EmscriptenFSApi,
): EmscriptenFSType {
  function realPath(node: EmscriptenNode): string {
    const parts: string[] = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    parts.push(node.mount.opts.root);
    parts.reverse();
    return emscriptenPATH.join(...parts);
  }

  function tryFSOperation<T>(f: () => T): T {
    try {
      return f();
    } catch (e: unknown) {
      const msg =
        (e as Error)?.message?.toLowerCase() ||
        (typeof e === "string" ? e.toLowerCase() : "");
      let code = JBFS_ERRNO_CODES.EIO;
      if (msg.includes("no such file") || msg.includes("not found") || msg.includes("enoent")) {
        code = JBFS_ERRNO_CODES.ENOENT;
      } else if (msg.includes("is a directory")) {
        code = JBFS_ERRNO_CODES.EISDIR;
      } else if (msg.includes("not a directory")) {
        code = JBFS_ERRNO_CODES.ENOTDIR;
      } else if (msg.includes("already exists") || msg.includes("eexist")) {
        code = JBFS_ERRNO_CODES.EEXIST;
      } else if (msg.includes("permission")) {
        code = JBFS_ERRNO_CODES.EACCES;
      } else if (msg.includes("not empty")) {
        code = JBFS_ERRNO_CODES.ENOTEMPTY;
      }
      throw new FS.ErrnoError(code);
    }
  }

  function getMode(path: string): number {
    return tryFSOperation(() => {
      const stat = sync.lstatSync(path);
      let mode = stat.mode & 0o777;
      if (stat.isDirectory) {
        mode |= 0o40000; // S_IFDIR
      } else if (stat.isSymbolicLink) {
        mode |= 0o120000; // S_IFLNK
      } else {
        mode |= 0o100000; // S_IFREG
      }
      return mode;
    });
  }

  const JBFS: EmscriptenFSType = {
    mount(_mount: EmscriptenMount) {
      return JBFS.createNode(null, "/", 0o40755, 0);
    },

    createNode(
      parent: EmscriptenNode | null,
      name: string,
      mode: number,
      dev?: number,
    ) {
      if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
        throw new FS.ErrnoError(JBFS_ERRNO_CODES.EINVAL);
      }
      const node = FS.createNode(parent, name, mode, dev);
      node.node_ops = JBFS.node_ops;
      node.stream_ops = JBFS.stream_ops;
      return node;
    },

    node_ops: {
      getattr(node: EmscriptenNode) {
        const path = realPath(node);
        return tryFSOperation(() => {
          const stat = sync.lstatSync(path);
          let mode = stat.mode & 0o777;
          if (stat.isDirectory) {
            mode |= 0o40000;
          } else if (stat.isSymbolicLink) {
            mode |= 0o120000;
          } else {
            mode |= 0o100000;
          }
          return {
            dev: 1,
            ino: node.id,
            mode,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: stat.size,
            atime: stat.mtime,
            mtime: stat.mtime,
            ctime: stat.mtime,
            blksize: 4096,
            blocks: Math.ceil(stat.size / 512),
          };
        });
      },

      setattr(node: EmscriptenNode, attr: { mode?: number; size?: number }) {
        const path = realPath(node);
        const mode = attr.mode;
        if (mode !== undefined) {
          tryFSOperation(() => sync.chmodSync(path, mode));
          node.mode = mode;
        }
        if (attr.size !== undefined) {
          tryFSOperation(() => {
            const O_WRONLY = 1;
            const ptr = sync.open(path, O_WRONLY);
            try {
              sync.ftruncate(ptr, attr.size!);
            } finally {
              sync.close(ptr);
            }
          });
        }
      },

      lookup(parent: EmscriptenNode, name: string) {
        const path = emscriptenPATH.join2(realPath(parent), name);
        const mode = getMode(path);
        return JBFS.createNode(parent, name, mode);
      },

      mknod(parent: EmscriptenNode, name: string, mode: number, _dev: number) {
        const node = JBFS.createNode(parent, name, mode, _dev);
        const path = realPath(node);
        tryFSOperation(() => {
          if (FS.isDir(node.mode)) {
            sync.mkdirSync(path);
          } else {
            sync.writeFileSync(path, new Uint8Array(0));
          }
        });
        return node;
      },

      rename(oldNode: EmscriptenNode, newDir: EmscriptenNode, newName: string) {
        const oldPath = realPath(oldNode);
        const newPath = emscriptenPATH.join2(realPath(newDir), newName);
        tryFSOperation(() => {
          sync.mvSync(oldPath, newPath);
        });
        oldNode.name = newName;
      },

      unlink(parent: EmscriptenNode, name: string) {
        const path = emscriptenPATH.join2(realPath(parent), name);
        tryFSOperation(() => sync.rmSync(path));
      },

      rmdir(parent: EmscriptenNode, name: string) {
        const path = emscriptenPATH.join2(realPath(parent), name);
        tryFSOperation(() => sync.rmSync(path));
      },

      readdir(node: EmscriptenNode) {
        const path = realPath(node);
        return tryFSOperation(() => sync.readdirSync(path));
      },

      symlink(parent: EmscriptenNode, newName: string, oldPath: string) {
        const newPath = emscriptenPATH.join2(realPath(parent), newName);
        tryFSOperation(() => sync.symlinkSync(oldPath, newPath));
      },

      readlink(node: EmscriptenNode) {
        const path = realPath(node);
        return tryFSOperation(() => sync.readlinkSync(path));
      },
    },

    stream_ops: {
      open(stream: EmscriptenStream) {
        if (FS.isDir(stream.node.mode)) return;
        const path = realPath(stream.node);
        stream.filePtr = tryFSOperation(() => sync.open(path, stream.flags));

        const O_APPEND = 1024;
        if (stream.flags & O_APPEND) {
          stream.position = sync.fstat(stream.filePtr).size;
        }
      },

      close(stream: EmscriptenStream) {
        if (stream.filePtr != null) {
          sync.close(stream.filePtr);
          stream.filePtr = undefined;
        }
      },

      fsync() {
        // No-op: all writes already flushed to the backing store.
      },

      read(
        stream: EmscriptenStream,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        if (stream.filePtr == null) return 0;
        return tryFSOperation(() => sync.read(stream.filePtr!, buffer, offset, length, position));
      },

      write(
        stream: EmscriptenStream,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        if (stream.filePtr == null) return 0;
        return tryFSOperation(() => sync.write(stream.filePtr!, buffer, offset, length, position));
      },

      llseek(stream: EmscriptenStream, offset: number, whence: number) {
        const SEEK_CUR = 1;
        const SEEK_END = 2;

        let position = offset;
        if (whence === SEEK_CUR) {
          position += stream.position;
        } else if (whence === SEEK_END) {
          if (FS.isFile(stream.node.mode) && stream.filePtr != null) {
            position += sync.fstat(stream.filePtr).size;
          }
        }

        if (position < 0) {
          throw new FS.ErrnoError(JBFS_ERRNO_CODES.EINVAL);
        }

        return position;
      },
    },
  };

  return JBFS;
}

async function createRuntime(
  hostFs: IFileSystem,
  assets: PyodideAssets,
): Promise<PythonRuntime> {
  return DefenseInDepthBox.runTrustedAsync(async () => {
    await ensureVendoredPyodideAsmLoaded();
    ensureCloudflareCompatibleWasmLoader(assets);

    const ioState: RuntimeIoState = {
      readStdinChunk: () => undefined,
      writeStderr: () => {},
      writeStdout: () => {},
    };

    const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";

    const config: PyodideConfig = {
      indexURL: assets.indexURL,
      lockFileContents: assets.lockFileContents,
      packageBaseUrl: PYODIDE_CDN,
      stdLibURL: assets.stdLibURL,
      stdin: () => ioState.readStdinChunk(),
      stdout: (output) => ioState.writeStdout(output),
      stderr: (output) => ioState.writeStderr(output),
      env: {
        HOME: "/home/user",
        PYTHONINSPECT: "0",
      },
    };

    const pyodide = (await loadPyodide(config)) as PyodideInterface &
      PyodideStreamApi;

    // Load micropip for runtime package installation from PyPI.
    // checkIntegrity: false — workerd doesn't support the fetch() integrity option.
    await pyodide.loadPackage("micropip", { checkIntegrity: false });

    const pyodideFs = pyodide.FS as PyodideFs;
    const streamApi = pyodide;

    // Mount the shared IFileSystem at /home so bash and Python share the same
    // filesystem with zero copying. Pyodide keeps its own MEMFS for runtime
    // paths (/lib, /dev, /proc, /tmp).
    const sync = getSyncFs(hostFs);
    const emscriptenFs = pyodide.FS as unknown as EmscriptenFSApi;
    const jbfs = createJBFS(sync, emscriptenFs);

    // Mount JBFS at /home and /tmp so both bash and Python share the same
    // filesystem at these paths. Pyodide keeps MEMFS for /lib, /dev, /proc.
    const mountPoints = ["/home", "/tmp"];
    for (const mountPoint of mountPoints) {
      if (!sync.existsSync(mountPoint)) {
        sync.mkdirSync(mountPoint, { recursive: true });
      }
      try {
        (emscriptenFs as unknown as { unmount: (path: string) => void }).unmount(mountPoint);
      } catch {
        // may not be a mount point — that's fine
      }
      emscriptenFs.mount(jbfs, { root: mountPoint }, mountPoint);
    }

    const version = String(
      pyodide.runPython("import sys; sys.version.split()[0]"),
    );

    return {
      ioState,
      pyodide,
      pyodideFs,
      streamApi,
      version,
    };
  });
}

/**
 * Serialize Python executions per filesystem — Pyodide is single-threaded.
 * Each call creates a fresh runtime (no caching). DOs hibernate after ~10s
 * of inactivity which destroys all in-memory state anyway, making a runtime
 * cache useless for typical chat interactions.
 */
async function withSerializedRuntime<T>(
  fs: IFileSystem,
  assets: PyodideAssets,
  callback: (runtime: PythonRuntime) => Promise<T>,
): Promise<T> {
  const previous = executionQueues.get(fs) ?? Promise.resolve();

  let release: (() => void) | undefined;
  executionQueues.set(fs, new Promise<void>((resolve) => {
    release = resolve;
  }));

  await previous;

  try {
    const runtime = await createRuntime(fs, assets);
    return await callback(runtime);
  } finally {
    release?.();
  }
}

function createStreamingWriter(
  writer: (chunk: string) => Promise<void>,
): {
  push: (chunk: string) => void;
  flush: () => Promise<void>;
} {
  let pending = Promise.resolve();
  let buffered = "";

  return {
    push(chunk) {
      buffered += chunk;

      if (!chunk.includes("\n")) {
        return;
      }

      const nextChunk = buffered;
      buffered = "";
      pending = pending.then(() => writer(nextChunk));
    },
    async flush() {
      if (buffered.length > 0) {
        const nextChunk = buffered;
        buffered = "";
        pending = pending.then(() => writer(nextChunk));
      }
      await pending;
    },
  };
}

async function drainStdinStream(ctx: CommandContext): Promise<string> {
  let buffered = "";
  for await (const chunk of ctx.stdinStream) {
    buffered += chunk;
  }
  return buffered;
}

function resolvePythonTimeoutMs(ctx: CommandContext): number {
  const userTimeout =
    ctx.limits?.maxPythonTimeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS;
  return ctx.fetch
    ? Math.max(userTimeout, DEFAULT_PYTHON_NETWORK_TIMEOUT_MS)
    : userTimeout;
}

function createInterruptBuffer():
  | { buffer: Int32Array | Uint8Array; clear: () => void; interrupt: () => void }
  | undefined {
  if (typeof SharedArrayBuffer !== "function") {
    return undefined;
  }

  const buffer = new Int32Array(new SharedArrayBuffer(4));
  return {
    buffer,
    clear() {
      buffer[0] = 0;
    },
    interrupt() {
      buffer[0] = 2;
    },
  };
}

async function configureExecutionEnvironment(
  runtime: PythonRuntime,
  ctx: CommandContext,
  stdin: string,
): Promise<void> {
  let stdinDelivered = false;
  runtime.ioState.readStdinChunk = () => {
    if (stdinDelivered || stdin.length === 0) {
      return undefined;
    }
    stdinDelivered = true;
    return stdin;
  };

  const envRecord = mapToRecord(ctx.env);
  const pyEnv = runtime.pyodide.toPy(envRecord, { depth: 3 });

  try {
    runtime.pyodide.globals.set("__jb_env", pyEnv);
    await runtime.pyodide.runPythonAsync(`
import os
os.environ.clear()
os.environ.update(__jb_env)
`);
  } finally {
    runtime.pyodide.globals.delete("__jb_env");
    if (typeof pyEnv.destroy === "function") {
      pyEnv.destroy();
    }
  }

  runtime.pyodideFs.chdir(ctx.cwd);
}

async function runPythonExecution(
  runtime: PythonRuntime,
  execution: PythonExecutionInput,
): Promise<PythonExecutionOutput> {
  const pyInput = runtime.pyodide.toPy(execution, { depth: 6 });

  try {
    runtime.pyodide.globals.set("__jb_input", pyInput);
    await runtime.pyodide.runPythonAsync(PYTHON_EXECUTOR_SOURCE);
    const rawResult = runtime.pyodide.runPython("__jb_output");
    return JSON.parse(String(rawResult)) as PythonExecutionOutput;
  } finally {
    runtime.pyodide.globals.delete("__jb_input");
    runtime.pyodide.globals.delete("__jb_output");
    if (typeof pyInput.destroy === "function") {
      pyInput.destroy();
    }
  }
}

async function executePython(
  execution: PythonExecutionInput,
  ctx: CommandContext,
  stdin: string,
): Promise<CommandResult> {
  const pyodideAssets = await getPyodideAssets(ctx);

  return withSerializedRuntime(ctx.fs, pyodideAssets, async (runtime) => {
    const stdoutWriter = createStreamingWriter(ctx.writeStdout);
    const stderrWriter = createStreamingWriter(ctx.writeStderr);
    // Pyodide's batched stdout/stderr strips trailing newlines — add them back.
    runtime.ioState.writeStdout = (chunk) => {
      stdoutWriter.push(chunk + "\n");
    };
    runtime.ioState.writeStderr = (chunk) => {
      stderrWriter.push(chunk + "\n");
    };

    const interruptHandle = createInterruptBuffer();
    runtime.streamApi.setInterruptBuffer(interruptHandle?.buffer);

    const timeoutMs = resolvePythonTimeoutMs(ctx);
    let timedOut = false;

    const timeout = _setTimeout(() => {
      timedOut = true;
      interruptHandle?.interrupt();
    }, timeoutMs);

    try {
      await configureExecutionEnvironment(runtime, ctx, stdin);

      let result: PythonExecutionOutput;
      try {
        result = await runPythonExecution(runtime, execution);
      } catch (error) {
        const message = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        );

        if (timedOut) {
          await stderrWriter.flush();
          return {
            exitCode: 1,
            stderr:
              `python3: execution timeout exceeded\n` +
              `python3: Execution timeout: exceeded ${timeoutMs}ms limit\n`,
          };
        }

        await stderrWriter.flush();
        return {
          exitCode: 1,
          stderr: message.endsWith("\n") ? message : `${message}\n`,
        };
      }

      await stdoutWriter.flush();
      await stderrWriter.flush();

      const extraStderr = sanitizeErrorMessage(result.stderr);
      return {
        exitCode: result.exitCode,
        stderr: extraStderr,
      };
    } catch (error) {
      console.error(
        "[just-bash/python3] executePython:error",
        summarizeUnknownError(error),
      );
      throw error;
    } finally {
      _clearTimeout(timeout);
      interruptHandle?.clear();
      runtime.streamApi.setInterruptBuffer(undefined);
      runtime.ioState.readStdinChunk = () => undefined;
      runtime.ioState.writeStdout = () => {};
      runtime.ioState.writeStderr = () => {};
    }
  });
}

function buildExecutionInput(
  parsed: ParsedArgs,
  scriptPath: string | undefined,
  pythonCode: string,
  absoluteScriptPath: string | undefined,
): PythonExecutionInput {
  if (parsed.module !== null) {
    return {
      mode: "module",
      module: parsed.module,
      argv0: parsed.module,
      args: parsed.scriptArgs,
    };
  }

  if (absoluteScriptPath) {
    return {
      mode: "file",
      path: absoluteScriptPath,
      argv0: scriptPath ?? absoluteScriptPath,
      args: parsed.scriptArgs,
    };
  }

  return {
    mode: "code",
    code: pythonCode,
    argv0: scriptPath ?? "-c",
    args: parsed.scriptArgs,
  };
}

export const python3Command: Command = {
  name: "python3",
  streaming: true,

  async execute(args: string[], ctx: CommandContext): Promise<CommandResult> {
    if (hasHelpFlag(args)) {
      return showHelp(python3Help);
    }

    const parsed = parseArgs(args);
    if ("exitCode" in parsed) {
      return parsed;
    }

    let pythonCode = "";
    let scriptPath: string | undefined;
    let absoluteScriptPath: string | undefined;
    let stdinForProgram = ctx.stdin;

    if (parsed.showVersion) {
      const assets = await getPyodideAssets(ctx);
      const runtime = await createRuntime(ctx.fs, assets);
      return {
        stdout: `Python ${runtime.version} (Pyodide ${PYODIDE_VERSION})\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    if (parsed.code !== null) {
      pythonCode = parsed.code;
      scriptPath = "-c";
    } else if (parsed.module !== null) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(parsed.module)) {
        return {
          stdout: "",
          stderr: `python3: No module named '${parsed.module.slice(0, 200)}'\n`,
          exitCode: 1,
        };
      }
      scriptPath = parsed.module;
    } else if (parsed.scriptFile !== null && parsed.scriptFile !== "-") {
      absoluteScriptPath = ctx.fs.resolvePath(ctx.cwd, parsed.scriptFile);

      if (!(await ctx.fs.exists(absoluteScriptPath))) {
        return {
          stdout: "",
          stderr: `python3: can't open file '${parsed.scriptFile}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }

      try {
        await ctx.fs.readFile(absoluteScriptPath);
        scriptPath = parsed.scriptFile;
      } catch (error) {
        return {
          stdout: "",
          stderr:
            `python3: can't open file '${parsed.scriptFile}': ` +
            `${sanitizeErrorMessage((error as Error).message)}\n`,
          exitCode: 2,
        };
      }
    } else {
      // No script file, or "-" meaning read from stdin
      const buffered = await drainStdinStream(ctx);
      if (!buffered.trim()) {
        return {
          stdout: "",
          stderr:
            "python3: no input provided (use -c CODE, -m MODULE, or provide a script file)\n",
          exitCode: 2,
        };
      }

      pythonCode = buffered;
      scriptPath = "<stdin>";
      stdinForProgram = "";
    }

    const execution = buildExecutionInput(
      parsed,
      scriptPath,
      pythonCode,
      absoluteScriptPath,
    );

    const result = await executePython(execution, ctx, stdinForProgram);
    return result;
  },
};

export const pythonCommand: Command = {
  name: "python",
  streaming: true,

  async execute(args, ctx) {
    return python3Command.execute(args, ctx);
  },
};
