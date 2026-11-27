/**
 * Publishing core behind the `iam_app_publish` tool and `dsh app publish`.
 *
 * A published app is a portable folder around one of the platform's base
 * executables: the frozen workflows are data, so publishing the second app is
 * the same file copy with a different selection. Nothing here rebuilds a
 * capability, and nothing calls a model.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A request the publisher refuses; the tool returns it as a value. */
export class PublishRefusalError extends Error {}

/** The deployment does not provide what publishing needs; the call failed. */
export class PublishUnavailableError extends Error {}

const here = dirname(fileURLToPath(import.meta.url))
/** This package's own directory, in a checkout and in an installed profile alike. */
const packageRoot = resolve(here, '..')

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

/** Deployment-varying inputs; the environment fills whatever a row does not. */
export interface PublishConfig {
  readonly nativeDir?: string
  readonly fonts?: string
  readonly resource?: string
  readonly bridge?: string
  readonly algorithms?: string
  readonly iam?: string
  /** A portable Python directory, or an interpreter inside one. */
  readonly python?: string
}

/** The directories one publish copies from. */
export interface PublishSources {
  readonly nativeDirectory: string
  readonly pythonDirectory: string
  readonly bridgePath: string
  readonly algorithmsRoot: string
  readonly iamRoot: string
  readonly fontsDirectory: string
  readonly resourceDirectory: string
}

/** The native executable a base names, on this host. */
export function baseExecutableName(base: 'drawing' | 'mining'): string {
  // The IAX rename: the base apps are IamDrawing / IamMining.
  const stem = base === 'drawing' ? 'IamDrawing' : 'IamMining'
  return process.platform === 'win32' ? `${stem}.exe` : stem
}

/** The interpreter layouts a portable runtime may use, relative to its root. */
const PYTHON_LAYOUTS: readonly (readonly string[])[] = [
  ['python.exe'],
  ['bin', 'python.exe'],
  ['bin', 'python3'],
  ['bin', 'python3.exe'],
]

/** The layout of the interpreter a runtime root carries, or undefined. */
function pythonLayout(root: string): readonly string[] | undefined {
  return PYTHON_LAYOUTS.find(layout => existsSync(join(root, ...layout)))
}

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) throw new PublishUnavailableError(`${what} is missing: ${path}`)
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
  if (!existsSync(workflowsRoot)) {
    throw new PublishRefusalError(`the workflow root is missing: ${workflowsRoot}`)
  }
  const discovered = names === undefined || names.length === 0
    ? readdirSync(workflowsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
    : [...names]
  if (discovered.length === 0) throw new PublishRefusalError(`no workflows found under ${workflowsRoot}`)

  const sources: WorkflowSource[] = []
  for (const name of discovered) {
    const directory = join(workflowsRoot, name)
    const manifestPath = join(directory, 'manifest.json')
    if (!existsSync(manifestPath)) {
      throw new PublishRefusalError(`workflow ${name}: no manifest.json in ${directory}`)
    }
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    }
    catch (error) {
      throw new PublishRefusalError(`workflow ${name}: manifest.json is not JSON (${String(error)})`)
    }
    if (manifest.status === 'draft') {
      throw new PublishRefusalError(`workflow ${name} is a draft; freeze it before publishing`)
    }
    const problems = validateManifest(name, manifest)
    if (problems.length > 0) throw new PublishRefusalError(problems.join('\n'))
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

  const layout = pythonLayout(options.pythonDirectory)
  if (layout === undefined) {
    throw new PublishUnavailableError(
      `the Python runtime has no interpreter: ${options.pythonDirectory} `
      + '(expected python.exe, bin/python.exe, bin/python3 or bin/python3.exe)',
    )
  }

  const sources = readWorkflowSources(options.workflowsRoot, options.workflowNames)
  const output = resolve(options.outputDirectory)
  if (existsSync(output)) {
    if (options.force !== true && readdirSync(output).length > 0) {
      throw new PublishRefusalError(`the output directory is not empty: ${output} (pass force to replace it)`)
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

  const python = ['python-runtime', ...layout].join('/')
  const config = buildAppConfig(sources, {
    base: options.base,
    python,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.tabLabel === undefined ? {} : { tabLabel: options.tabLabel }),
    ...(options.groupLabel === undefined ? {} : { groupLabel: options.groupLabel }),
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
  return { outputDirectory: output, configPath, workflows: sources, ...(zipPath === undefined ? {} : { zipPath }) }
}

/** The platform's native build directory name, the one `build.ps1`/`build.sh` writes. */
function platformDirectory(): string | undefined {
  const names: Record<string, string> = { win32: 'win-native', linux: 'linux-native', darwin: 'macos-native' }
  return names[process.platform]
}

/**
 * A portable Python root, from a directory or an interpreter path.
 *
 * The interpreter may sit at the root or under `bin/`, which is the layout of
 * both the MSYS2 prefix the bindings are built with and the staged runtime the
 * Desktop ships; an interpreter path answers the directory that carries its
 * `lib/`. A bare name such as `python` runs the bridge in-process but is not a
 * runtime a published app can carry, so it answers undefined rather than
 * publishing a folder that cannot start.
 */
function portablePython(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === '' || !isAbsolute(value)) continue
    for (const root of [value, dirname(value), dirname(dirname(value))]) {
      // A `bin` directory is the interpreter's home, not the runtime root:
      // copying it alone would leave the stdlib behind.
      if (basename(root).toLowerCase() === 'bin') continue
      if (pythonLayout(root) !== undefined) return root
    }
  }
  return undefined
}

/**
 * Where publishing copies from on this deployment.
 *
 * The packaged Desktop names everything through environment variables; a
 * checkout falls back to the sibling IAX build.  A row's `config:` wins over
 * both, so a deployment can point at another tree without editing this file.
 */
export function resolvePublishSources(
  environment: NodeJS.ProcessEnv = process.env,
  config: PublishConfig = {},
): PublishSources {
  const platform = platformDirectory()
  if (platform === undefined) {
    throw new PublishUnavailableError(`publishing a native app is not supported on ${process.platform}`)
  }
  const iax = environment.IAX_ROOT ?? environment.IAX_PLATFORM_ROOT
    ?? resolve(packageRoot, '..', '..', '..', '..', 'IAX')
  const bridgePath = config.bridge ?? environment.IAM_BRIDGE_SCRIPT
    ?? join(packageRoot, '..', 'algorithm-bridge', 'python', 'bridge.py')
  const vendor = join(dirname(bridgePath), 'vendor')
  const nativeDirectory = config.nativeDir ?? environment.IAM_NATIVE_DIR
    ?? join(iax, 'build', 'exe', platform)
  const pythonDirectory = portablePython(
    config.python,
    environment.IAX_APP_PYTHON_DIR,
    environment.IAM_BRIDGE_PYTHON,
  )
  if (pythonDirectory === undefined) {
    throw new PublishUnavailableError(
      'publishing bundles a portable Python runtime, and none is configured; '
      + 'set IAX_APP_PYTHON_DIR or IAM_BRIDGE_PYTHON to a runtime directory (or an interpreter inside one), '
      + 'or give the publisher row config.python',
    )
  }
  return {
    nativeDirectory,
    pythonDirectory,
    bridgePath,
    algorithmsRoot: config.algorithms ?? environment.IAM_PYTHON_PACKAGE_DIR
      ?? (existsSync(join(vendor, 'iam_algorithms')) ? vendor : join(iax, 'build', 'CMakePlatforms', platform, 'IAM', 'Host', 'Python')),
    iamRoot: config.iam ?? environment.IAM_MINING_PYTHON_DIR
      ?? (existsSync(join(vendor, 'iam')) ? vendor : join(iax, 'Mining', 'Host', 'python')),
    fontsDirectory: config.fonts ?? environment.IAM_FONTS_DIR ?? environment.ACAD ?? join(iax, 'Fonts'),
    resourceDirectory: config.resource ?? environment.IAX_RESOURCE
      ?? (existsSync(join(nativeDirectory, 'resource')) ? join(nativeDirectory, 'resource') : join(iax, 'resource')),
  }
}

/** Names the tool may not replace or delete, even with force. */
const PROTECTED_OUTPUTS = new Set(['.iax', '.agents'])

/**
 * Resolve a publish target inside a workspace.
 *
 * The tool writes hundreds of megabytes and can replace a directory, so the
 * target is confined to the session workspace the same way the forge confines
 * a validate path, and the directories that hold the user's own data are never
 * themselves replaceable.  The nearest existing ancestor is resolved through
 * symlinks, so a link cannot walk the target out.
 */
export function resolveWorkspaceOutput(workspace: string, target: string): string {
  const root = realpathSync(workspace)
  let resolved = resolve(root, target)
  const missing: string[] = []
  while (!existsSync(resolved)) {
    missing.unshift(basename(resolved))
    const parent = dirname(resolved)
    if (parent === resolved) break
    resolved = parent
  }
  const real = resolve(realpathSync(resolved), ...missing)
  const inside = relative(root, real)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new PublishRefusalError(`the output escapes the workspace: ${real} is outside ${root}`)
  }
  if (inside === '') throw new PublishRefusalError('the output cannot be the workspace itself')
  const first = inside.split(sep)[0] ?? ''
  if (first === '.git' || (PROTECTED_OUTPUTS.has(first) && !inside.includes(sep))) {
    throw new PublishRefusalError(`the output cannot replace ${inside}; choose a directory beside it`)
  }
  return real
}
