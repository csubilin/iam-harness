import type { Context } from '@deepseek-ai/cordis'
import {
  capabilityAuditTool,
  capabilityCandidatesTool,
  capabilityFreezeTool,
  capabilityScaffoldTool,
  capabilityValidateTool,
  type CapabilityPluginConfig,
  type RawToolDefinition,
} from './tools.js'

/** The id this plugin is known by; it must equal its package and patch row. */
export const name = 'iam-capability-forge'

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
 * Fields are read with fallbacks in `tools.ts`.
 */
export function apply(ctx: Context, config: CapabilityPluginConfig = {}): void {
  // A SEAM AND NOT A GATE.  `workingDirectory` is optional: naming it in the
  // static `inject` would stop the whole plugin loading in compositions that
  // mount no session directories, which is exactly the headless/acp profiles
  // these tools are most useful in. With no service the configured workspace is
  // used, and with neither the call must name one.
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

  const definitions: RawToolDefinition[] = [
    capabilityCandidatesTool(config, currentWorkspace),
    capabilityScaffoldTool(config, currentWorkspace),
    capabilityValidateTool(config, currentWorkspace),
    capabilityFreezeTool(config, currentWorkspace),
    capabilityAuditTool(config, currentWorkspace),
  ]
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }
}
