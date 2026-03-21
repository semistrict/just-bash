import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

const openrouter = createOpenRouter();

const SYSTEM_INSTRUCTIONS = `You are an expert on just-bash, a TypeScript bash interpreter with an in-memory virtual filesystem.

You have access to a bash sandbox with the source code of just-bash and bash-tool.

Use the sandbox to explore the source code, demonstrate commands, and help users understand:
- How to use just-bash and bash-tool
- Bash scripting in general
- The implementation details of just-bash

Key features of just-bash:
- Pure TypeScript implementation (no WASM dependencies)
- In-memory virtual filesystem
- Supports common bash commands: ls, cat, grep, awk, sed, jq, etc.
- Custom command support via defineCommand
- Network access control with URL allowlists

Use cat to read files. Use head, tail to read parts of large files.

Keep responses concise. You do not have access to pnpm, npm, or node.`;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openrouter("openai/gpt-5.4-mini"),
    system: SYSTEM_INSTRUCTIONS,
    messages: await convertToModelMessages(messages),
    tools: {
      bash: {
        description: "Execute a bash command in the sandbox",
        inputSchema: z.object({
          command: z.string().describe("The bash command to execute"),
        }),
        // No execute — tool calls are resolved client-side
      },
    },
  });

  return result.toUIMessageStreamResponse();
}
