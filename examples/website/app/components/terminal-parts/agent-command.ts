import { defineCommand } from "just-bash/browser";
import type { Command } from "just-bash/browser";
import { MAX_TOOL_OUTPUT_LINES } from "./constants";
import { formatMarkdown } from "./markdown";

type UIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<Record<string, unknown>>;
};

function sanitizeTerminalError(message: string): string {
  return message
    .replace(/\n\s+at\s.*/g, "")
    .replace(/node:internal\/[^\s'",)}\]:]+/g, "<internal>")
    .replace(
      /(?:\/(?:Users|home|private|var|opt|Library|System|usr|etc|tmp|nix|snap))\b[^\s'",)}\]:]*/g,
      "<path>",
    )
    .replace(/[A-Z]:\\[^\s'",)}\]:]+/g, "<path>");
}

function formatToolOutput(output: string): string {
  if (!output || !output.trim()) return "";
  const resultLines = output.split("\n").filter((l) => l.trim());
  const linesToShow = resultLines.slice(0, MAX_TOOL_OUTPUT_LINES);
  let formatted = linesToShow
    .map((line) => `\x1b[2m${line}\x1b[0m`)
    .join("\n");
  if (resultLines.length > MAX_TOOL_OUTPUT_LINES) {
    formatted += `\n\x1b[2m... (${resultLines.length - MAX_TOOL_OUTPUT_LINES} more lines)\x1b[0m`;
  }
  return formatted + "\n";
}

/**
 * Parse SSE stream and yield events. Collects text parts and tool calls.
 * Returns the assistant message parts when the stream ends.
 */
async function processStream(
  response: Response,
  writeStdout: (chunk: string) => Promise<void>,
  writeStderr: (chunk: string) => Promise<void>,
): Promise<{
  parts: Array<Record<string, unknown>>;
  toolCalls: Map<string, { toolName: string; input: unknown }>;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const parts: Array<Record<string, unknown>> = [];
  const toolCalls = new Map<string, { toolName: string; input: unknown }>();
  const decoder = new TextDecoder();
  let buffer = "";
  let lineBuffer = "";
  let isReasoning = false;

  let thinkingTimeout: ReturnType<typeof setTimeout> | null = null;
  let showingThinking = false;

  const showThinking = async () => {
    if (!showingThinking) {
      showingThinking = true;
      await writeStdout("\x1b[2mThinking...\x1b[0m");
    }
  };

  const clearThinking = async (restart = true) => {
    if (showingThinking) {
      await writeStdout("\r\x1b[K");
      showingThinking = false;
    }
    if (thinkingTimeout) {
      clearTimeout(thinkingTimeout);
      thinkingTimeout = null;
    }
    if (restart) {
      thinkingTimeout = setTimeout(showThinking, 500);
    }
  };

  const resetThinkingTimer = () => {
    if (thinkingTimeout) clearTimeout(thinkingTimeout);
    if (!showingThinking) {
      thinkingTimeout = setTimeout(showThinking, 500);
    }
  };

  resetThinkingTimer();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") continue;

      try {
        // biome-ignore lint/suspicious/noExplicitAny: SSE data has dynamic shape
        const data = JSON.parse(jsonStr) as any;

        if (data.type === "text-delta" && data.delta) {
          lineBuffer += data.delta;
          const lastNewline = lineBuffer.lastIndexOf("\n");
          if (lastNewline !== -1) {
            await clearThinking();
            const completeLines = lineBuffer.slice(0, lastNewline + 1);
            lineBuffer = lineBuffer.slice(lastNewline + 1);
            await writeStdout(formatMarkdown(completeLines));
          } else {
            resetThinkingTimer();
          }
        } else if (data.type === "text-end") {
          await clearThinking();
          if (lineBuffer) {
            await writeStdout(formatMarkdown(lineBuffer));
            lineBuffer = "";
          }
          await writeStdout("\n");
          // Collect text into parts
          const fullText = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
          if (!fullText && data.delta) {
            // text-end doesn't carry the full text; we build it from deltas below
          }
        } else if (data.type === "text-start") {
          parts.push({ type: "text", text: "" });
        } else if (
          data.type === "text-delta" &&
          !data.delta &&
          parts.length > 0
        ) {
          // skip empty deltas
        } else if (
          data.type === "tool-input-available" &&
          data.toolCallId
        ) {
          await clearThinking();
          const toolArgs = data.input as Record<string, unknown>;
          if (data.toolName === "bash" && toolArgs.command) {
            const cmd = String(toolArgs.command).replace(/\t/g, "  ");
            const cmdLines = cmd.split("\n");
            await writeStdout(`\x1b[36m$ ${cmdLines[0]}\x1b[0m\n`);
            for (let i = 1; i < cmdLines.length; i++) {
              await writeStdout(`\x1b[36m${cmdLines[i]}\x1b[0m\n`);
            }
          } else {
            await writeStdout(
              `\x1b[36m[${data.toolName}]\x1b[0m\n`,
            );
          }
          toolCalls.set(data.toolCallId, {
            toolName: data.toolName,
            input: data.input,
          });
          // Add tool part to assistant message (state will be updated after execution)
          parts.push({
            type: `tool-${data.toolName}`,
            toolCallId: data.toolCallId,
            state: "input-available",
            input: data.input,
          });
        } else if (data.type === "reasoning-start") {
          await clearThinking();
          isReasoning = true;
          await writeStdout("\x1b[2m\x1b[3m");
        } else if (data.type === "reasoning-delta" && data.delta) {
          await writeStdout(data.delta as string);
          resetThinkingTimer();
        } else if (data.type === "reasoning-end") {
          if (isReasoning) {
            await writeStdout("\x1b[0m\n");
            isReasoning = false;
          }
        } else if (data.type === "error") {
          const errorMsg = data.error || data.message || "Unknown error";
          await writeStderr(
            `\x1b[31mError: ${String(errorMsg)}\x1b[0m\n`,
          );
        }
      } catch (e) {
        console.log("Parse error for line:", trimmed, e);
      }
    }
  }

  await clearThinking(false);
  if (lineBuffer) {
    await writeStdout(formatMarkdown(lineBuffer) + "\n");
  }

  // Build text content from deltas that were accumulated
  // (text parts were tracked via text-start but content came from text-delta)
  // We need to reconstruct the full text from what was written
  return { parts, toolCalls };
}

export function createAgentCommand(): Command {
  const messages: UIMessage[] = [];
  let messageIdCounter = 0;

  const agentCmd = defineCommand("agent", async (args, ctx) => {
    const prompt = args.join(" ");
    if (!prompt) {
      return {
        stdout: "",
        stderr:
          "Usage: agent <message>\nExample: agent how do I use custom commands?\n\nThis is a multi-turn chat. Use 'agent reset' to clear history.\n",
        exitCode: 1,
      };
    }

    if (prompt.toLowerCase() === "reset") {
      messages.length = 0;
      return { stdout: "Agent conversation reset.\n", stderr: "", exitCode: 0 };
    }

    // Add user message
    messages.push({
      id: `msg-${++messageIdCounter}`,
      role: "user",
      parts: [{ type: "text", text: prompt }],
    });

    try {
      // Tool loop: keep calling the server until no more tool calls
      let maxIterations = 20;
      while (maxIterations-- > 0) {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
        });

        if (!response.ok) {
          messages.pop();
          return {
            stdout: "",
            stderr: `Error: ${response.status}\n`,
            exitCode: 1,
          };
        }

        const { parts, toolCalls } = await processStream(
          response,
          ctx.writeStdout,
          ctx.writeStderr,
        );

        if (toolCalls.size === 0) {
          // No tool calls — done. Save assistant message with text parts only.
          const textParts = parts.filter((p) => p.type === "text");
          if (textParts.length > 0) {
            messages.push({
              id: `msg-${++messageIdCounter}`,
              role: "assistant",
              parts: textParts,
            });
          }
          break;
        }

        // Execute tool calls locally in the browser's just-bash
        for (const [toolCallId, { toolName, input }] of toolCalls) {
          const toolPart = parts.find(
            (p) => p.toolCallId === toolCallId,
          );

          if (toolName === "bash" && ctx.exec) {
            const command = (input as { command: string }).command;
            const result = await ctx.exec(command, { cwd: ctx.cwd });

            // Display result
            const display = result.stderr?.trim()
              ? `stderr: ${result.stderr}`
              : result.stdout;
            const formatted = formatToolOutput(display);
            if (formatted) await ctx.writeStdout(formatted);

            // Update part with output
            if (toolPart) {
              toolPart.state = "output-available";
              toolPart.output = JSON.stringify({
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
              });
            }
          } else {
            // Unknown tool
            if (toolPart) {
              toolPart.state = "output-error";
              toolPart.errorText = `Unknown tool: ${toolName}`;
            }
          }
        }

        // Add assistant message with tool results and re-submit
        messages.push({
          id: `msg-${++messageIdCounter}`,
          role: "assistant",
          parts,
        });
      }

      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (error) {
      const message = sanitizeTerminalError(
        error instanceof Error ? error.message : "Unknown error",
      );
      messages.pop();
      return { stdout: "", stderr: `Error: ${message}\n`, exitCode: 1 };
    }
  });

  (agentCmd as { streaming?: boolean }).streaming = true;
  return agentCmd;
}
