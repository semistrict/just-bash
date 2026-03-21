export class AsyncLocalStorage {
  constructor() {
    throw new Error(
      "node:async_hooks is not available in browser environments",
    );
  }
}
