/** Agent-preset surface plugin, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half ships the
 * General-settings row through exports["./client"], discovered from the
 * package.json dsh.client declaration.
 */
import z from '@deepseek-ai/schemastery'

/** Deployment switches synced to the browser half. */
export interface Config {
  /** Show the new-session mode chip; a deployment that fixes the preset turns it off. */
  readonly hero: boolean
}

export const Config = z.object({
  hero: z.boolean().default(true).volatile(),
})

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(_config: Config): void {}
