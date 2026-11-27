/**
 * `dsh app publish`: publish a portable desktop app from a workspace's frozen
 * capabilities.
 *
 * The publisher is the Harness capability `iam_app_publish`, shipped by the IAM
 * profile bundle. This command resolves it through that bundle instead of
 * declaring a dependency: the IAM packages are packed into the Desktop install
 * and never published, so a static import would make the public `dsh` package
 * uninstallable outside that installer. A dsh without the bundle says so.
 * @module @deepseek-ai/dsh/app
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The profile bundle the IAM packages arrive with. */
const IAM_BUNDLE = '@deepseek-ai/iam-mining-workspace'
/** The publisher package and the command-line entry this launcher calls. */
const PUBLISHER_PACKAGE = '@deepseek-ai/iam-app-publisher'
const PUBLISHER_ENTRY = `${PUBLISHER_PACKAGE}/cli`

/** The part of the publisher package this launcher calls. */
interface PublisherCli {
  runPublishCli: (args: readonly string[], environment?: NodeJS.ProcessEnv) => number
}

/**
 * Hand the publisher's own arguments to the installed publisher.
 * @param args - arguments after `dsh app publish`, forwarded verbatim.
 * @returns the publisher's process exit code; 1 when this installation carries no publisher.
 */
export async function runAppPublish(args: readonly string[]): Promise<number> {
  let publisher: PublisherCli
  try {
    const bundle = createRequire(import.meta.url).resolve(`${IAM_BUNDLE}/package.json`)
    const entry = createRequire(bundle).resolve(PUBLISHER_ENTRY)
    publisher = await import(pathToFileURL(entry).href) as PublisherCli
  }
  catch (error) {
    process.stderr.write(
      `dsh: ${PUBLISHER_PACKAGE} is not available to this installation (${String(error)}); `
      + `install the ${IAM_BUNDLE} bundle beside dsh\n`,
    )
    return 1
  }
  return publisher.runPublishCli(args)
}
