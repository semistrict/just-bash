declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}
