import type { Context } from '@deepseek-ai/cordis'
import { stopEditors } from './native.js'
import {
  mineApplyTool, mineDocumentTool, mineEditTool, mineVerbTool, miningShowTool,
  type RepositoryPluginConfig, type RawToolDefinition,
} from './tools.js'

/**
 * The id this plugin is known by.
 *
 * It must equal this package's patch-row `id` and be distinct from every other
 * bundle's: a duplicate makes the composed tree describe one plugin twice.
 */
export const name = 'iam-mining-repository'

/**
 * The hard gate: without a tools registry there is nothing to register into.
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
 * the fields are read with fallbacks and a wrong type is a TypeScript error at
 * the call site instead of a load-time rejection.
 */
export function apply(ctx: Context, config: RepositoryPluginConfig = {}): void {
  // A SEAM AND NOT A GATE, for AlgorithmBridge's reason: a static `inject` is a
  // load gate, and naming `workingDirectory` there would stop the plugin loading
  // in a composition that mounts no session directories.  With no service the
  // probe answers undefined and the configured workspace is used instead.
  let directories: WorkingDirectoryService | undefined
  ctx.inject?.(['workingDirectory'], (scope) => {
    directories = (scope as { workingDirectory?: WorkingDirectoryService }).workingDirectory
    return () => {
      directories = undefined
    }
  })

  // The carrier, asked the same way Views asks it: the Web profile has no native
  // editor to start on the user's machine, and the desktop shell does.  A
  // `.iamh` can only be shown on one of them, so the tool has to know which it is
  // talking to -- and asking is better than guessing from the platform, because
  // the platform is not what decides it.
  let profileName: string | undefined
  ctx.inject?.(['profileContext'], (scope) => {
    profileName = (scope as { profileContext?: { name?: string } }).profileContext?.name
    return () => {
      profileName = undefined
    }
  })

  /**
   * Which directory the calling Session is working in.
   *
   * NOT caught and defaulted: `ensure` fails when the session's directory is gone
   * and its original project cannot be restored, and answering "no workspace"
   * there would resolve the caller's relative paths against an accident.  A call
   * with no agent, a scripted one, gets no workspace from here.
   */
  const currentWorkspace = async (exec: { agent?: unknown; signal: AbortSignal }) => {
    if (directories === undefined || exec.agent === undefined) return undefined
    return directories.ensure(exec.agent, exec.signal)
  }

  const definitions: RawToolDefinition[] = [
    miningShowTool(config, currentWorkspace, () => profileName),
    // The write door: two ways to produce a document, one way to read it, one
    // way to publish it.  An edit changes nothing until it is applied, and the
    // read is what makes the gap in the middle a place a person can stand rather
    // than a promise.
    mineEditTool(config, currentWorkspace),
    mineVerbTool(config, currentWorkspace),
    mineDocumentTool(config, currentWorkspace),
    mineApplyTool(config, currentWorkspace),
  ]
  for (const definition of definitions) ctx.tools.register(definition)

  // The editors this plugin started are its own to end: nothing else knows their
  // pids, and a plugin that unloads leaving GUI processes behind is a plugin that
  // leaks one window per run.
  ctx.effect(() => () => {
    stopEditors()
  })
}
