import { Schema, Stream } from "effect"
import type { OutputTransformer } from "../domain/CliAgent.ts"
import { streamFilterJson } from "../shared/stream.ts"
import { ansiColors } from "../shared/ansi-colors.ts"

export const claudeOutputTransformer: OutputTransformer = (stream) =>
  stream.pipe(
    streamFilterJson(StreamJsonMessage),
    Stream.map((m) => m.format()),
  )

// Schema definitions

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
})

const ToolUseResult = Schema.Struct({
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  interrupted: Schema.optional(Schema.Boolean),
  isImage: Schema.optional(Schema.Boolean),
})

class StreamJsonMessage extends Schema.Class<StreamJsonMessage>(
  "claude/StreamJsonMessage",
)({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      content: Schema.optional(Schema.Array(ContentBlock)),
    }),
  ),
  tool_use_result: Schema.optional(ToolUseResult),
  duration_ms: Schema.optional(Schema.Number),
  total_cost_usd: Schema.optional(Schema.Number),
}) {
  format(): string {
    switch (this.type) {
      case "system":
        return this.subtype === "init"
          ? ansiColors.dim + "[Session started]" + ansiColors.reset + "\n"
          : ""
      case "assistant":
        return formatAssistantMessage(this)
      case "user":
        return formatToolResult(this)
      case "result":
        return formatResult(this)
      default:
        return ""
    }
  }
}

const formatToolName = (name: string): string =>
  name.replace("mcp__", "").replace(/__/g, ":")

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + "..." : s

const formatAssistantMessage = (msg: StreamJsonMessage): string => {
  const content = msg.message?.content
  if (!content) return ""

  return content
    .map((block) => {
      if (block.type === "text" && block.text) {
        return block.text
      } else if (block.type === "tool_use" && block.name) {
        const toolDisplay =
          "\n" +
          ansiColors.cyan +
          "▶ " +
          formatToolName(block.name) +
          ansiColors.reset +
          "\n"

        // Show command for Bash
        if (block.name === "Bash" && block.input) {
          const cmd = (block.input as { command?: string }).command
          if (cmd) {
            return (
              toolDisplay +
              ansiColors.dim +
              "$ " +
              truncate(cmd, 100) +
              ansiColors.reset +
              "\n"
            )
          }
        }

        // Show question details for AskUserQuestion
        if (block.name === "AskUserQuestion" && block.input) {
          return toolDisplay + formatUserQuestion(block.input)
        }

        // Show file path for Read/Write/Edit
        if (
          (block.name === "Read" ||
            block.name === "Write" ||
            block.name === "Edit") &&
          block.input
        ) {
          const path = (block.input as { file_path?: string }).file_path
          if (path) {
            return toolDisplay + ansiColors.dim + path + ansiColors.reset + "\n"
          }
        }

        // Show pattern for Grep/Glob
        if ((block.name === "Grep" || block.name === "Glob") && block.input) {
          const pattern = (block.input as { pattern?: string }).pattern
          if (pattern) {
            return (
              toolDisplay + ansiColors.dim + pattern + ansiColors.reset + "\n"
            )
          }
        }

        return toolDisplay
      }
      return ""
    })
    .join("")
}

// Format tool results (stdout/stderr)
const formatToolResult = (msg: StreamJsonMessage): string => {
  const result = msg.tool_use_result
  if (!result) return ""

  let output = ""

  // Show stderr prominently (errors/warnings)
  if (result.stderr && result.stderr.trim()) {
    output +=
      ansiColors.yellow +
      "stderr: " +
      ansiColors.reset +
      truncate(result.stderr.trim(), 500) +
      "\n"
  }

  // Show interrupted state
  if (result.interrupted) {
    output += ansiColors.yellow + "[interrupted]" + ansiColors.reset + "\n"
  }

  // Show stdout (truncated for long output)
  if (result.stdout && result.stdout.trim()) {
    const lines = result.stdout.trim().split("\n")
    if (lines.length > 5) {
      // Show first 3 and last 2 lines
      const preview = [
        ...lines.slice(0, 3),
        ansiColors.dim +
          `... (${lines.length - 5} more lines)` +
          ansiColors.reset,
        ...lines.slice(-2),
      ].join("\n")
      output += ansiColors.dim + preview + ansiColors.reset + "\n"
    } else {
      output += ansiColors.dim + result.stdout.trim() + ansiColors.reset + "\n"
    }
  }

  return output
}

// Format user questions for visibility
const formatUserQuestion = (input: unknown): string => {
  try {
    const data = input as {
      questions?: Array<{
        question: string
        header?: string
        options?: Array<{ label: string; description?: string }>
      }>
    }
    if (!data.questions) return ""

    return data.questions
      .map((q) => {
        let result =
          "\n" +
          ansiColors.yellow +
          "⚠ WAITING FOR INPUT" +
          ansiColors.reset +
          "\n"
        result +=
          ansiColors.cyan +
          (q.header ? `[${q.header}] ` : "") +
          q.question +
          ansiColors.reset +
          "\n"
        if (q.options) {
          result +=
            q.options
              .map(
                (opt, i) =>
                  `  ${i + 1}. ${opt.label}${opt.description ? ansiColors.dim + ` - ${opt.description}` + ansiColors.reset : ""}`,
              )
              .join("\n") + "\n"
        }
        return result
      })
      .join("\n")
  } catch {
    return ""
  }
}

const formatResult = (msg: StreamJsonMessage): string => {
  if (msg.subtype === "success") {
    const duration = msg.duration_ms
      ? (msg.duration_ms / 1000).toFixed(1) + "s"
      : ""
    const cost = msg.total_cost_usd ? "$" + msg.total_cost_usd.toFixed(4) : ""
    const info = [duration, cost].filter(Boolean).join(" | ")
    return (
      "\n" +
      ansiColors.green +
      "✓ Done" +
      ansiColors.reset +
      " " +
      ansiColors.dim +
      info +
      ansiColors.reset +
      "\n"
    )
  } else if (msg.subtype === "error") {
    return "\n" + ansiColors.yellow + "✗ Error" + ansiColors.reset + "\n"
  }
  return ""
}
