export class Worker {
  constructor() {
    throw new Error(
      "node:worker_threads is not available in browser environments",
    );
  }
}
