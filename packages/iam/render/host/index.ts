import type { Context } from '@deepseek-ai/cordis'
import { createRenderDocumentTool, type RawToolDefinition, type RenderPluginConfig } from './render-document-tool.js'

/**
 * The id this plugin is known by. It must be distinct from every other bundle's,
 * and it matches its package and its patch row.
 */
export const name = 'iam-render'

/** The hard gate: without a tools registry there is nothing to register into. */
export const inject = ['tools']

/**
 * No `Config` schema: this half cannot import `@deepseek-ai/schemastery`, and
 * Cordis passes the row's `config:` through unvalidated when no schema is
 * declared. The fields are read with fallbacks in `render-document-tool.ts`.
 */
export function apply(ctx: Context, config: RenderPluginConfig = {}): void {
  const definition: RawToolDefinition = createRenderDocumentTool(config)
  // Registration is already effect-based, so unloading the plugin unregisters it.
  ctx.tools.register(definition)
}
