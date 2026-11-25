import type { Context } from '@deepseek-ai/cordis'
import {
  algorithmDescribeTool,
  algorithmRunTool,
  algorithmSearchTool,
  mineDescribeTool,
  programRunTool,
  workflowFreezeTool,
  workflowListTool,
  workflowRunTool,
  type BridgePluginConfig,
  type RawToolDefinition,
} from './tools.js'

/**
 * The id this plugin is known by.
 *
 * It must equal this package's patch-row `id` and be distinct from every other
 * bundle's: a duplicate makes the composed tree describe one plugin twice, which
 * is a defect the two view packages shipped with for a while.
 */
export const name = 'iam-algorithm-bridge'

/**
 * The hard gate: without a tools registry there is nothing to register into.
 *
 * Nothing else is injected.  This plugin needs no browser, no session store and
 * no job registry -- `iam_program_run` is synchronous from the caller's side,
 * bounded by its own deadline, and a generated program that wants to be
 * backgrounded is a program that should have been a workflow.
 */
export const inject = ['tools']

/**
 * The `ctx.workingDirectory` service, as much of it as this plugin uses.
 *
 * Structural, for the reason everything else in this half is: a host half
 * resolves `node:` builtins and its own files and no `@deepseek-ai/*` value, so
 * the type cannot be imported even though the service can.
 */
interface WorkingDirectoryService {
  /** The directory this Session is working in, validated before it is returned. */
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * No `Config` schema, and that is a limitation being lived with rather than a
 * choice: a Schemastery schema would mean importing `@deepseek-ai/schemastery`,
 * and this half cannot import any `@deepseek-ai/*` value at runtime.  Cordis
 * passes the row's `config:` through unvalidated when no schema is declared, so
 * the fields below are read with fallbacks and a wrong type is a TypeScript
 * error at the call site instead of a load-time rejection.
 */
export function apply(ctx: Context, config: BridgePluginConfig = {}): void {
  // A SEAM AND NOT A GATE.  `workingDirectory` is optional here even though this
  // plugin is much better with it: a static `inject` is a load gate, and naming
  // it there would stop the whole plugin loading in a composition that mounts no
  // session directories -- which is exactly the headless and acp profiles these
  // tools are most useful in.  With no service the probe answers undefined and
  // the configured workspace is used instead.
  let directories: WorkingDirectoryService | undefined
  ctx.inject?.(['workingDirectory'], (scope) => {
    directories = (scope as { workingDirectory?: WorkingDirectoryService }).workingDirectory
    return () => {
      directories = undefined
    }
  })

  /**
   * Which directory the calling Session is working in.
   *
   * NOT caught and defaulted: `ensure` fails when the session's directory is
   * gone and its original project cannot be restored, and answering "no
   * workspace" there would write a user's workflows somewhere they did not
   * choose.  A failure is a failure, and the tool call says so.
   *
   * A call with no agent -- a scripted or programmatic invocation rather than a
   * session's -- has no directory to ask about, and gets no workspace from here.
   */
  const currentWorkspace = async (exec: { agent?: unknown; signal: AbortSignal }) => {
    if (directories === undefined || exec.agent === undefined) return undefined
    return directories.ensure(exec.agent, exec.signal)
  }

  const definitions: RawToolDefinition[] = [
    algorithmSearchTool(config, currentWorkspace),
    algorithmDescribeTool(config, currentWorkspace),
    algorithmRunTool(config, currentWorkspace),
    mineDescribeTool(config, currentWorkspace),
    workflowListTool(config, currentWorkspace),
    workflowRunTool(config, currentWorkspace),
    workflowFreezeTool(config, currentWorkspace),
    programRunTool(config, currentWorkspace),
  ]
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }
}
