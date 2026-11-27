import type { Context } from '@deepseek-ai/cordis'
import { appPublishTool, type AppPublisherConfig, type RawToolDefinition } from './tools.js'

/** The id this plugin is known by; it must equal its package and patch row. */
export const name = 'iam-app-publisher'

/** The hard gate: without a tools registry there is nothing to register into. */
export const inject = ['tools']

/**
 * The `ctx.workingDirectory` service, as much of it as this plugin uses.
 *
 * Structural, because a host half cannot import any `@deepseek-ai/*` value: the
 * type is erased by the transpile but the import would still fail to resolve in
 * a profile whose node_modules holds only the linked plugins.
 */
interface WorkingDirectoryService {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * No `Config` schema: Cordis passes the row's `config:` through unvalidated when
 * none is declared, and this half cannot import `@deepseek-ai/schemastery`.
 * Fields are read with fallbacks in `tools.ts` and `publish.ts`.
 */
export function apply(ctx: Context, config: AppPublisherConfig = {}): void {
  // A SEAM AND NOT A GATE: naming workingDirectory in the static inject would
  // stop the plugin loading in compositions that mount no session directories,
  // including the headless/acp profiles where publishing is equally useful.
  let directories: WorkingDirectoryService | undefined
  ctx.inject?.(['workingDirectory'], (scope) => {
    directories = (scope as { workingDirectory?: WorkingDirectoryService }).workingDirectory
    return () => {
      directories = undefined
    }
  })

  const currentWorkspace = async (exec: { agent?: unknown; signal: AbortSignal }) => {
    if (directories === undefined || exec.agent === undefined) return undefined
    return directories.ensure(exec.agent, exec.signal)
  }

  const definitions: RawToolDefinition[] = [appPublishTool(config, currentWorkspace)]
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }
}
