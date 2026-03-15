import { describe, expect, it } from "vitest";
import { BrokenPipeError, PipeChannel } from "./pipe-channel.js";

describe("PipeChannel", () => {
  it("basic write/read flow", async () => {
    const ch = new PipeChannel();
    await ch.write("hello");
    ch.close();

    const chunks: string[] = [];
    for await (const chunk of ch) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hello"]);
  });

  it("multiple chunks flow in order", async () => {
    const ch = new PipeChannel();
    await ch.write("a");
    await ch.write("b");
    await ch.write("c");
    ch.close();

    const chunks: string[] = [];
    for await (const chunk of ch) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("backpressure: write blocks when queue is full, unblocks when consumer reads", async () => {
    const ch = new PipeChannel(2); // highWaterMark = 2
    await ch.write("a"); // queue=[a], length < 2 → resolves
    const writePromise = ch.write("b"); // queue=[a,b], length = 2 → blocks

    let writeResolved = false;
    writePromise.then(() => {
      writeResolved = true;
    });

    // Give microtask a chance to run
    await Promise.resolve();
    expect(writeResolved).toBe(false);

    // Consumer reads, should unblock writer
    const iter = ch[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toBe("a");

    // Now the blocked write should resolve
    await writePromise;
    expect(writeResolved).toBe(true);

    // Read remaining
    const second = await iter.next();
    expect(second.value).toBe("b");

    ch.close();
    const done = await iter.next();
    expect(done.done).toBe(true);
  });

  it("close signals EOF to consumer iterator", async () => {
    const ch = new PipeChannel();
    ch.close();

    const iter = ch[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("read after close drains remaining chunks then EOF", async () => {
    const ch = new PipeChannel();
    await ch.write("x");
    await ch.write("y");
    ch.close();

    const chunks: string[] = [];
    for await (const chunk of ch) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["x", "y"]);
  });

  it("empty channel close yields immediate EOF", async () => {
    const ch = new PipeChannel();
    ch.close();

    const chunks: string[] = [];
    for await (const chunk of ch) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it("abort causes write to reject with BrokenPipeError", async () => {
    const ch = new PipeChannel();
    ch.abort();

    await expect(ch.write("data")).rejects.toThrow(BrokenPipeError);
    expect(ch.aborted).toBe(true);
  });

  it("abort while write is pending also rejects", async () => {
    const ch = new PipeChannel(1); // highWaterMark = 1
    const writePromise = ch.write("block"); // queue=[block], length = 1 → blocks

    ch.abort();

    await expect(writePromise).rejects.toThrow(BrokenPipeError);
  });

  it("abort terminates consumer iterator", async () => {
    const ch = new PipeChannel();

    // Consumer starts waiting for data
    const iter = ch[Symbol.asyncIterator]();
    const nextPromise = iter.next();

    // Producer aborts
    ch.abort();

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  it("consumer reads then producer writes (async handoff)", async () => {
    const ch = new PipeChannel();
    const iter = ch[Symbol.asyncIterator]();

    // Consumer starts waiting
    const nextPromise = iter.next();

    // Producer writes — should hand off directly
    await ch.write("direct");

    const result = await nextPromise;
    expect(result.value).toBe("direct");
    expect(result.done).toBe(false);

    ch.close();
    const done = await iter.next();
    expect(done.done).toBe(true);
  });

  it("concurrent producer and consumer", async () => {
    const ch = new PipeChannel(2);

    // Producer
    const producerDone = (async () => {
      for (let i = 0; i < 10; i++) {
        await ch.write(`chunk${i}`);
      }
      ch.close();
    })();

    // Consumer
    const chunks: string[] = [];
    for await (const chunk of ch) {
      chunks.push(chunk);
    }

    await producerDone;
    expect(chunks).toEqual(Array.from({ length: 10 }, (_, i) => `chunk${i}`));
  });

  it("double close is a no-op", () => {
    const ch = new PipeChannel();
    ch.close();
    ch.close(); // should not throw
  });

  it("double abort is a no-op", () => {
    const ch = new PipeChannel();
    ch.abort();
    ch.abort(); // should not throw
  });
});
