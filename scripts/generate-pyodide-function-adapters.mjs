import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const pyodideAsmPath = path.join(
  repoRoot,
  "third_party/just-bash/vendor/pyodide/pyodide.asm.js",
);
const outputDirs = [
  path.join(repoRoot, "third_party/just-bash/vendor/pyodide/function-adapters"),
  path.join(repoRoot, "apps/web/src/vendor/pyodide/function-adapters"),
];
const appModulePath = path.join(
  repoRoot,
  "apps/web/src/vendor/pyodide/function-adapters.ts",
);

const wasmTypeCodes = {
  d: 0x7c,
  e: 0x6f,
  f: 0x7d,
  i: 0x7f,
  j: 0x7e,
};

function encodeULEB128(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function createSection(sectionId, body) {
  return [sectionId, ...encodeULEB128(body.length), ...body];
}

function signatureToFunctionType(signature) {
  const resultCode = signature[0];
  const parameterCodes = [...signature.slice(1)];

  return [
    0x60,
    ...encodeULEB128(parameterCodes.length),
    ...parameterCodes.map((code) => wasmTypeCodes[code]),
    ...(resultCode === "v" ? [0] : [1, wasmTypeCodes[resultCode]]),
  ];
}

function createAdapterModule(signature) {
  const typeSection = createSection(1, [
    1,
    ...signatureToFunctionType(signature),
  ]);
  const importSection = createSection(2, [
    1,
    1,
    0x65,
    1,
    0x66,
    0,
    0,
  ]);
  const exportSection = createSection(7, [
    1,
    1,
    0x66,
    0,
    0,
  ]);

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSection,
    ...importSection,
    ...exportSection,
  ]);
}

function canonicalizeSignature(signature) {
  return signature.replaceAll("p", "i");
}

async function main() {
  const pyodideAsm = await readFile(pyodideAsmPath, "utf8");
  const signatures = [
    ...new Set(
      [...pyodideAsm.matchAll(/\.sig=\"([^\"]+)\"/g)].map((match) =>
        canonicalizeSignature(match[1]),
      ),
    ),
  ].sort((left, right) => left.length - right.length || left.localeCompare(right));

  for (const outputDir of outputDirs) {
    await rm(outputDir, { force: true, recursive: true });
    await mkdir(outputDir, { recursive: true });

    await Promise.all(
      signatures.map((signature) =>
        writeFile(
          path.join(outputDir, `${signature}.wasm`),
          createAdapterModule(signature),
        ),
      ),
    );
  }

  const appModuleSource = [
    ...signatures.map((signature) => {
      return `import adapter_${signature} from "./function-adapters/${signature}.wasm";`;
    }),
    "",
    "export const functionAdapterModules = {",
    ...signatures.map((signature) => {
      return `  "${signature}": adapter_${signature},`;
    }),
    "} satisfies Record<string, WebAssembly.Module>;",
    "",
  ].join("\n");

  await writeFile(appModulePath, appModuleSource);

  console.log(
    `Generated ${signatures.length} Pyodide function adapters in ${outputDirs.length} locations.`,
  );
}

await main();
