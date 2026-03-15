import type { Command, CommandContext, ExecResult } from "../../types.js";

/**
 * seq - print a sequence of numbers
 *
 * Usage:
 *   seq LAST           - print numbers from 1 to LAST
 *   seq FIRST LAST     - print numbers from FIRST to LAST
 *   seq FIRST INCR LAST - print numbers from FIRST to LAST by INCR
 *
 * Options:
 *   -s STRING  use STRING to separate numbers (default: newline)
 *   -w         equalize width by padding with leading zeros
 */
export const seqCommand: Command = {
  name: "seq",
  streaming: true,

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let separator = "\n";
    let equalizeWidth = false;
    const nums: string[] = [];

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg === "-s" && i + 1 < args.length) {
        separator = args[i + 1];
        i += 2;
        continue;
      }

      if (arg === "-w") {
        equalizeWidth = true;
        i++;
        continue;
      }

      if (arg === "--") {
        i++;
        break;
      }

      if (arg.startsWith("-") && arg !== "-") {
        // Check for combined flags or -sSTRING
        if (arg.startsWith("-s") && arg.length > 2) {
          separator = arg.slice(2);
          i++;
          continue;
        }
        if (arg === "-ws" || arg === "-sw") {
          equalizeWidth = true;
          if (i + 1 < args.length) {
            separator = args[i + 1];
            i += 2;
            continue;
          }
        }
        // Unknown option - treat as number (might be negative)
      }

      nums.push(arg);
      i++;
    }

    // Collect remaining args as numbers
    while (i < args.length) {
      nums.push(args[i]);
      i++;
    }

    if (nums.length === 0) {
      return {
        stdout: "",
        stderr: "seq: missing operand\n",
        exitCode: 1,
      };
    }

    let first = 1;
    let increment = 1;
    let last: number;

    if (nums.length === 1) {
      last = parseFloat(nums[0]);
    } else if (nums.length === 2) {
      first = parseFloat(nums[0]);
      last = parseFloat(nums[1]);
    } else {
      first = parseFloat(nums[0]);
      increment = parseFloat(nums[1]);
      last = parseFloat(nums[2]);
    }

    // Validate numbers
    if (Number.isNaN(first) || Number.isNaN(increment) || Number.isNaN(last)) {
      const invalid = nums.find((n) => Number.isNaN(parseFloat(n)));
      return {
        stdout: "",
        stderr: `seq: invalid floating point argument: '${invalid}'\n`,
        exitCode: 1,
      };
    }

    if (increment === 0) {
      return {
        stdout: "",
        stderr: "seq: invalid Zero increment value: '0'\n",
        exitCode: 1,
      };
    }

    // Determine precision for floating point
    const getPrecision = (n: number): number => {
      const str = String(n);
      const dotIndex = str.indexOf(".");
      return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
    };

    const precision = Math.max(
      getPrecision(first),
      getPrecision(increment),
      getPrecision(last),
    );

    const formatNum = (n: number): string =>
      precision > 0 ? n.toFixed(precision) : String(Math.round(n));

    // For -w, we need to know the widest number upfront
    let padWidth = 0;
    if (equalizeWidth) {
      const firstStr = formatNum(first).replace("-", "");
      const lastStr = formatNum(last).replace("-", "");
      padWidth = Math.max(firstStr.length, lastStr.length);
    }

    const pad = (s: string): string => {
      if (!equalizeWidth) return s;
      const isNegative = s.startsWith("-");
      const num = isNegative ? s.slice(1) : s;
      const padded = num.padStart(padWidth, "0");
      return isNegative ? `-${padded}` : padded;
    };

    // Stream numbers one at a time. No array, no accumulation, no limit.
    // Backpressure from writeStdout naturally throttles generation.
    // `seq 1 1000000000000 | head -n 5` emits 5 numbers instantly.
    let isFirst = true;

    if (increment > 0) {
      for (let n = first; n <= last + 1e-10; n += increment) {
        await ctx.writeStdout(
          `${isFirst ? "" : separator}${pad(formatNum(n))}`,
        );
        isFirst = false;
      }
    } else {
      for (let n = first; n >= last - 1e-10; n += increment) {
        await ctx.writeStdout(
          `${isFirst ? "" : separator}${pad(formatNum(n))}`,
        );
        isFirst = false;
      }
    }
    if (!isFirst) {
      await ctx.writeStdout("\n");
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "seq",
  flags: [
    { flag: "-s", type: "value", valueHint: "string" },
    { flag: "-w", type: "boolean" },
  ],
  needsArgs: true,
};
