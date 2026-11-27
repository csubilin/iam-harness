/**
 * Publish a standalone desktop app from the native view executable plus a set of
 * frozen workflows.
 *
 * The shape is deliberately the one CapabilityForge documents: the workflows are
 * data.  This script copies them, their manifests and the Python runtime they
 * need into one folder, and writes `iam-app.json` -- the ribbon the native host
 * reads.  Nothing is rebuilt per capability, so publishing the second app is the
 * same command with a different selection.
 *
 * What it does NOT do: sign, install, upgrade or uninstall.  The output is a
 * portable folder (optionally zipped); an installer is a packaging decision for
 * a later step.
 *
 * Nothing in this path calls a model.  The publisher copies files, and the
 * published app runs a workflow program through `python/bridge.py`; no model
 * endpoint, agent session or Harness installation is involved at run time.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

/** One frozen workflow, read from its manifest. */
export interface WorkflowSource {
  readonly name: string
  readonly title: string
  readonly version: string | null
  /** The directory the manifest and entry live in. */
  readonly directory: string
  readonly entry: string
}

/** One ribbon group as `iam-app.json` spells it. */
export interface WorkflowGroupConfig {
  readonly label: string
  readonly items: readonly { readonly workflow: string; readonly label: string }[]
}

/**
 * A ribbon caption that may be one string or one per interface language.  The
 * native host picks by its own language setting; a plain string is used for
 * both, which is what a workflow name wants.
 */
export type LocalizedLabel = string | { readonly en: string; readonly zh: string }

/** `iam-app.json`, the file the native host reads beside the executable. */
export interface AppConfig {
  readonly schemaVersion: number
  readonly title: string
  readonly workflows: string
  readonly workspace: string
  readonly python: string
  readonly bridge: string
  readonly pythonPath: readonly string[]
  readonly timeoutSeconds: number
  readonly tabs: readonly { readonly label: LocalizedLabel; readonly groups: readonly WorkflowGroupConfig[] }[]
}

export interface PublishOptions {
  readonly base: 'drawing' | 'mining'
  readonly nativeDirectory: string
  readonly workflowsRoot: string
  readonly outputDirectory: string
  /** A portable Python install directory; copied whole into `python-runtime/`. */
  readonly pythonDirectory: string
  readonly bridgePath: string
  /** Directory holding `iam_algorithms/`. */
  readonly algorithmsRoot: string
  /** Directory holding `iam/`. */
  readonly iamRoot: string
  readonly fontsDirectory?: string
  readonly resourceDirectory?: string
  readonly workflowNames?: readonly string[]
  readonly title?: string
  readonly tabLabel?: string
  readonly groupLabel?: string
  readonly zip?: boolean
  readonly force?: boolean
}

export interface PublishResult {
  readonly outputDirectory: string
  readonly configPath: string
  readonly workflows: readonly WorkflowSource[]
  readonly zipPath?: string
}

/** The native executable a base names, on this host. */
export function baseExecutableName(base: 'drawing' | 'mining'): string {
  // The IAX rename: the base apps are IamDrawing / IamMining.
  const stem = base === 'drawing' ? 'IamDrawing' : 'IamMining'
  return process.platform === 'win32' ? `${stem}.exe` : stem
}

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) throw new Error(`${what} is missing: ${path}`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The descriptor version the native host understands. */
export const APP_SCHEMA_VERSION = 1

/** The input kinds the native dialog draws. Mirrors the forge's kind list. */
const SUPPORTED_INPUT_KINDS = new Set([
  'path', 'resource-id', 'enum', 'number', 'list', 'material-label', 'boolean',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('todo:')
}

function requireText(problems: string[], where: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) problems.push(`${where} is empty`)
  else if (isPlaceholder(value)) problems.push(`${where} is still a TODO placeholder`)
}

function validateInputs(
  problems: string[],
  where: string,
  value: unknown,
  required: boolean,
  names: Set<string>,
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    problems.push(`${where} must be an array`)
    return
  }
  value.forEach((entry: unknown, index: number) => {
    const at = `${where}[${index}]`
    if (!isObject(entry)) {
      problems.push(`${at} must be an object`)
      return
    }
    const name = entry.name
    if (typeof name !== 'string' || name.trim().length === 0) problems.push(`${at}.name is empty`)
    else if (names.has(name)) problems.push(`${at}.name "${name}" is repeated`)
    else names.add(name)
    const kind = entry.kind
    if (typeof kind !== 'string' || !SUPPORTED_INPUT_KINDS.has(kind)) {
      problems.push(`${at}.kind "${String(kind)}" is not one the dialog draws`)
    }
    requireText(problems, `${at}.means`, entry.means)
    if (required) requireText(problems, `${at}.refused_when`, entry.refused_when)
    if (entry.why_not_inferred !== undefined)
      requireText(problems, `${at}.why_not_inferred`, entry.why_not_inferred)
    const choices = entry.choices
    if (kind === 'enum' && (!Array.isArray(choices) || choices.length === 0))
      problems.push(`${at}.choices is empty for an enum`)
    if (choices !== undefined) {
      if (!Array.isArray(choices) || choices.length === 0)
        problems.push(`${at}.choices must be a non-empty array`)
      else if (!(choices as unknown[]).every(choice => typeof choice === 'string' && choice.length > 0))
        problems.push(`${at}.choices must be non-empty strings`)
    }
  })
}

/**
 * What the dialog needs in order not to be a dead form.
 *
 * The forge's full validator is the real gate at freeze time; this is the
 * publisher's narrower one: title and answers, a label for every input, the
 * refusal a required input can raise, choices for an enum, and only kinds the
 * app draws.  It refuses rather than publishes a dialog with blank help or a
 * combo nobody can answer.  Empty `steps`/`resume`-style optionals are fine.
 */
export function validateManifest(name: string, manifest: Record<string, unknown>): string[] {
  const problems: string[] = []
  requireText(problems, 'title', manifest.title)
  requireText(problems, 'answers', manifest.answers)
  if (manifest.inputs !== undefined) {
    if (!isObject(manifest.inputs)) problems.push('inputs must be an object')
    else {
      const names = new Set<string>()
      validateInputs(problems, 'inputs.required', manifest.inputs.required, true, names)
      validateInputs(problems, 'inputs.optional', manifest.inputs.optional, false, names)
    }
  }
  return problems.map(problem => `workflow ${name}: ${problem}`)
}

/**
 * Read the selected workflows from a workspace's `.iax/workflows`.
 *
 * Order is the caller's when names are given: a ribbon whose buttons move
 * between publishes is a ribbon nobody learns.  Without names, discovery is
 * sorted by name.  A draft is refused rather than shipped: the platform already
 * refuses to run one.
 */
export function readWorkflowSources(workflowsRoot: string, names?: readonly string[]): WorkflowSource[] {
  if (!existsSync(workflowsRoot)) throw new Error(`the workflow root is missing: ${workflowsRoot}`)
  const discovered = names === undefined || names.length === 0
    ? readdirSync(workflowsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
    : [...names]
  if (discovered.length === 0) throw new Error(`no workflows found under ${workflowsRoot}`)

  const sources: WorkflowSource[] = []
  for (const name of discovered) {
    const directory = join(workflowsRoot, name)
    const manifestPath = join(directory, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`workflow ${name}: no manifest.json in ${directory}`)
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    }
    catch (error) {
      throw new Error(`workflow ${name}: manifest.json is not JSON (${String(error)})`)
    }
    if (manifest.status === 'draft') throw new Error(`workflow ${name} is a draft; freeze it before publishing`)
    const problems = validateManifest(name, manifest)
    if (problems.length > 0) throw new Error(problems.join('\n'))
    const entry = typeof manifest.entry === 'string' ? manifest.entry : 'workflow.py'
    requireFile(join(directory, entry), `workflow ${name}: entry`)
    sources.push({
      name,
      title: typeof manifest.title === 'string' && manifest.title.length > 0 ? manifest.title : name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      directory,
      entry,
    })
  }
  return sources
}

/**
 * Group workflows for the ribbon.
 *
 * A capability name is `<domain>-<stage>` (CapabilityForge's D11), so the text
 * before the last hyphen is the domain a ribbon group is named after.  An
 * explicit group label overrides that and puts everything in one group.
 */
export function groupWorkflows(sources: readonly WorkflowSource[], groupLabel?: string): WorkflowGroupConfig[] {
  const items = sources.map(source => ({ workflow: source.name, label: source.name }))
  if (groupLabel !== undefined && groupLabel.length > 0) return [{ label: groupLabel, items }]
  const groups = new Map<string, { workflow: string; label: string }[]>()
  for (const item of items) {
    const dash = item.workflow.lastIndexOf('-')
    const label = dash > 0 ? item.workflow.slice(0, dash) : '流程'
    const group = groups.get(label)
    if (group === undefined) groups.set(label, [item])
    else group.push(item)
  }
  return [...groups].map(([label, groupItems]) => ({ label, items: groupItems }))
}

/** The `iam-app.json` record, separated from the copying so it can be tested. */
export function buildAppConfig(
  sources: readonly WorkflowSource[],
  options: { readonly base: 'drawing' | 'mining'; readonly python: string; readonly title?: string; readonly tabLabel?: string; readonly groupLabel?: string },
): AppConfig {
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    title: options.title ?? `${options.base === 'mining' ? 'Mining' : 'Drawing'} 工作台`,
    workflows: 'workflows',
    workspace: 'workspace',
    python: options.python,
    bridge: 'python/bridge.py',
    pythonPath: ['python/vendor'],
    timeoutSeconds: 1800,
    tabs: [{
      label: options.tabLabel ?? { en: 'Capabilities', zh: '能力' },
      groups: groupWorkflows(sources, options.groupLabel),
    }],
  }
}

function copyDirectory(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true })
}

function zipDirectory(directory: string): string {
  const zipPath = `${directory}.zip`
  rmSync(zipPath, { force: true })
  const parent = dirname(directory)
  const name = basename(directory)
  const result = process.platform === 'win32'
    ? spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
      ['-a', '-cf', zipPath, '-C', parent, name], { stdio: 'inherit' })
    : spawnSync('zip', ['-r', zipPath, name], { cwd: parent, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`zipping ${directory} failed (${String(result.status)})`)
  return zipPath
}

/**
 * Build the portable folder.
 *
 * The layout is the bridge's own contract rather than a new one: `python/`
 * holds `bridge.py` and `python/vendor`, so `bridge.py`'s `PACKAGE_ROOT` is the
 * app root and its packaged workflow root is `<app>/workflows`.  The host sets
 * `IAM_PYTHON_PACKAGE_DIR` and `IAX_PLATFORM_ROOT` from the same folder.
 */
export function publish(options: PublishOptions): PublishResult {
  const executableName = baseExecutableName(options.base)
  const executablePath = join(options.nativeDirectory, executableName)
  requireFile(executablePath, 'the base executable')
  requireFile(options.bridgePath, 'bridge.py')
  requireFile(join(options.algorithmsRoot, 'iam_algorithms', '__init__.py'), 'the iam_algorithms package')
  requireFile(join(options.iamRoot, 'iam', '__init__.py'), 'the iam package')

  const pythonExecutables = [
    join(options.pythonDirectory, 'python.exe'),
    join(options.pythonDirectory, 'bin', 'python3'),
  ]
  if (!pythonExecutables.some(path => existsSync(path))) {
    throw new Error(`the Python runtime has no python.exe or bin/python3: ${options.pythonDirectory}`)
  }

  const sources = readWorkflowSources(options.workflowsRoot, options.workflowNames)
  const output = resolve(options.outputDirectory)
  if (existsSync(output)) {
    if (options.force !== true && readdirSync(output).length > 0) {
      throw new Error(`the output directory is not empty: ${output} (pass --force to replace it)`)
    }
    rmSync(output, { recursive: true, force: true })
  }
  mkdirSync(output, { recursive: true })

  cpSync(executablePath, join(output, executableName))
  for (const entry of readdirSync(options.nativeDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
      cpSync(join(options.nativeDirectory, entry.name), join(output, entry.name))
    }
  }
  if (options.fontsDirectory !== undefined && existsSync(options.fontsDirectory)) {
    copyDirectory(options.fontsDirectory, join(output, 'Fonts'))
  }
  if (options.resourceDirectory !== undefined && existsSync(options.resourceDirectory)) {
    copyDirectory(options.resourceDirectory, join(output, 'resource'))
  }

  mkdirSync(join(output, 'workflows'), { recursive: true })
  for (const source of sources) {
    copyDirectory(source.directory, join(output, 'workflows', source.name))
  }

  mkdirSync(join(output, 'python', 'vendor'), { recursive: true })
  cpSync(options.bridgePath, join(output, 'python', 'bridge.py'))
  copyDirectory(join(options.algorithmsRoot, 'iam_algorithms'),
    join(output, 'python', 'vendor', 'iam_algorithms'))
  copyDirectory(join(options.iamRoot, 'iam'), join(output, 'python', 'vendor', 'iam'))
  copyDirectory(options.pythonDirectory, join(output, 'python-runtime'))
  mkdirSync(join(output, 'workspace'), { recursive: true })

  const python = existsSync(join(output, 'python-runtime', 'python.exe'))
    ? 'python-runtime/python.exe' : 'python-runtime/bin/python3'
  const config = buildAppConfig(sources, {
    base: options.base,
    python,
    title: options.title,
    tabLabel: options.tabLabel,
    groupLabel: options.groupLabel,
  })
  const configPath = join(output, 'iam-app.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const receipt = {
    base: options.base,
    executable: executableName,
    createdAt: new Date().toISOString(),
    python,
    workflows: sources.map(source => ({
      name: source.name,
      title: source.title,
      version: source.version,
      manifestSha256: sha256(join(source.directory, 'manifest.json')),
      entrySha256: sha256(join(source.directory, source.entry)),
    })),
  }
  writeFileSync(join(output, 'publish.json'), `${JSON.stringify(receipt, null, 2)}\n`)

  const zipPath = options.zip === true ? zipDirectory(output) : undefined
  return { outputDirectory: output, configPath, workflows: sources, zipPath }
}

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

  pnpm run package:app -- --base mining --workspace <dir> --out <dir> --python <dir> [options]

Required
  --base <drawing|mining>   The native executable to publish.
  --workspace <dir>         The workspace holding .iax/workflows/.
  --out <dir>               The output folder (created, or replaced with --force).
  --python <dir>            A portable Python install to bundle (python.exe or bin/python3).

Optional
  --workflows <a,b>         Names to publish, in ribbon order. All non-draft workflows otherwise.
  --native-dir <dir>        Native build output. Default IAX_NATIVE_DIR or ../IAX/build/exe/win-native.
  --bridge <file>           Default packages/iam/algorithm-bridge/python/bridge.py.
  --algorithms <dir>        Directory holding iam_algorithms/. Default IAM_PYTHON_PACKAGE_DIR or the IAX build.
  --iam <dir>               Directory holding iam/. Default <IAX>/Mining/Host/python.
  --fonts <dir>             Default IAX_FONTS or <IAX>/Fonts.
  --resource <dir>          Default IAX_RESOURCE or <IAX>/resource.
  --title <text>            Window/app title in iam-app.json.
  --tab <label>             Ribbon tab label. Default 能力.
  --group <label>           One ribbon group with this label instead of domain prefixes.
  --zip                     Also write <out>.zip.
  --force                   Replace a non-empty output folder.

The Python directory must be portable and must already contain the packages the
workflows import (numpy, the IAM bindings' dependencies). Only the platform's own
iam/ and iam_algorithms/ are copied by this script.

The published app runs workflows through python/bridge.py directly; it needs no
model endpoint, agent session or Harness installation. The Python runtime must
match the ABI of the bundled iam_algorithms build. Ribbon items default to the
drawn flow glyph; an "icon" key in iam-app.json draws one of the app's own icons
instead.`

function main(argv: readonly string[]): void {
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
  const python = values.get('python') ?? process.env.IAX_APP_PYTHON_DIR
  if (python === undefined) {
    throw new Error('--python is required: publishing bundles a portable Python runtime with the app')
  }

  const iax = process.env.IAX_ROOT ?? join(ROOT, '..', 'IAX')
  const platforms: Record<string, string> = {
    win32: 'win-native', linux: 'linux-native', darwin: 'macos-native',
  }
  const platform = platforms[process.platform]
  if (platform === undefined) throw new Error(`unsupported host platform: ${process.platform}`)
  const workflows = values.get('workflows')
  const result = publish({
    base,
    nativeDirectory: values.get('native-dir') ?? process.env.IAX_NATIVE_DIR
      ?? join(iax, 'build', 'exe', platform),
    workflowsRoot: join(resolve(workspace), '.iax', 'workflows'),
    outputDirectory: output,
    pythonDirectory: resolve(python),
    bridgePath: values.get('bridge')
      ?? join(ROOT, 'packages', 'iam', 'algorithm-bridge', 'python', 'bridge.py'),
    algorithmsRoot: values.get('algorithms') ?? process.env.IAM_PYTHON_PACKAGE_DIR
      ?? join(iax, 'build', 'CMakePlatforms', platform, 'IAM', 'Host', 'Python'),
    iamRoot: values.get('iam') ?? join(iax, 'Mining', 'Host', 'python'),
    fontsDirectory: values.get('fonts') ?? process.env.IAX_FONTS ?? join(iax, 'Fonts'),
    resourceDirectory: values.get('resource') ?? process.env.IAX_RESOURCE ?? join(iax, 'resource'),
    workflowNames: workflows === undefined ? undefined : workflows.split(',').map(name => name.trim()).filter(Boolean),
    title: values.get('title'),
    tabLabel: values.get('tab'),
    groupLabel: values.get('group'),
    zip: flags.has('zip'),
    force: flags.has('force'),
  })
  console.log(`publish-app: ${result.outputDirectory}`)
  console.log(`  executable: ${baseExecutableName(base)}`)
  console.log(`  workflows: ${result.workflows.map(workflow => workflow.name).join(', ')}`)
  console.log(`  config: ${result.configPath}`)
  if (result.zipPath !== undefined) console.log(`  zip: ${result.zipPath}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  }
  catch (error) {
    console.error(`publish-app: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
