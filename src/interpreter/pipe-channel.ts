/**
 * PipeChannel — single-producer / single-consumer async channel with bounded
 * buffering and abort support for streaming pipelines.
 *
 * - write(chunk) blocks via backpressure when queue is full
 * - async iterator yields chunks, awaits when queue is empty
 * - close() signals EOF
 * - abort() signals SIGPIPE — pending/future writes reject with BrokenPipeError
 */

/**
 * Error thrown when a write is attempted on an aborted channel.
 * Analogous to SIGPIPE / exit code 141 (128 + 13).
 */
export class BrokenPipeError extends Error {
  readonly name = "BrokenPipeError";
  readonly exitCode = 141;

  constructor() {
    super("write: broken pipe");
  }
}

export class PipeChannel {
  private queue: string[] = [];
  private highWaterMark: number;
  private closed = false;
  private _aborted = false;

  // Resolver for producer blocked on a full queue
  private writeResolve: (() => void) | null = null;
  private writeReject: ((err: Error) => void) | null = null;
  // Resolver for consumer blocked on an empty queue
  private readResolve:
    | ((value: IteratorResult<string, undefined>) => void)
    | null = null;

  get aborted(): boolean {
    return this._aborted;
  }

  constructor(highWaterMark = 4) {
    this.highWaterMark = highWaterMark;
  }

  /**
   * Write a chunk into the channel.
   * Resolves immediately if queue has room; blocks if queue is full.
   * Rejects with BrokenPipeError if channel has been aborted.
   */
  write(chunk: string): Promise<void> {
    if (this._aborted) {
      return Promise.reject(new BrokenPipeError());
    }

    // If a consumer is waiting, hand the chunk directly
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ value: chunk, done: false });
      return Promise.resolve();
    }

    this.queue.push(chunk);

    // If queue has room, resolve immediately
    if (this.queue.length < this.highWaterMark) {
      return Promise.resolve();
    }

    // Queue is full — block until consumer reads
    return new Promise<void>((resolve, reject) => {
      this.writeResolve = resolve;
      this.writeReject = reject;
    });
  }

  /**
   * Signal EOF. Consumer will drain remaining chunks then get done.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // If consumer is waiting on an empty queue, signal done
    if (this.readResolve && this.queue.length === 0) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  /**
   * Abort the channel. Consumer-initiated — tells producer to stop.
   * Pending writes reject with BrokenPipeError.
   */
  abort(): void {
    if (this._aborted) return;
    this._aborted = true;

    // Reject any pending write
    if (this.writeReject) {
      const reject = this.writeReject;
      this.writeResolve = null;
      this.writeReject = null;
      reject(new BrokenPipeError());
    }

    // If consumer is waiting, signal done
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    return {
      next: (): Promise<IteratorResult<string, undefined>> => {
        // Drain queued chunks first
        if (this.queue.length > 0) {
          const chunk = this.queue.shift() as string;

          // Unblock producer if it was waiting
          if (this.writeResolve) {
            const resolve = this.writeResolve;
            this.writeResolve = null;
            this.writeReject = null;
            resolve();
          }

          return Promise.resolve({ value: chunk, done: false });
        }

        // Queue is empty — if closed or aborted, done
        if (this.closed || this._aborted) {
          return Promise.resolve({
            value: undefined as undefined,
            done: true,
          });
        }

        // Wait for producer to write or close
        return new Promise<IteratorResult<string, undefined>>((resolve) => {
          this.readResolve = resolve;
        });
      },

      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}
