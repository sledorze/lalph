import { Option, pipe, Schema, Stream } from "effect"
import type { OutputTransformer } from "../domain/CliAgent.ts"
import { streamFilterJson } from "../shared/stream.ts"
import { ansiColors } from "../shared/ansi-colors.ts"

// -----------------------------------------------------------------------------
// Tool Input Schemas
// -----------------------------------------------------------------------------

const BashInput = Schema.Struct({
  command: Schema.optional(Schema.String),
})

const FileInput = Schema.Struct({
  file_path: Schema.optional(Schema.String),
})

const PatternInput = Schema.Struct({
  pattern: Schema.optional(Schema.String),
})

const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
})

const Question = Schema.Struct({
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(QuestionOption)),
})

const AskUserQuestionInput = Schema.Struct({
  questions: Schema.optional(Schema.Array(Question)),
})

// MCP tools use various field names for their inputs
const McpInputFields = [
  "query",
  "documentId",
  "page",
  "pattern",
  "relative_path",
  "name_path",
  "file_path",
  "root_path",
] as const

// -----------------------------------------------------------------------------
// Message Schemas
// -----------------------------------------------------------------------------

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
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

// -----------------------------------------------------------------------------
// Output Transformer
// -----------------------------------------------------------------------------

export const claudeOutputTransformer: OutputTransformer = (stream) =>
  stream.pipe(
    streamFilterJson(StreamJsonMessage),
    Stream.map((m) => m.format()),
  )

// -----------------------------------------------------------------------------
// Formatting Helpers
// -----------------------------------------------------------------------------

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + "..." : s

const formatToolName = (name: string): string =>
  name.replace("mcp__", "").replace(/__/g, ":")

const dim = (s: string): string => ansiColors.dim + s + ansiColors.reset

const cyan = (s: string): string => ansiColors.cyan + s + ansiColors.reset

const yellow = (s: string): string => ansiColors.yellow + s + ansiColors.reset

const green = (s: string): string => ansiColors.green + s + ansiColors.reset

// -----------------------------------------------------------------------------
// Tool Input Formatters
// -----------------------------------------------------------------------------

const formatBashInput = (input: unknown): Option.Option<string> =>
  pipe(
    Schema.decodeUnknownOption(BashInput)(input),
    Option.filter((data) => data.command !== undefined),
    Option.map((data) => dim("$ " + truncate(data.command!, 100))),
  )

const formatFileInput = (input: unknown): Option.Option<string> =>
  pipe(
    Schema.decodeUnknownOption(FileInput)(input),
    Option.filter((data) => data.file_path !== undefined),
    Option.map((data) => dim(data.file_path!)),
  )

const formatPatternInput = (input: unknown): Option.Option<string> =>
  pipe(
    Schema.decodeUnknownOption(PatternInput)(input),
    Option.filter((data) => data.pattern !== undefined),
    Option.map((data) => dim(data.pattern!)),
  )

const formatMcpInput = (input: unknown): Option.Option<string> => {
  if (typeof input !== "object" || input === null) {
    return Option.none()
  }
  const data = input as Record<string, unknown>
  const parts: Array<string> = []
  for (const field of McpInputFields) {
    const value = data[field]
    if (value !== undefined) {
      parts.push(`${field}=${truncate(String(value), 50)}`)
    }
  }
  return parts.length > 0 ? Option.some(dim(parts.join(" "))) : Option.none()
}

const formatGenericInput = (input: unknown): Option.Option<string> => {
  if (input === undefined || input === null) {
    return Option.none()
  }
  const json = JSON.stringify(input)
  return Option.some(dim(truncate(json, 100)))
}

type DecodedQuestion = typeof Question.Encoded

const formatUserQuestion = (input: unknown): string =>
  pipe(
    Schema.decodeUnknownOption(AskUserQuestionInput)(input),
    Option.filter((data) => data.questions !== undefined),
    Option.map((data) =>
      data
        .questions!.map((q: DecodedQuestion) => {
          let result = "\n" + yellow("⚠ WAITING FOR INPUT") + "\n"
          result += cyan((q.header ? `[${q.header}] ` : "") + q.question) + "\n"
          if (q.options) {
            result +=
              q.options
                .map(
                  (opt, i) =>
                    `  ${i + 1}. ${opt.label}${opt.description ? dim(` - ${opt.description}`) : ""}`,
                )
                .join("\n") + "\n"
          }
          return result
        })
        .join("\n"),
    ),
    Option.getOrElse(() => ""),
  )

// -----------------------------------------------------------------------------
// Tool Display Formatter
// -----------------------------------------------------------------------------

const formatToolDisplay = (name: string): string =>
  "\n" + cyan("▶ " + formatToolName(name)) + "\n"

const formatToolInput = (name: string, input: unknown): string => {
  const display = formatToolDisplay(name)

  // Bash: show command
  if (name === "Bash") {
    return pipe(
      formatBashInput(input),
      Option.map((cmd) => display + cmd + "\n"),
      Option.getOrElse(() => display),
    )
  }

  // AskUserQuestion: show question details
  if (name === "AskUserQuestion") {
    return display + formatUserQuestion(input)
  }

  // Read/Write/Edit: show file path
  if (name === "Read" || name === "Write" || name === "Edit") {
    return pipe(
      formatFileInput(input),
      Option.map((path) => display + path + "\n"),
      Option.getOrElse(() => display),
    )
  }

  // Grep/Glob: show pattern
  if (name === "Grep" || name === "Glob") {
    return pipe(
      formatPatternInput(input),
      Option.map((pattern) => display + pattern + "\n"),
      Option.getOrElse(() => display),
    )
  }

  // MCP tools: show relevant input fields
  if (name.startsWith("mcp__")) {
    return pipe(
      formatMcpInput(input),
      Option.map((inputStr) => display + inputStr + "\n"),
      Option.getOrElse(() => display),
    )
  }

  // Fallback: show compact JSON for any tool with input
  return pipe(
    formatGenericInput(input),
    Option.map((inputStr) => display + inputStr + "\n"),
    Option.getOrElse(() => display),
  )
}

// -----------------------------------------------------------------------------
// Message Formatters
// -----------------------------------------------------------------------------

const formatAssistantMessage = (msg: StreamJsonMessage): string => {
  const content = msg.message?.content
  if (!content) return ""

  return content
    .map((block) => {
      if (block.type === "text" && block.text) {
        return block.text
      }
      if (block.type === "tool_use" && block.name) {
        return formatToolInput(block.name, block.input)
      }
      return ""
    })
    .join("")
}

const formatLongOutput = (text: string): string => {
  const lines = text.trim().split("\n")
  if (lines.length > 8) {
    const preview = [
      ...lines.slice(0, 4),
      dim(`... (${lines.length - 7} more lines)`),
      ...lines.slice(-3),
    ].join("\n")
    return dim(preview) + "\n"
  }
  if (text.length > 500) {
    return dim(truncate(text, 500)) + "\n"
  }
  return dim(text) + "\n"
}

const formatToolResult = (msg: StreamJsonMessage): string => {
  let output = ""

  // Check for tool_use_result (Bash-style tools)
  const result = msg.tool_use_result
  if (result) {
    if (result.stderr && result.stderr.trim()) {
      output += yellow("stderr: ") + truncate(result.stderr.trim(), 500) + "\n"
    }
    if (result.interrupted) {
      output += yellow("[interrupted]") + "\n"
    }
    if (result.stdout && result.stdout.trim()) {
      output += formatLongOutput(result.stdout.trim())
    }
  }

  // Check for MCP tool results in message.content
  const content = msg.message?.content
  if (content) {
    for (const block of content) {
      if (block.type === "tool_result") {
        if (block.is_error) {
          output += yellow("✗ Tool error") + "\n"
        }
        if (block.content) {
          output += formatLongOutput(block.content)
        }
      }
    }
  }

  return output
}

const formatResult = (msg: StreamJsonMessage): string => {
  if (msg.subtype === "success") {
    const duration = msg.duration_ms
      ? (msg.duration_ms / 1000).toFixed(1) + "s"
      : ""
    const cost = msg.total_cost_usd ? "$" + msg.total_cost_usd.toFixed(4) : ""
    const info = [duration, cost].filter(Boolean).join(" | ")
    return "\n" + green("✓ Done") + " " + dim(info) + "\n"
  }
  if (msg.subtype === "error") {
    return "\n" + yellow("✗ Error") + "\n"
  }
  return ""
}
