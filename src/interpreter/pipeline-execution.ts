/**
 * Pipeline Execution
 *
 * Handles execution of command pipelines (cmd1 | cmd2 | cmd3).
 *
 * Multi-command pipelines run all stages concurrently, connected by
 * PipeChannels. Streaming-capable commands (cat, head) read/write
 * incrementally; all other commands are wrapped with buffered I/O.
 */

import type { CommandNode, PipelineNode } from "../ast/types.js";
import { _performanceNow } from "../security/trusted-globals.js";
import type { ExecResult } from "../types.js";
import { BadSubstitutionError, ErrexitError, ExitError } from "./errors.js";
import { OK } from "./helpers/result.js";
import { BrokenPipeError, PipeChannel } from "./pipe-channel.js";
import type { InterpreterContext } from "./types.js";

/**
 * Streaming context threaded through to a command execution.
 * Allows commands to do incremental I/O instead of buffered strings.
 */
export interface StreamContext {
  /** Write stdout chunk. Always available for streaming commands. */
  writeStdout: (chunk: string) => Promise<void>;
  writeStderr: (chunk: string) => void;
  stdinStream?: AsyncIterable<string>;
  abortUpstream: () => void;
  /**
   * Collected stdout from writeStdout calls (last-stage only).
   * The interpreter merges this into ExecResult.stdout before
   * applying redirections, so commands don't need to know their
   * pipeline position.
   */
  collectedStdout?: string;
}

/**
 * Type for executeCommand callback.
 * The optional streamCtx enables streaming I/O for pipeline stages.
 */
export type ExecuteCommandFn = (
  node: CommandNode,
  stdin: string,
  streamCtx?: StreamContext,
) => Promise<ExecResult>;

/**
 * Check if a CommandNode is a SimpleCommand whose registered command
 * has `streaming: true`. Functions override commands, so a function
 * with the same name disables streaming.
 */
function isStreamingCommand(
  node: CommandNode,
  ctx: InterpreterContext,
): boolean {
  if (node.type !== "SimpleCommand" || !node.name) return false;
  if (node.name.parts.length !== 1 || node.name.parts[0].type !== "Literal")
    return false;
  const name = node.name.parts[0].value;
  // Functions override commands
  if (ctx.state.functions.has(name)) return false;
  const cmd = ctx.commands.get(name);
  return cmd?.streaming === true;
}

/**
 * Execute a pipeline node (command or sequence of piped commands).
 */
export async function executePipeline(
  ctx: InterpreterContext,
  node: PipelineNode,
  executeCommand: ExecuteCommandFn,
): Promise<ExecResult> {
  // Record start time for timed pipelines
  const startTime = node.timed ? _performanceNow() : 0;

  // Single-command pipeline: fast path (no channels needed)
  if (node.commands.length <= 1) {
    return executeSingleCommandPipeline(ctx, node, executeCommand, startTime);
  }

  // Multi-command pipeline: concurrent execution with PipeChannels
  return executeMultiCommandPipeline(ctx, node, executeCommand, startTime);
}

/**
 * Fast path for single-command pipelines — identical to old behavior.
 */
async function executeSingleCommandPipeline(
  ctx: InterpreterContext,
  node: PipelineNode,
  executeCommand: ExecuteCommandFn,
  startTime: number,
): Promise<ExecResult> {
  const command = node.commands[0];
  let lastResult: ExecResult;

  try {
    lastResult = await executeCommand(command, "");
  } catch (error) {
    if (error instanceof BadSubstitutionError) {
      lastResult = {
        stdout: error.stdout,
        stderr: error.stderr,
        exitCode: 1,
      };
    } else {
      throw error;
    }
  }

  // PIPESTATUS for single SimpleCommand
  if (command.type === "SimpleCommand") {
    setPipestatus(ctx, [lastResult.exitCode]);
  }

  lastResult = applyNegation(node, lastResult);
  lastResult = applyTiming(node, lastResult, startTime);
  return lastResult;
}

/**
 * Concurrent multi-command pipeline.
 *
 * Creates N-1 PipeChannels connecting N stages. Each stage runs as a
 * concurrent Promise. Non-streaming commands are wrapped: input channel
 * is drained to a string, command runs as before, output is pushed to
 * the next channel. Streaming commands get the channel directly.
 */
async function executeMultiCommandPipeline(
  ctx: InterpreterContext,
  node: PipelineNode,
  executeCommand: ExecuteCommandFn,
  startTime: number,
): Promise<ExecResult> {
  const n = node.commands.length;
  const savedLastArg = ctx.state.lastArg;

  // Create N-1 channels between stages
  const channels: PipeChannel[] = [];
  for (let i = 0; i < n - 1; i++) {
    channels.push(new PipeChannel());
  }

  // Determine which stages are streaming
  const streamingFlags = node.commands.map((cmd) =>
    isStreamingCommand(cmd, ctx),
  );

  // Track per-stage results
  interface StageResult {
    result: ExecResult;
    index: number;
  }

  // Launch all stages concurrently
  const stagePromises: Promise<StageResult>[] = node.commands.map(
    (command, i) => {
      const isFirst = i === 0;
      const isLast = i === n - 1;
      const inputChannel = isFirst ? null : channels[i - 1];
      const outputChannel = isLast ? null : channels[i];
      const pipeStderrToNext = !isLast && (node.pipeStderr?.[i] ?? false);
      const isStreaming = streamingFlags[i];
      const runsInSubshell = !isLast || !ctx.state.shoptOptions.lastpipe;

      return runStage(
        ctx,
        command,
        executeCommand,
        inputChannel,
        outputChannel,
        pipeStderrToNext,
        isStreaming,
        runsInSubshell,
        isFirst,
        i,
      );
    },
  );

  // Await all stages
  const settled = await Promise.allSettled(stagePromises);

  // Collect results
  const pipestatusExitCodes: number[] = [];
  let accumulatedStderr = "";
  let lastResult: ExecResult = OK;
  const stageErrors: unknown[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const isLast = i === n - 1;

    if (outcome.status === "fulfilled") {
      const { result } = outcome.value;
      pipestatusExitCodes.push(result.exitCode);

      if (!isLast) {
        const pipeStderrToNext = node.pipeStderr?.[i] ?? false;
        if (!pipeStderrToNext) {
          accumulatedStderr += result.stderr;
        }
      } else {
        lastResult = result;
      }
    } else {
      // Stage rejected — check if it's a control flow error we should handle
      const error = outcome.reason;
      if (error instanceof BadSubstitutionError) {
        pipestatusExitCodes.push(1);
        if (!isLast) {
          accumulatedStderr += error.stderr;
        } else {
          lastResult = {
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: 1,
          };
        }
      } else if (error instanceof ExitError) {
        pipestatusExitCodes.push(error.exitCode);
        if (!isLast) {
          accumulatedStderr += error.stderr;
        } else {
          lastResult = {
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: error.exitCode,
          };
        }
      } else if (error instanceof ErrexitError) {
        pipestatusExitCodes.push(error.exitCode);
        if (!isLast) {
          accumulatedStderr += error.stderr;
        } else {
          lastResult = {
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: error.exitCode,
          };
        }
      } else {
        // Fatal error — collect and re-throw after cleanup
        stageErrors.push(error);
        pipestatusExitCodes.push(1);
      }
    }
  }

  // If any stage had a fatal error, re-throw the first one
  if (stageErrors.length > 0) {
    throw stageErrors[0];
  }

  // Merge stderr from non-last stages
  if (accumulatedStderr) {
    lastResult = {
      ...lastResult,
      stderr: accumulatedStderr + lastResult.stderr,
    };
  }

  // Set PIPESTATUS
  setPipestatus(ctx, pipestatusExitCodes);

  // Pipefail: use rightmost failing exit code
  if (ctx.state.options.pipefail) {
    let pipefailExitCode = 0;
    for (const code of pipestatusExitCodes) {
      if (code !== 0) pipefailExitCode = code;
    }
    if (pipefailExitCode !== 0) {
      lastResult = { ...lastResult, exitCode: pipefailExitCode };
    }
  }

  // Handle $_ restoration
  if (!ctx.state.shoptOptions.lastpipe) {
    ctx.state.lastArg = savedLastArg;
  }

  lastResult = applyNegation(node, lastResult);
  lastResult = applyTiming(node, lastResult, startTime);
  return lastResult;
}

/**
 * Run a single pipeline stage. Handles both streaming and non-streaming
 * commands, env save/restore for subshell context, and error translation.
 */
async function runStage(
  ctx: InterpreterContext,
  command: CommandNode,
  executeCommand: ExecuteCommandFn,
  inputChannel: PipeChannel | null,
  outputChannel: PipeChannel | null,
  pipeStderrToNext: boolean,
  isStreaming: boolean,
  runsInSubshell: boolean,
  isFirst: boolean,
  index: number,
): Promise<{ result: ExecResult; index: number }> {
  // Subshell context: save env
  const savedEnv = runsInSubshell ? new Map(ctx.state.env) : null;

  // Clear $_ for pipeline commands
  ctx.state.lastArg = "";

  // After the first command, clear groupStdin
  if (!isFirst) {
    ctx.state.groupStdin = undefined;
  }

  try {
    let result: ExecResult;

    if (isStreaming && (inputChannel || outputChannel)) {
      // Track A — streaming command
      result = await runStreamingStage(
        command,
        executeCommand,
        inputChannel,
        outputChannel,
        pipeStderrToNext,
      );
    } else {
      // Track B — non-streaming (buffered) command
      result = await runBufferedStage(
        command,
        executeCommand,
        inputChannel,
        outputChannel,
        pipeStderrToNext,
      );
    }

    return { result, index };
  } catch (error) {
    // Close output channel on error so downstream doesn't hang
    if (outputChannel) outputChannel.close();
    throw error;
  } finally {
    // Restore env for subshell commands
    if (savedEnv) {
      ctx.state.env = savedEnv;
    }
  }
}

/**
 * Run a non-streaming stage:
 * 1. Drain input channel into a string
 * 2. Execute command with buffered stdin
 * 3. Write stdout to output channel
 * 4. Close output channel
 */
async function runBufferedStage(
  command: CommandNode,
  executeCommand: ExecuteCommandFn,
  inputChannel: PipeChannel | null,
  outputChannel: PipeChannel | null,
  pipeStderrToNext: boolean,
): Promise<ExecResult> {
  // Drain input channel
  let stdin = "";
  if (inputChannel) {
    for await (const chunk of inputChannel) {
      stdin += chunk;
    }
  }

  let result: ExecResult;
  try {
    result = await executeCommand(command, stdin);
  } catch (error) {
    if (outputChannel) outputChannel.close();
    throw error;
  }

  // Push output to next stage
  if (outputChannel) {
    try {
      const output = pipeStderrToNext
        ? result.stderr + result.stdout
        : result.stdout;
      if (output) {
        await outputChannel.write(output);
      }
    } catch (error) {
      if (error instanceof BrokenPipeError) {
        // Downstream aborted — record SIGPIPE exit code
        outputChannel.close();
        return {
          stdout: "",
          stderr: pipeStderrToNext ? "" : result.stderr,
          exitCode: 141,
        };
      }
      throw error;
    }
    outputChannel.close();

    // Non-last stages: return with cleared stdout (already piped)
    if (pipeStderrToNext) {
      return { stdout: "", stderr: "", exitCode: result.exitCode };
    }
    return { stdout: "", stderr: result.stderr, exitCode: result.exitCode };
  }

  return result;
}

/**
 * Run a streaming stage:
 * 1. Build a StreamContext from input/output channels
 * 2. Execute command with streamCtx
 * 3. Close output channel when done
 */
async function runStreamingStage(
  command: CommandNode,
  executeCommand: ExecuteCommandFn,
  inputChannel: PipeChannel | null,
  outputChannel: PipeChannel | null,
  pipeStderrToNext: boolean,
): Promise<ExecResult> {
  let stageStderr = "";

  const streamCtx: StreamContext = {
    // writeStdout always works. Middle stages push to the channel;
    // last stage collects into streamCtx.collectedStdout which the
    // interpreter merges into ExecResult before applying redirections.
    writeStdout: outputChannel
      ? async (chunk: string) => {
          await outputChannel.write(chunk);
        }
      : async (chunk: string) => {
          streamCtx.collectedStdout = (streamCtx.collectedStdout ?? "") + chunk;
        },
    writeStderr: (chunk: string) => {
      stageStderr += chunk;
    },
    stdinStream: inputChannel ?? undefined,
    abortUpstream: () => {
      if (inputChannel) inputChannel.abort();
    },
  };

  let result: ExecResult;
  try {
    result = await executeCommand(command, "", streamCtx);
  } catch (error) {
    if (outputChannel) outputChannel.close();
    throw error;
  }

  if (outputChannel) {
    // Output was already pushed via writeStdout during command execution.
    // Just close the channel.
    outputChannel.close();

    if (pipeStderrToNext) {
      return { stdout: "", stderr: "", exitCode: result.exitCode };
    }
    return {
      stdout: "",
      stderr: stageStderr + result.stderr,
      exitCode: result.exitCode,
    };
  }

  // Last stage — collectedStdout is merged into ExecResult by the
  // interpreter (before redirections). Merge any streaming stderr here.
  if (stageStderr) {
    result = { ...result, stderr: stageStderr + result.stderr };
  }
  return result;
}

// ============================================================================
// Shared helpers
// ============================================================================

function setPipestatus(ctx: InterpreterContext, codes: number[]): void {
  // Clear previous entries
  for (const key of ctx.state.env.keys()) {
    if (key.startsWith("PIPESTATUS_")) {
      ctx.state.env.delete(key);
    }
  }
  for (let i = 0; i < codes.length; i++) {
    ctx.state.env.set(`PIPESTATUS_${i}`, String(codes[i]));
  }
  ctx.state.env.set("PIPESTATUS__length", String(codes.length));
}

function applyNegation(node: PipelineNode, result: ExecResult): ExecResult {
  if (node.negated) {
    return { ...result, exitCode: result.exitCode === 0 ? 1 : 0 };
  }
  return result;
}

function applyTiming(
  node: PipelineNode,
  result: ExecResult,
  startTime: number,
): ExecResult {
  if (!node.timed) return result;

  const endTime = _performanceNow();
  const elapsedSeconds = (endTime - startTime) / 1000;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  let timingOutput: string;
  if (node.timePosix) {
    timingOutput = `real ${elapsedSeconds.toFixed(2)}\nuser 0.00\nsys 0.00\n`;
  } else {
    const realStr = `${minutes}m${seconds.toFixed(3)}s`;
    timingOutput = `\nreal\t${realStr}\nuser\t0m0.000s\nsys\t0m0.000s\n`;
  }

  return { ...result, stderr: result.stderr + timingOutput };
}
