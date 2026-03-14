import { Duration, Effect, Option, Path, pipe, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Worktree } from "../Worktree.ts"
import type { CliAgentPreset } from "../domain/CliAgentPreset.ts"
import { runClanka } from "../Clanka.ts"
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner"
import { Prompt } from "effect/unstable/ai"

export const agentWorker = Effect.fnUntraced(function* (options: {
  readonly stallTimeout: Duration.Duration
  readonly preset: CliAgentPreset
  readonly system?: string
  readonly prompt: string
  readonly research: Option.Option<string>
  readonly steer?: Stream.Stream<string>
}) {
  const pathService = yield* Path.Path
  const worktree = yield* Worktree

  // use clanka
  if (!options.preset.cliAgent.command) {
    yield* runClanka({
      directory: worktree.directory,
      model: options.preset.extraArgs.join(" "),
      system: options.system,
      prompt: Option.match(options.research, {
        onNone: () => options.prompt,
        onSome: (research) =>
          Prompt.make([
            {
              role: "user",
              content: options.prompt,
            },
            {
              role: "assistant",
              content: `Another software engineer has done some prior research for this task, and found the following information:

${research}`,
            },
          ]),
      }),
      stallTimeout: options.stallTimeout,
      steer: options.steer,
    })
    return ExitCode(0)
  }

  const cliCommand = pipe(
    options.preset.cliAgent.command({
      prompt: options.prompt,
      prdFilePath: pathService.join(".lalph", "prd.yml"),
      extraArgs: options.preset.extraArgs,
    }),
    ChildProcess.setCwd(worktree.directory),
    options.preset.withCommandPrefix,
  )

  return yield* cliCommand.pipe(
    worktree.execWithStallTimeout({
      cliAgent: options.preset.cliAgent,
      stallTimeout: options.stallTimeout,
    }),
  )
})
