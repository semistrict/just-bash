import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./in-memory-fs.js";

describe("InMemoryFs Buffer and Encoding Support", () => {
  describe("basic Buffer operations", () => {
    it("should write and read Uint8Array", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await fs.writeFile("/binary.bin", data);
      const result = await fs.readFileBuffer("/binary.bin");

      expect(result).toEqual(data);
    });

    it("should write Uint8Array and read as string", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await fs.writeFile("/test.txt", data);
      const result = await fs.readFile("/test.txt");

      expect(result).toBe("Hello");
    });

    it("should write string and read as Uint8Array", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      const result = await fs.readFileBuffer("/test.txt");

      expect(result).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    });

    it("should handle binary data with null bytes", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x00, 0x01, 0x00, 0xff, 0x00]);

      await fs.writeFile("/binary.bin", data);
      const result = await fs.readFileBuffer("/binary.bin");

      expect(result).toEqual(data);
    });

    it("should calculate correct size for binary files", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);

      await fs.writeFile("/binary.bin", data);
      const stat = await fs.stat("/binary.bin");

      expect(stat.size).toBe(5);
    });
  });

  describe("encoding support", () => {
    it("should write and read with utf8 encoding", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello 世界", "utf8");
      const result = await fs.readFile("/test.txt", "utf8");

      expect(result).toBe("Hello 世界");
    });

    it("should write and read with base64 encoding", async () => {
      const fs = new InMemoryFs();

      // "Hello" in base64 is "SGVsbG8="
      await fs.writeFile("/test.txt", "SGVsbG8=", "base64");
      const result = await fs.readFile("/test.txt", "utf8");

      expect(result).toBe("Hello");
    });

    it("should read as base64", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      const result = await fs.readFile("/test.txt", "base64");

      expect(result).toBe("SGVsbG8=");
    });

    it("should write and read with hex encoding", async () => {
      const fs = new InMemoryFs();

      // "Hello" in hex is "48656c6c6f"
      await fs.writeFile("/test.txt", "48656c6c6f", "hex");
      const result = await fs.readFile("/test.txt", "utf8");

      expect(result).toBe("Hello");
    });

    it("should read as hex", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      const result = await fs.readFile("/test.txt", "hex");

      expect(result).toBe("48656c6c6f");
    });

    it("should write with latin1 encoding", async () => {
      const fs = new InMemoryFs();

      // Latin1 character é is 0xe9
      await fs.writeFile("/test.txt", "café", "latin1");
      const buffer = await fs.readFileBuffer("/test.txt");

      expect(buffer).toEqual(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    });

    it("should support encoding in options object", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "SGVsbG8=", { encoding: "base64" });
      const result = await fs.readFile("/test.txt", { encoding: "utf8" });

      expect(result).toBe("Hello");
    });
  });

  describe("appendFile with Buffer", () => {
    it("should append Uint8Array to existing file", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      await fs.appendFile(
        "/test.txt",
        new Uint8Array([0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64]),
      ); // " World"

      const result = await fs.readFile("/test.txt");
      expect(result).toBe("Hello World");
    });

    it("should append string to file with Buffer content", async () => {
      const fs = new InMemoryFs();
      const initial = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await fs.writeFile("/test.txt", initial);
      await fs.appendFile("/test.txt", " World");

      const result = await fs.readFile("/test.txt");
      expect(result).toBe("Hello World");
    });

    it("should append with encoding", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/test.txt", "Hello");
      // " World" in base64 is "IFdvcmxk"
      await fs.appendFile("/test.txt", "IFdvcmxk", "base64");

      const result = await fs.readFile("/test.txt");
      expect(result).toBe("Hello World");
    });
  });

  describe("constructor with Buffer content", () => {
    it("should initialize files with Uint8Array content", async () => {
      const fs = new InMemoryFs({
        "/binary.bin": new Uint8Array([0x00, 0x01, 0x02]),
        "/text.txt": "Hello",
      });

      const binary = await fs.readFileBuffer("/binary.bin");
      const text = await fs.readFile("/text.txt");

      expect(binary).toEqual(new Uint8Array([0x00, 0x01, 0x02]));
      expect(text).toBe("Hello");
    });
  });

  describe("edge cases", () => {
    it("should handle empty Uint8Array", async () => {
      const fs = new InMemoryFs();

      await fs.writeFile("/empty.bin", new Uint8Array(0));
      const result = await fs.readFileBuffer("/empty.bin");

      expect(result).toEqual(new Uint8Array(0));
      expect(result.length).toBe(0);
    });

    it("should handle large binary files", async () => {
      const fs = new InMemoryFs();
      const size = 1024 * 1024; // 1MB
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }

      await fs.writeFile("/large.bin", data);
      const result = await fs.readFileBuffer("/large.bin");

      expect(result.length).toBe(size);
      expect(result[0]).toBe(0);
      expect(result[255]).toBe(255);
      expect(result[256]).toBe(0);
    });

    it("should preserve binary content through copy", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x00, 0xff, 0x00, 0xff]);

      await fs.writeFile("/src.bin", data);
      await fs.cp("/src.bin", "/dst.bin");

      const result = await fs.readFileBuffer("/dst.bin");
      expect(result).toEqual(data);
    });

    it("should follow symlinks for binary files", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([0x48, 0x69]);

      await fs.writeFile("/real.bin", data);
      await fs.symlink("/real.bin", "/link.bin");

      const result = await fs.readFileBuffer("/link.bin");
      expect(result).toEqual(data);
    });
  });
});

describe("InMemoryFs readdirWithFileTypes", () => {
  it("should return entries with correct type info", async () => {
    const fs = new InMemoryFs({
      "/dir/file.txt": "content",
      "/dir/subdir/nested.txt": "nested",
    });

    const entries = await fs.readdirWithFileTypes("/dir");

    expect(entries).toHaveLength(2);

    const file = entries.find((e) => e.name === "file.txt");
    expect(file).toBeDefined();
    expect(file?.isFile).toBe(true);
    expect(file?.isDirectory).toBe(false);
    expect(file?.isSymbolicLink).toBe(false);

    const subdir = entries.find((e) => e.name === "subdir");
    expect(subdir).toBeDefined();
    expect(subdir?.isFile).toBe(false);
    expect(subdir?.isDirectory).toBe(true);
    expect(subdir?.isSymbolicLink).toBe(false);
  });

  it("should return entries sorted case-sensitively", async () => {
    const fs = new InMemoryFs({
      "/dir/Zebra.txt": "z",
      "/dir/apple.txt": "a",
      "/dir/Banana.txt": "b",
    });

    const entries = await fs.readdirWithFileTypes("/dir");
    const names = entries.map((e) => e.name);

    // Case-sensitive sort: uppercase before lowercase
    expect(names).toEqual(["Banana.txt", "Zebra.txt", "apple.txt"]);
  });

  it("should identify symlinks correctly", async () => {
    const fs = new InMemoryFs({
      "/dir/real.txt": "content",
    });
    await fs.symlink("/dir/real.txt", "/dir/link.txt");

    const entries = await fs.readdirWithFileTypes("/dir");

    const link = entries.find((e) => e.name === "link.txt");
    expect(link).toBeDefined();
    expect(link?.isFile).toBe(false);
    expect(link?.isDirectory).toBe(false);
    expect(link?.isSymbolicLink).toBe(true);
  });

  it("should throw ENOENT for non-existent directory", async () => {
    const fs = new InMemoryFs();

    await expect(fs.readdirWithFileTypes("/nonexistent")).rejects.toThrow(
      "ENOENT",
    );
  });

  it("should throw ENOTDIR for file path", async () => {
    const fs = new InMemoryFs({
      "/file.txt": "content",
    });

    await expect(fs.readdirWithFileTypes("/file.txt")).rejects.toThrow(
      "ENOTDIR",
    );
  });

  it("should return same names as readdir", async () => {
    const fs = new InMemoryFs({
      "/dir/a.txt": "a",
      "/dir/b.txt": "b",
      "/dir/sub/c.txt": "c",
    });

    const namesFromReaddir = await fs.readdir("/dir");
    const entriesWithTypes = await fs.readdirWithFileTypes("/dir");
    const namesFromWithTypes = entriesWithTypes.map((e) => e.name);

    expect(namesFromWithTypes).toEqual(namesFromReaddir);
  });
});

describe("InMemoryFs lazy files", () => {
  it("should read lazy file content", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "lazy content",
    });

    const result = await fs.readFile("/lazy.txt");
    expect(result).toBe("lazy content");
  });

  it("should call the lazy function only once", async () => {
    const provider = vi.fn(() => "computed");
    const fs = new InMemoryFs({
      "/lazy.txt": provider,
    });

    await fs.readFile("/lazy.txt");
    await fs.readFile("/lazy.txt");
    await fs.readFile("/lazy.txt");

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("should return Uint8Array from lazy provider", async () => {
    const data = new Uint8Array([0x48, 0x69]);
    const fs = new InMemoryFs({
      "/lazy.bin": () => data,
    });

    const result = await fs.readFileBuffer("/lazy.bin");
    expect(result).toEqual(data);
  });

  it("should replace lazy entry when written to", async () => {
    const provider = vi.fn(() => "original");
    const fs = new InMemoryFs({
      "/lazy.txt": provider,
    });

    await fs.writeFile("/lazy.txt", "overwritten");
    const result = await fs.readFile("/lazy.txt");

    expect(result).toBe("overwritten");
    expect(provider).not.toHaveBeenCalled();
  });

  it("should materialize on stat and return correct size", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "hello",
    });

    const stat = await fs.stat("/lazy.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);
  });

  it("should materialize on lstat and return correct size", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "hello",
    });

    const stat = await fs.lstat("/lazy.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);
  });

  it("should handle appendFile on lazy file", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "hello",
    });

    await fs.appendFile("/lazy.txt", " world");
    const result = await fs.readFile("/lazy.txt");
    expect(result).toBe("hello world");
  });

  it("should work via writeFileLazy", async () => {
    const fs = new InMemoryFs();
    fs.writeFileLazy("/dynamic.txt", () => "dynamic content");

    const result = await fs.readFile("/dynamic.txt");
    expect(result).toBe("dynamic content");
  });

  it("should copy lazy files via cp", async () => {
    const provider = vi.fn(() => "lazy data");
    const fs = new InMemoryFs({
      "/src.txt": provider,
    });

    await fs.cp("/src.txt", "/dst.txt");

    // Neither copy has been read yet
    expect(provider).not.toHaveBeenCalled();

    const result = await fs.readFile("/dst.txt");
    expect(result).toBe("lazy data");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("should show lazy file in exists check", async () => {
    const fs = new InMemoryFs({
      "/lazy.txt": () => "exists",
    });

    expect(await fs.exists("/lazy.txt")).toBe(true);
  });

  it("should show lazy file in readdir", async () => {
    const fs = new InMemoryFs({
      "/dir/lazy.txt": () => "content",
      "/dir/eager.txt": "content",
    });

    const entries = await fs.readdir("/dir");
    expect(entries).toContain("lazy.txt");
    expect(entries).toContain("eager.txt");
  });

  it("should support async lazy providers", async () => {
    const fs = new InMemoryFs({
      "/async.txt": async () => "async content",
    });

    const result = await fs.readFile("/async.txt");
    expect(result).toBe("async content");
  });

  it("should support async lazy provider returning Uint8Array", async () => {
    const data = new Uint8Array([0x41, 0x42]);
    const fs = new InMemoryFs({
      "/async.bin": async () => data,
    });

    const result = await fs.readFileBuffer("/async.bin");
    expect(result).toEqual(data);
  });

  it("should call async lazy provider only once", async () => {
    const provider = vi.fn(async () => "once");
    const fs = new InMemoryFs({
      "/async.txt": provider,
    });

    await fs.readFile("/async.txt");
    await fs.readFile("/async.txt");
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe("InMemoryFs FilePtr (unlink-while-open)", () => {
  const O_RDONLY = 0;
  const O_WRONLY = 1;
  const O_RDWR = 2;
  const O_CREAT = 64;
  const O_TRUNC = 512;

  it("open/read/write/close round-trip", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/f.txt", "hello");

    const ptr = fs.open("/f.txt", O_RDWR);
    const buf = new Uint8Array(5);
    const n = fs.read(ptr, buf, 0, 5, 0);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe("hello");

    fs.write(ptr, new TextEncoder().encode("world"), 0, 5, 5);
    expect(fs.fstat(ptr).size).toBe(10);

    fs.close(ptr);
    expect(fs.readFileBufferSync("/f.txt")).toEqual(
      new TextEncoder().encode("helloworld"),
    );
  });

  it("read/write still work after unlink", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/tmp.txt", "before");

    const ptr = fs.open("/tmp.txt", O_RDWR);
    fs.rmSync("/tmp.txt");

    // File is gone from the namespace
    expect(fs.existsSync("/tmp.txt")).toBe(false);

    // But FD still works
    const buf = new Uint8Array(6);
    expect(fs.read(ptr, buf, 0, 6, 0)).toBe(6);
    expect(new TextDecoder().decode(buf)).toBe("before");

    fs.write(ptr, new TextEncoder().encode("after!"), 0, 6, 0);
    const buf2 = new Uint8Array(6);
    fs.read(ptr, buf2, 0, 6, 0);
    expect(new TextDecoder().decode(buf2)).toBe("after!");

    fs.close(ptr);
  });

  it("fstat returns correct size on orphan", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/f.bin", new Uint8Array(100));

    const ptr = fs.open("/f.bin", O_RDONLY);
    expect(fs.fstat(ptr).size).toBe(100);

    fs.rmSync("/f.bin");
    expect(fs.fstat(ptr).size).toBe(100);

    fs.close(ptr);
  });

  it("fstat updates after write to orphan", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/f.txt", "abc");

    const ptr = fs.open("/f.txt", O_RDWR);
    fs.rmSync("/f.txt");

    expect(fs.fstat(ptr).size).toBe(3);
    fs.write(ptr, new TextEncoder().encode("defgh"), 0, 5, 3);
    expect(fs.fstat(ptr).size).toBe(8);

    fs.close(ptr);
  });

  it("ftruncate on orphan", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/f.txt", "abcdefghij");

    const ptr = fs.open("/f.txt", O_RDWR);
    fs.rmSync("/f.txt");

    fs.ftruncate(ptr, 3);
    expect(fs.fstat(ptr).size).toBe(3);

    const buf = new Uint8Array(10);
    const n = fs.read(ptr, buf, 0, 10, 0);
    expect(n).toBe(3);
    expect(new TextDecoder().decode(buf.subarray(0, 3))).toBe("abc");

    fs.close(ptr);
  });

  it("multiple FDs — pages survive until last close", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/shared.txt", "data");

    const ptr1 = fs.open("/shared.txt", O_RDONLY);
    const ptr2 = fs.open("/shared.txt", O_RDONLY);
    expect(ptr1).toBe(ptr2); // same inode

    fs.rmSync("/shared.txt");

    // First close — still one ref
    fs.close(ptr1);
    const buf = new Uint8Array(4);
    expect(fs.read(ptr2, buf, 0, 4, 0)).toBe(4);
    expect(new TextDecoder().decode(buf)).toBe("data");

    // Second close — orphan cleaned up
    fs.close(ptr2);
  });

  it("O_CREAT creates file if missing", () => {
    const fs = new InMemoryFs();
    const ptr = fs.open("/new.txt", O_WRONLY | O_CREAT);
    fs.write(ptr, new TextEncoder().encode("created"), 0, 7, 0);
    fs.close(ptr);

    expect(fs.readFileBufferSync("/new.txt")).toEqual(
      new TextEncoder().encode("created"),
    );
  });

  it("O_TRUNC truncates existing file", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/f.txt", "existing content");

    const ptr = fs.open("/f.txt", O_WRONLY | O_TRUNC);
    expect(fs.fstat(ptr).size).toBe(0);
    fs.close(ptr);
  });

  it("write past EOF grows the file", () => {
    const fs = new InMemoryFs();
    fs.writeFileSync("/f.txt", "ab");

    const ptr = fs.open("/f.txt", O_RDWR);
    fs.rmSync("/f.txt");

    // Write at position 10 — gap should be zero-filled
    fs.write(ptr, new TextEncoder().encode("xy"), 0, 2, 10);
    expect(fs.fstat(ptr).size).toBe(12);

    const buf = new Uint8Array(12);
    fs.read(ptr, buf, 0, 12, 0);
    // Bytes 0-1: "ab", 2-9: zeros, 10-11: "xy"
    expect(buf[0]).toBe(97); // 'a'
    expect(buf[1]).toBe(98); // 'b'
    expect(buf[5]).toBe(0);
    expect(buf[10]).toBe(120); // 'x'
    expect(buf[11]).toBe(121); // 'y'

    fs.close(ptr);
  });
});
