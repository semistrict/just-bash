export async function readFile() {
  throw new Error("node:fs/promises is not available in browser environments");
}
