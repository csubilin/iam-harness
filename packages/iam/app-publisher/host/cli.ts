/**
 * Command-line entry for the app publisher.
 *
 * `dsh app publish` calls {@link runPublishCli}; the publishing itself is
 * `publish()` in publish.ts, which the Harness tool `iam_app_publish` calls
 * directly. The command line lives here so both carriers share one parser.
 */
import { resolve } from 'node:path'
import {
  baseExecutableName,
  publish,
  resolvePublishSources,
  type PublishConfig,
} from './publish.js'

interface ParsedArguments {
  readonly values: Map<string, string>
  readonly flags: Set<string>
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--') continue
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const equals = argument.indexOf('=')
    if (equals >= 0) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1))
      continue
    }
    const key = argument.slice(2)
    if (key === 'zip' || key === 'force' || key === 'help') {
      flags.add(key)
      continue
    }
    const value = argv[++index]
    if (value === undefined) throw new Error(`--${key} needs a value`)
    values.set(key, value)
  }
  return { values, flags }
}

const HELP = `Publish a standalone native app: the base view executable plus selected frozen workflows.

  dsh app publish --base mining --workspace <dir> --out <dir> [options]

The same publisher is the Harness capability \`iam_app_publish\`.

Required
  --base <drawing|mining>   The native executable to publish.
  --workspace <dir>         The workspace holding .iax/workflows/.
  --out <dir>               The output folder (created, or replaced with --force).

Optional
  --python <dir>            A portable Python install to bundle (python.exe, bin/python.exe or bin/python3).
                            Default IAX_APP_PYTHON_DIR or IAM_BRIDGE_PYTHON.
  --workflows <a,b>         Names to publish, in ribbon order. All active workflows otherwise.
  --native-dir <dir>        Native build output. Default IAM_NATIVE_DIR or ../IAX/build/exe/<platform>.
  --bridge <file>           Default IAM_BRIDGE_SCRIPT or packages/iam/algorithm-bridge/python/bridge.py.
  --algorithms <dir>        Directory holding iam_algorithms/. Default IAM_PYTHON_PACKAGE_DIR,
                            the bridge's sibling vendor/, or the IAX build.
  --iam <dir>               Directory holding iam/. Default IAM_MINING_PYTHON_DIR, the bridge's
                            sibling vendor/, or <IAX>/Mining/Host/python.
  --fonts <dir>             Default IAM_FONTS_DIR / ACAD / <IAX>/Fonts.
  --resource <dir>          Default IAX_RESOURCE or the native directory's resource/.
  --title <text>            Window/app title in iam-app.json.
  --tab <label>             Ribbon tab label. Default 能力.
  --group <label>           One ribbon group with this label instead of domain prefixes.
  --zip                     Also write <out>.zip.
  --force                   Replace a non-empty output folder.

The Python directory must be portable and must already contain the packages the
workflows import (numpy, the IAM bindings' dependencies). Only the platform's own
iam/ and iam_algorithms/ are copied by this command.

The published app runs workflows through python/bridge.py directly; it needs no
model endpoint, agent session or Harness installation. The Python runtime must
match the ABI of the bundled iam_algorithms build. Ribbon items default to the
drawn flow glyph; an "icon" key in iam-app.json draws one of the app's own icons
instead.`

function main(argv: readonly string[], environment: NodeJS.ProcessEnv): void {
  const { values, flags } = parseArguments(argv)
  if (flags.has('help')) {
    console.log(HELP)
    return
  }
  const base = values.get('base')
  if (base !== 'drawing' && base !== 'mining') throw new Error('--base must be drawing or mining')
  const workspace = values.get('workspace')
  if (workspace === undefined) throw new Error('--workspace is required')
  const output = values.get('out')
  if (output === undefined) throw new Error('--out is required')

  const nativeDir = values.get('native-dir')
  const bridge = values.get('bridge')
  const algorithms = values.get('algorithms')
  const iam = values.get('iam')
  const fonts = values.get('fonts')
  const resource = values.get('resource')
  const python = values.get('python')
  const configured: PublishConfig = {
    ...(nativeDir === undefined ? {} : { nativeDir }),
    ...(bridge === undefined ? {} : { bridge }),
    ...(algorithms === undefined ? {} : { algorithms }),
    ...(iam === undefined ? {} : { iam }),
    ...(fonts === undefined ? {} : { fonts }),
    ...(resource === undefined ? {} : { resource }),
    ...(python === undefined ? {} : { python: resolve(python) }),
  }
  const sources = resolvePublishSources(environment, configured)
  const workflows = values.get('workflows')
  const title = values.get('title')
  const tabLabel = values.get('tab')
  const groupLabel = values.get('group')
  const result = publish({
    ...sources,
    base,
    workflowsRoot: resolve(workspace, '.iax', 'workflows'),
    outputDirectory: output,
    ...(workflows === undefined ? {} : { workflowNames: workflows.split(',').map(name => name.trim()).filter(Boolean) }),
    ...(title === undefined ? {} : { title }),
    ...(tabLabel === undefined ? {} : { tabLabel }),
    ...(groupLabel === undefined ? {} : { groupLabel }),
    zip: flags.has('zip'),
    force: flags.has('force'),
  })
  console.log(`dsh app publish: ${result.outputDirectory}`)
  console.log(`  executable: ${baseExecutableName(base)}`)
  console.log(`  workflows: ${result.workflows.map(workflow => workflow.name).join(', ')}`)
  console.log(`  config: ${result.configPath}`)
  if (result.zipPath !== undefined) console.log(`  zip: ${result.zipPath}`)
}

/**
 * Run the publisher command line.
 * @param argv - arguments after the command name.
 * @param environment - deployment variables (`IAM_*`) the sources resolve from.
 * @returns 0 for a publish or `--help`; 1 for a refusal or a failed call.
 */
export function runPublishCli(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): number {
  try {
    main(argv, environment)
    return 0
  }
  catch (error) {
    console.error(`dsh app publish: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
