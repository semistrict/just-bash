/**
 * Streaming line-by-line search.
 *
 * Processes lines from an async iterable, writing output incrementally
 * via a callback. Handles context lines with a sliding window. Falls
 * back to buffering only for multiline mode.
 */

import type { UserRegex } from "../../regex/index.js";
import type { SearchOptions, SearchResult } from "./matcher.js";
import { searchContent } from "./matcher.js";

export interface StreamingSearchOptions extends SearchOptions {
  /** Write a chunk of output. */
  write: (chunk: string) => Promise<void>;
}

/**
 * Search lines from an async iterable, writing matches via write().
 * Returns matched/matchCount for exit code determination.
 *
 * For multiline mode, buffers all input and delegates to searchContent.
 */
export async function searchStream(
  lines: AsyncIterable<string>,
  regex: UserRegex,
  options: StreamingSearchOptions,
): Promise<{ matched: boolean; matchCount: number }> {
  const {
    invertMatch = false,
    showLineNumbers = false,
    countOnly = false,
    countMatches = false,
    filename = "",
    onlyMatching = false,
    beforeContext = 0,
    afterContext = 0,
    maxCount = 0,
    contextSeparator = "--",
    passthru = false,
    multiline = false,
    replace = null,
    showColumn = false,
    showByteOffset = false,
    vimgrep = false,
    kResetGroup,
    write,
  } = options;

  // Multiline: must buffer (patterns span lines)
  if (multiline) {
    return searchStreamMultilineFallback(lines, regex, options);
  }

  // Count-only mode: just count, emit at end
  if (countOnly || countMatches) {
    return searchStreamCount(lines, regex, {
      invertMatch,
      countMatches: countMatches || (countOnly && onlyMatching),
      filename,
      write,
    });
  }

  // Passthru mode: print all lines
  if (passthru) {
    return searchStreamPassthru(lines, regex, {
      invertMatch,
      showLineNumbers,
      filename,
      write,
    });
  }

  const hasContext = beforeContext > 0 || afterContext > 0;

  if (hasContext) {
    return searchStreamWithContext(lines, regex, {
      invertMatch,
      showLineNumbers,
      filename,
      onlyMatching,
      beforeContext,
      afterContext,
      maxCount,
      contextSeparator,
      replace,
      showColumn,
      showByteOffset,
      vimgrep,
      kResetGroup,
      write,
    });
  }

  // Fast path: no context, no multiline, no passthru, no count-only
  return searchStreamSimple(lines, regex, {
    invertMatch,
    showLineNumbers,
    filename,
    onlyMatching,
    maxCount,
    replace,
    showColumn,
    showByteOffset,
    vimgrep,
    kResetGroup,
    write,
  });
}

// ---------------------------------------------------------------------------
// Simple (no context)
// ---------------------------------------------------------------------------

async function searchStreamSimple(
  lines: AsyncIterable<string>,
  regex: UserRegex,
  opts: {
    invertMatch: boolean;
    showLineNumbers: boolean;
    filename: string;
    onlyMatching: boolean;
    maxCount: number;
    replace: string | null;
    showColumn: boolean;
    showByteOffset: boolean;
    vimgrep: boolean;
    kResetGroup?: number;
    write: (chunk: string) => Promise<void>;
  },
): Promise<{ matched: boolean; matchCount: number }> {
  let matchCount = 0;
  let lineNum = 0;
  let byteOffset = 0;

  for await (const rawLine of lines) {
    if (opts.maxCount > 0 && matchCount >= opts.maxCount) break;

    // Strip trailing newline for matching (lines from lineStream include it)
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    lineNum++;

    regex.lastIndex = 0;
    const matches = regex.test(line);

    if (matches !== opts.invertMatch) {
      matchCount++;

      if (opts.onlyMatching && !opts.invertMatch) {
        regex.lastIndex = 0;
        for (
          let match = regex.exec(line);
          match !== null;
          match = regex.exec(line)
        ) {
          const rawMatch =
            opts.kResetGroup !== undefined
              ? (match[opts.kResetGroup] ?? "")
              : match[0];
          const matchText = opts.replace !== null ? opts.replace : rawMatch;
          if (match[0].length === 0) {
            // Zero-length full match: skip output (matches real grep -o behavior)
            // and advance past this position to avoid infinite loop.
            regex.lastIndex++;
            if (regex.lastIndex > line.length) break;
            continue;
          }
          let prefix = opts.filename ? `${opts.filename}:` : "";
          if (opts.showByteOffset) prefix += `${byteOffset + match.index}:`;
          if (opts.showLineNumbers) prefix += `${lineNum}:`;
          if (opts.showColumn) prefix += `${match.index + 1}:`;
          await opts.write(`${prefix}${matchText}\n`);
        }
      } else if (opts.vimgrep) {
        regex.lastIndex = 0;
        for (
          let match = regex.exec(line);
          match !== null;
          match = regex.exec(line)
        ) {
          let prefix = opts.filename ? `${opts.filename}:` : "";
          if (opts.showByteOffset) prefix += `${byteOffset + match.index}:`;
          if (opts.showLineNumbers) prefix += `${lineNum}:`;
          if (opts.showColumn) prefix += `${match.index + 1}:`;
          await opts.write(`${prefix}${line}\n`);
          if (match[0].length === 0) regex.lastIndex++;
        }
      } else {
        regex.lastIndex = 0;
        const firstMatch = regex.exec(line);

        let outputLine = line;
        if (opts.replace !== null) {
          regex.lastIndex = 0;
          outputLine = regex.replace(line, (...args) => {
            const matchText = args[0] as string;
            if (matchText.length === 0) return "";
            return opts.replace as string;
          });
        }

        let prefix = opts.filename ? `${opts.filename}:` : "";
        if (opts.showByteOffset)
          prefix += `${byteOffset + (firstMatch ? firstMatch.index : 0)}:`;
        if (opts.showLineNumbers) prefix += `${lineNum}:`;
        if (opts.showColumn)
          prefix += `${firstMatch ? firstMatch.index + 1 : 1}:`;
        await opts.write(`${prefix}${outputLine}\n`);
      }
    }

    byteOffset += line.length + 1;
  }

  return { matched: matchCount > 0, matchCount };
}

// ---------------------------------------------------------------------------
// Context (sliding window)
// ---------------------------------------------------------------------------

async function searchStreamWithContext(
  lines: AsyncIterable<string>,
  regex: UserRegex,
  opts: {
    invertMatch: boolean;
    showLineNumbers: boolean;
    filename: string;
    onlyMatching: boolean;
    beforeContext: number;
    afterContext: number;
    maxCount: number;
    contextSeparator: string;
    replace: string | null;
    showColumn: boolean;
    showByteOffset: boolean;
    vimgrep: boolean;
    kResetGroup?: number;
    write: (chunk: string) => Promise<void>;
  },
): Promise<{ matched: boolean; matchCount: number }> {
  let matchCount = 0;
  let lineNum = 0;

  // Sliding window for before-context
  const beforeBuffer: { line: string; lineNum: number }[] = [];
  // Track how many after-context lines we still need to emit
  let afterRemaining = 0;
  // Track the last line number we emitted (to detect gaps for separators)
  let lastEmittedLine = -1;
  // Whether we've emitted any group yet
  let hasEmittedGroup = false;

  async function emitLine(
    line: string,
    num: number,
    isMatch: boolean,
  ): Promise<void> {
    // Gap separator
    if (hasEmittedGroup && lastEmittedLine >= 0 && num > lastEmittedLine + 1) {
      await opts.write(`${opts.contextSeparator}\n`);
    }
    hasEmittedGroup = true;
    lastEmittedLine = num;

    const sep = isMatch ? ":" : "-";
    let prefix = opts.filename ? `${opts.filename}${sep}` : "";
    if (opts.showLineNumbers) prefix += `${num}${sep}`;
    await opts.write(`${prefix}${line}\n`);
  }

  for await (const rawLine of lines) {
    if (opts.maxCount > 0 && matchCount >= opts.maxCount && afterRemaining <= 0)
      break;

    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    lineNum++;

    regex.lastIndex = 0;
    const matches = regex.test(line);
    const isMatch =
      matches !== opts.invertMatch &&
      (opts.maxCount <= 0 || matchCount < opts.maxCount);

    if (isMatch) {
      matchCount++;

      // Emit before-context from buffer
      for (const ctx of beforeBuffer) {
        if (ctx.lineNum > lastEmittedLine) {
          await emitLine(ctx.line, ctx.lineNum, false);
        }
      }
      beforeBuffer.length = 0;

      // Emit matching line
      if (opts.onlyMatching && !opts.invertMatch) {
        regex.lastIndex = 0;
        for (
          let match = regex.exec(line);
          match !== null;
          match = regex.exec(line)
        ) {
          const rawMatch =
            opts.kResetGroup !== undefined
              ? (match[opts.kResetGroup] ?? "")
              : match[0];
          const matchText = opts.replace !== null ? opts.replace : rawMatch;
          let prefix = opts.filename ? `${opts.filename}:` : "";
          if (opts.showLineNumbers) prefix += `${lineNum}:`;
          if (opts.showColumn) prefix += `${match.index + 1}:`;
          hasEmittedGroup = true;
          lastEmittedLine = lineNum;
          await opts.write(`${prefix}${matchText}\n`);
          if (match[0].length === 0) regex.lastIndex++;
        }
      } else {
        await emitLine(line, lineNum, true);
      }

      afterRemaining = opts.afterContext;
    } else if (afterRemaining > 0) {
      // After-context line
      await emitLine(line, lineNum, false);
      afterRemaining--;
    } else {
      // Non-matching, non-context: add to before-buffer
      beforeBuffer.push({ line, lineNum });
      if (beforeBuffer.length > opts.beforeContext) {
        beforeBuffer.shift();
      }
    }
  }

  return { matched: matchCount > 0, matchCount };
}

// ---------------------------------------------------------------------------
// Count-only
// ---------------------------------------------------------------------------

async function searchStreamCount(
  lines: AsyncIterable<string>,
  regex: UserRegex,
  opts: {
    invertMatch: boolean;
    countMatches: boolean;
    filename: string;
    write: (chunk: string) => Promise<void>;
  },
): Promise<{ matched: boolean; matchCount: number }> {
  let matchCount = 0;

  for await (const rawLine of lines) {
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    regex.lastIndex = 0;

    if (opts.countMatches) {
      for (
        let match = regex.exec(line);
        match !== null;
        match = regex.exec(line)
      ) {
        matchCount++;
        if (match[0].length === 0) regex.lastIndex++;
      }
    } else {
      if (regex.test(line) !== opts.invertMatch) {
        matchCount++;
      }
    }
  }

  const countStr = opts.filename
    ? `${opts.filename}:${matchCount}`
    : String(matchCount);
  await opts.write(`${countStr}\n`);
  return { matched: matchCount > 0, matchCount };
}

// ---------------------------------------------------------------------------
// Passthru
// ---------------------------------------------------------------------------

async function searchStreamPassthru(
  lines: AsyncIterable<string>,
  regex: UserRegex,
  opts: {
    invertMatch: boolean;
    showLineNumbers: boolean;
    filename: string;
    write: (chunk: string) => Promise<void>;
  },
): Promise<{ matched: boolean; matchCount: number }> {
  let matchCount = 0;
  let lineNum = 0;

  for await (const rawLine of lines) {
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    lineNum++;

    regex.lastIndex = 0;
    const matches = regex.test(line);
    const isMatch = matches !== opts.invertMatch;

    if (isMatch) matchCount++;

    const sep = isMatch ? ":" : "-";
    let prefix = opts.filename ? `${opts.filename}${sep}` : "";
    if (opts.showLineNumbers) prefix += `${lineNum}${sep}`;
    await opts.write(`${prefix}${line}\n`);
  }

  return { matched: matchCount > 0, matchCount };
}

// ---------------------------------------------------------------------------
// Multiline fallback (buffers all input)
// ---------------------------------------------------------------------------

async function searchStreamMultilineFallback(
  lines: AsyncIterable<string>,
  regex: UserRegex,
  options: StreamingSearchOptions,
): Promise<{ matched: boolean; matchCount: number }> {
  // Buffer all input — multiline patterns need the full content
  let content = "";
  for await (const line of lines) {
    content += line;
  }

  const result: SearchResult = searchContent(content, regex, options);
  if (result.output) {
    await options.write(result.output);
  }
  return { matched: result.matched, matchCount: result.matchCount };
}
