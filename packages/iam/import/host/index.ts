import type { Context } from '@deepseek-ai/cordis'
import {
  createDrawingDescriptionTool,
  createDrawingImportTool,
  createMiningImportTool,
  type ImportPluginConfig,
  type JobsRegistry,
  type RawToolDefinition,
} from './import-and-describe-tools.js'

/**
 * The id this plugin is known by.
 *
 * It must be distinct from every other bundle's: the two view plugins shipped
 * with the same name as each other for a while (both said `iam-drawingview`,
 * while package.json said otherwise), which made the composed tree describe one
 * plugin twice. This one matches its package and its patch row, `iam-import`.
 */
export const name = 'iam-import'

/**
 * The hard gate: without a tools registry there is nothing to register into.
 *
 * `jobs` is deliberately absent. It gates `run_in_background` and nothing else,
 * so a profile without it should lose that parameter rather than the plugin --
 * and a static `inject` is a load gate that would do the latter.
 */
export const inject = ['tools']

/**
 * No `Config` schema, and that is a limitation being lived with rather than a
 * choice: a Schemastery schema would mean importing `@deepseek-ai/schemastery`,
 * and this half cannot import any `@deepseek-ai/*` value at runtime -- the
 * profile's `node_modules` holds the linked plugins and nothing else. Cordis
 * passes the row's `config:` through unvalidated when no schema is declared
 * (`if (!runtime.Config) return config`), so the fields below are read with
 * fallbacks and a wrong type is a TypeScript error at the call site instead of
 * a load-time rejection.
 */
export function apply(ctx: Context, config: ImportPluginConfig = {}): void {
  // Held in a closure the tools read per call, not passed by value: `jobs` may
  // be mounted after this runs and torn down before it ends, and the tools are
  // registered once. `ctx.inject` is the optional seam -- it activates when the
  // service appears and disposes when it leaves, so what the tools see follows
  // the container rather than the moment this plugin happened to load.
  // `?.` on purpose, and not defensiveness about cordis: `inject` is a service
  // container feature, and this plugin is worth being able to drive from a
  // twenty-line fake context -- which is how every tool in it is tested outside
  // the harness. The two view plugins' host halves make the same allowance.
  let jobs: JobsRegistry | undefined
  ctx.inject?.(['jobs'], (scope) => {
    jobs = (scope as { jobs?: JobsRegistry }).jobs
    return () => {
      jobs = undefined
    }
  })
  const jobsOf = (): JobsRegistry | undefined => jobs

  const definitions: RawToolDefinition[] = [
    createMiningImportTool(config, jobsOf),
    createDrawingImportTool(config, jobsOf),
    // No jobs: describing produces nothing to wait for -- it is a read, and a
    // read that takes long enough to background is a read of a file too large
    // to return in one value, which the payload bound already refuses.
    createDrawingDescriptionTool(config),
  ]
  for (const definition of definitions) {
    // No `ctx.effect` wrapper: registration is already effect-based, so
    // unloading this plugin unregisters its tools.
    ctx.tools.register(definition)
  }
}
