import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("streaming pipelines", () => {
  describe("basic streaming", () => {
    it("cat file | head -n 5 — correct output", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
      const bash = new Bash({
        files: { "/big.txt": `${lines.join("\n")}\n` },
      });
      const result = await bash.exec("cat /big.txt | head -n 5");
      expect(result.stdout).toBe("line1\nline2\nline3\nline4\nline5\n");
      expect(result.exitCode).toBe(0);
    });

    it("cat file | head -n 1 — only first line", async () => {
      const lines = Array.from({ length: 10000 }, (_, i) => `line${i + 1}`);
      const bash = new Bash({
        files: { "/huge.txt": `${lines.join("\n")}\n` },
      });
      const result = await bash.exec("cat /huge.txt | head -n 1");
      expect(result.stdout).toBe("line1\n");
      expect(result.exitCode).toBe(0);
    });

    it("seq 1 1000000000000 | head -n 5 — trillion element sequence, bounded memory", async () => {
      const bash = new Bash();
      const result = await bash.exec("seq 1 1000000000000 | head -n 5");
      expect(result.stdout).toBe("1\n2\n3\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("echo hello | cat | cat | cat — chains of streaming commands", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo hello | cat | cat | cat");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("streaming + non-streaming interop", () => {
    it("echo hello | cat | grep hello", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo hello | cat | grep hello");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("non-streaming producer | head -n 5", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        'echo -e "a\\nb\\nc\\nd\\ne\\nf\\ng" | head -n 3',
      );
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("cat file | non-streaming consumer", async () => {
      const bash = new Bash({
        files: { "/data.txt": "hello\nworld\n" },
      });
      const result = await bash.exec("cat /data.txt | grep world");
      expect(result.stdout).toBe("world\n");
    });

    it("cat file | sort (non-streaming sort)", async () => {
      const bash = new Bash({
        files: { "/data.txt": "banana\napple\ncherry\n" },
      });
      const result = await bash.exec("cat /data.txt | sort");
      expect(result.stdout).toBe("apple\nbanana\ncherry\n");
    });
  });

  describe("streaming grep", () => {
    it("cat file | grep pattern — streaming grep finds matches", async () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`);
      const bash = new Bash({
        files: { "/big.txt": `${lines.join("\n")}\n` },
      });
      const result = await bash.exec("cat /big.txt | grep line500");
      expect(result.stdout).toBe("line500\n");
    });

    it("cat file | grep pattern | head -n 1 — grep + head early termination", async () => {
      const bash = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\navocado\n" },
      });
      const result = await bash.exec("cat /data.txt | grep a | head -n 1");
      expect(result.stdout).toBe("apple\n");
    });

    it("cat file | grep -c pattern — streaming grep with count", async () => {
      const bash = new Bash({
        files: { "/data.txt": "aa\nbb\naa\ncc\naa\n" },
      });
      const result = await bash.exec("cat /data.txt | grep -c aa");
      expect(result.stdout).toBe("3\n");
    });

    it("cat file | grep -v pattern — streaming grep with invert", async () => {
      const bash = new Bash({
        files: { "/data.txt": "keep\nremove\nkeep\n" },
      });
      const result = await bash.exec("cat /data.txt | grep -v remove");
      expect(result.stdout).toBe("keep\nkeep\n");
    });
  });

  describe("streaming rg", () => {
    it("cat file | rg pattern — searches stdin", async () => {
      const bash = new Bash({
        files: { "/data.txt": "foo\nbar\nbaz\n" },
      });
      const result = await bash.exec("cat /data.txt | rg bar");
      expect(result.stdout).toBe("bar\n");
      expect(result.exitCode).toBe(0);
    });

    it("cat file | rg pattern | head -n 1 — rg + head early termination", async () => {
      const bash = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\navocado\n" },
      });
      const result = await bash.exec("cat /data.txt | rg a | head -n 1");
      expect(result.stdout).toBe("apple\n");
    });

    it("echo data | rg -i PATTERN — case insensitive stdin", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo hello | rg -i HELLO");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("pipeline exit codes and PIPESTATUS", () => {
    it("PIPESTATUS tracks all stages", async () => {
      const bash = new Bash({
        files: { "/data.txt": "hello\n" },
      });
      const result = await bash.exec(
        'cat /data.txt | grep hello; echo "${PIPESTATUS[0]} ${PIPESTATUS[1]}"',
      );
      expect(result.stdout).toBe("hello\n0 0\n");
    });

    it("set -o pipefail; false | cat", async () => {
      const bash = new Bash();
      const result = await bash.exec("set -o pipefail; false | cat; echo $?");
      expect(result.stdout).toBe("1\n");
    });

    it("! negation works", async () => {
      const bash = new Bash();
      const result = await bash.exec("! echo hello | grep nomatch; echo $?");
      expect(result.stdout).toBe("0\n");
    });
  });

  describe("|& stderr piping", () => {
    it("|& pipes stderr to next command", async () => {
      const bash = new Bash();
      const result = await bash.exec("ls /no_such_path_xyz |& cat");
      expect(result.stdout).toContain("No such file");
      expect(result.stderr).toBe("");
    });
  });

  describe("command substitution", () => {
    it("$(cat file | head -n 1) works", async () => {
      const bash = new Bash({
        files: { "/data.txt": "first\nsecond\nthird\n" },
      });
      const result = await bash.exec("echo $(cat /data.txt | head -n 1)");
      expect(result.stdout).toBe("first\n");
    });
  });

  describe("redirections with streaming", () => {
    it("cat file | head -n 2 > output", async () => {
      const bash = new Bash({
        files: { "/data.txt": "a\nb\nc\nd\n" },
      });
      await bash.exec("cat /data.txt | head -n 2 > /output.txt");
      const result = await bash.exec("cat /output.txt");
      expect(result.stdout).toBe("a\nb\n");
    });

    it("cat file | cat > output preserves data", async () => {
      const bash = new Bash({
        files: { "/data.txt": "hello world\n" },
      });
      await bash.exec("cat /data.txt | cat > /output.txt");
      const result = await bash.exec("cat /output.txt");
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("here-docs with streaming", () => {
    it("cat <<EOF | grep pattern", async () => {
      const bash = new Bash();
      const result = await bash.exec(`cat <<EOF | grep hello
hello world
goodbye world
EOF`);
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("streaming with -n flag (non-streaming fallback)", () => {
    it("echo data | cat -n falls back to buffered", async () => {
      const bash = new Bash();
      const result = await bash.exec('echo -e "a\\nb" | cat -n');
      expect(result.stdout).toBe("     1\ta\n     2\tb\n");
    });

    it("head with files uses buffered path", async () => {
      const bash = new Bash({
        files: { "/data.txt": "a\nb\nc\nd\ne\n" },
      });
      const result = await bash.exec("head -n 2 /data.txt");
      expect(result.stdout).toBe("a\nb\n");
    });
  });
});
