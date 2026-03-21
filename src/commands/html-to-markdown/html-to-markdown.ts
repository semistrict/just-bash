/**
 * html-to-markdown - Convert HTML to Markdown
 *
 * Pure JS implementation — no external dependencies (CF Workers compatible).
 * Uses regex-based parsing (not a DOM parser) so it works in any JS runtime.
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const htmlToMarkdownHelp = {
  name: "html-to-markdown",
  summary: "convert HTML to Markdown (BashEnv extension)",
  usage: "html-to-markdown [OPTION]... [FILE]",
  description: [
    "Convert HTML content to Markdown format.",
    "This is a non-standard BashEnv extension command, not available in regular bash.",
    "",
    "Read HTML from FILE or standard input and output Markdown to standard output.",
    "Commonly used with curl to convert web pages:",
    "  curl -s https://example.com | html-to-markdown",
    "",
    "Supported HTML elements:",
    "  - Headings (h1-h6) → # Markdown headings",
    "  - Paragraphs (p) → Plain text with blank lines",
    "  - Links (a) → [text](url)",
    "  - Images (img) → ![alt](src)",
    "  - Bold/Strong → **text**",
    "  - Italic/Em → _text_",
    "  - Code (code, pre) → `inline` or fenced blocks",
    "  - Lists (ul, ol, li) → - or 1. items",
    "  - Blockquotes → > quoted text",
    "  - Horizontal rules (hr) → ---",
  ],
  options: [
    "-b, --bullet=CHAR     bullet character for unordered lists (-, +, or *)",
    "-c, --code=FENCE      fence style for code blocks (``` or ~~~)",
    "-r, --hr=STRING       string for horizontal rules (default: ---)",
    "    --heading-style=STYLE",
    "                      heading style: 'atx' for # headings (default),",
    "                      'setext' for underlined headings (h1/h2 only)",
    "    --help            display this help and exit",
  ],
  examples: [
    "echo '<h1>Hello</h1><p>World</p>' | html-to-markdown",
    "html-to-markdown page.html",
    "curl -s https://example.com | html-to-markdown > page.md",
  ],
};

interface ConvertOptions {
  bullet: string;
  codeFence: string;
  hr: string;
  headingStyle: "atx" | "setext";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function getAttr(tag: string, attr: string): string {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`, "i");
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function convertHtml(html: string, opts: ConvertOptions): string {
  let s = html;

  // Strip script, style, footer entirely
  s = s.replace(/<(script|style|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Strip HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Images → ![alt](src)
  s = s.replace(/<img\b([^>]*)\/?\s*>/gi, (_, attrs) => {
    const alt = getAttr(attrs, "alt");
    const src = getAttr(attrs, "src");
    return src ? `![${alt}](${src})` : "";
  });

  // Links → [text](href)
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, text) => {
    const href = getAttr(attrs, "href");
    const inner = text.replace(/<[^>]+>/g, "").trim();
    return href ? `[${inner}](${href})` : inner;
  });

  // Pre/code blocks → fenced code
  s = s.replace(/<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, attrs, code) => {
    const lang = getAttr(attrs, "class").replace(/^language-/, "");
    const decoded = decodeEntities(code).replace(/<[^>]+>/g, "").trim();
    return `\n\n${opts.codeFence}${lang}\n${decoded}\n${opts.codeFence}\n\n`;
  });
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const decoded = decodeEntities(code).replace(/<[^>]+>/g, "").trim();
    return `\n\n${opts.codeFence}\n${decoded}\n${opts.codeFence}\n\n`;
  });

  // Inline code
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    return `\`${decodeEntities(code).replace(/<[^>]+>/g, "")}\``;
  });

  // Headings
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    const inner = text.replace(/<[^>]+>/g, "").trim();
    const n = parseInt(level, 10);
    if (opts.headingStyle === "setext" && n <= 2) {
      const underline = n === 1 ? "=" : "-";
      return `\n\n${inner}\n${underline.repeat(inner.length)}\n\n`;
    }
    return `\n\n${"#".repeat(n)} ${inner}\n\n`;
  });

  // Blockquotes
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const inner = content.replace(/<[^>]+>/g, "").trim();
    return "\n\n" + inner.split("\n").map((l: string) => `> ${l}`).join("\n") + "\n\n";
  });

  // Ordered lists
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, items) => {
    let i = 0;
    const result = items.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_: string, text: string) => {
      i++;
      return `${i}. ${text.replace(/<[^>]+>/g, "").trim()}\n`;
    });
    return `\n\n${result.replace(/<[^>]+>/g, "").trim()}\n\n`;
  });

  // Unordered lists
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, items) => {
    const result = items.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_: string, text: string) => {
      return `${opts.bullet} ${text.replace(/<[^>]+>/g, "").trim()}\n`;
    });
    return `\n\n${result.replace(/<[^>]+>/g, "").trim()}\n\n`;
  });

  // Bold
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `**${text.replace(/<[^>]+>/g, "")}**`);

  // Italic
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `_${text.replace(/<[^>]+>/g, "")}_`);

  // Horizontal rules
  s = s.replace(/<hr\b[^>]*\/?>/gi, `\n\n${opts.hr}\n\n`);

  // Line breaks
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Paragraphs and divs → newlines
  s = s.replace(/<\/?(p|div)\b[^>]*>/gi, "\n\n");

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");

  // Decode entities
  s = decodeEntities(s);

  // Collapse whitespace: max 2 consecutive newlines
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}

export const htmlToMarkdownCommand: Command = {
  name: "html-to-markdown",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(htmlToMarkdownHelp);
    }

    let bullet = "-";
    let codeFence = "```";
    let hr = "---";
    let headingStyle: "setext" | "atx" = "atx";
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-b" || arg === "--bullet") {
        bullet = args[++i] ?? "-";
      } else if (arg.startsWith("--bullet=")) {
        bullet = arg.slice(9);
      } else if (arg === "-c" || arg === "--code") {
        codeFence = args[++i] ?? "```";
      } else if (arg.startsWith("--code=")) {
        codeFence = arg.slice(7);
      } else if (arg === "-r" || arg === "--hr") {
        hr = args[++i] ?? "---";
      } else if (arg.startsWith("--hr=")) {
        hr = arg.slice(5);
      } else if (arg.startsWith("--heading-style=")) {
        const style = arg.slice(16);
        if (style === "setext" || style === "atx") {
          headingStyle = style;
        }
      } else if (arg === "-") {
        files.push("-");
      } else if (arg.startsWith("--")) {
        return unknownOption("html-to-markdown", arg);
      } else if (arg.startsWith("-")) {
        return unknownOption("html-to-markdown", arg);
      } else {
        files.push(arg);
      }
    }

    // Get input
    let input: string;
    if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
      input = ctx.stdin;
    } else {
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, files[0]);
        input = await ctx.fs.readFile(filePath);
      } catch {
        return {
          stdout: "",
          stderr: `html-to-markdown: ${files[0]}: No such file or directory\n`,
          exitCode: 1,
        };
      }
    }

    if (!input.trim()) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    try {
      const markdown = convertHtml(input, { bullet, codeFence, hr, headingStyle });
      return {
        stdout: `${markdown}\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `html-to-markdown: conversion error: ${
          (error as Error).message
        }\n`,
        exitCode: 1,
      };
    }
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "html-to-markdown",
  flags: [],
  stdinType: "text",
};
