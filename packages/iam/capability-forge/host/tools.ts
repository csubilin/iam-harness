import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { callCapability, type CapabilityOptions } from './python.js'

export interface CapabilityPluginConfig extends CapabilityOptions {
  /** Where the user's workspace is, when the deployment knows. */
  workspace?: string
}

export interface ToolExec {
  signal: AbortSignal
  agent?: unknown
}

export type WorkspaceProbe = (exec: ToolExec) => Promise<string | undefined>

interface TextBlock {
  type: 'text'
  text: string
}

type ResultIntent =
  | { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
  | { card: 'generic'; content?: TextBlock[] }

export interface RawToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
  }
  presentCall?: (args: unknown) => ResultIntent | undefined
  presentResult?: (args: unknown, result: { value?: unknown; content?: unknown[] }) => ResultIntent | undefined
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>
}

const objectSchema = { type: 'object', additionalProperties: true } as const
const STAGES = ['ingest', 'model', 'report'] as const
// Han + Latin, digits and underscore, hyphens after the first character. The
// address is a directory name, not a sentence: Chinese and English names are
// both ordinary, while dots and separators would break the lock/spec filenames.
const NAME_PATTERN = '^[A-Za-z0-9_\\u3400-\\u4dbf\\u4e00-\\u9fff][A-Za-z0-9_\\u3400-\\u4dbf\\u4e00-\\u9fff-]{1,63}$'
const WORKSPACE_DESCRIPTION =
  'The workspace holding `.iax/` and `.agents/`. Omit it and the session\'s own working ' +
  'directory is used, which is almost always what you want.'

function requireString(args: unknown, name: string): string {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${name}" is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: unknown, name: string): string | undefined {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string`)
  return value
}

function optionalBoolean(args: unknown, name: string): boolean | undefined {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`"${name}" must be a boolean`)
  return value
}

function stagesOf(args: unknown): string[] {
  const value = (args as Record<string, unknown> | null)?.stages
  if (value === undefined || value === null) return ['model', 'report']
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('"stages" must be a non-empty array of ingest, model and/or report')
  }
  for (const stage of value) {
    if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
      throw new Error('"stages" must contain only ingest, model or report')
    }
  }
  return [...new Set(value as string[])]
}

/**
 * The workspace a call is about: the one it named, else the SESSION's, else the
 * one the deployment configured.
 *
 * The session is asked rather than assumed, for the reason AlgorithmBridge
 * states: a profile is deployment-wide while a session's workspace is the
 * actual one, and a host with several workspaces open would otherwise write
 * into whichever the profile named.
 */
async function workspaceOf(
  args: unknown,
  config: CapabilityPluginConfig,
  probe: WorkspaceProbe | undefined,
  exec: ToolExec,
): Promise<string | undefined> {
  const named = optionalString(args, 'workspace')
  if (named !== undefined && named.trim() === '') throw new Error('"workspace" must name a directory')
  const session = await probe?.(exec)
  const anchor = session ?? config.workspace
  if (named === undefined) return anchor
  if (anchor === undefined) return named
  const root = realpathSync(anchor)
  const target = realpathSync(named)
  const inside = relative(root, target)
  if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(inside)) {
    throw new Error('The named workspace is outside this session or deployment workspace')
  }
  return target
}

function workspaceArguments(arguments_: string[], workspace: string | undefined): void {
  if (workspace) arguments_.push('--workspace', workspace)
}

function renderValue(_args: unknown, value: unknown): TextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * A refusal and its findings, as the lines a reader acts on.
 *
 * The rendering is here and not in the harness: `findings` is a list of
 * structured records, and a card that had to decide what "severity" means would
 * be a second place the contract is understood.
 */
function renderFindings(_args: unknown, value: unknown): TextBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  const findings = Array.isArray(record.findings) ? record.findings as Record<string, unknown>[] : []
  const lines: string[] = []
  if (typeof record.refused === 'string') lines.push(`refused: ${record.refused}`)
  else if (record.ok === false) lines.push('refused')
  else if (record.frozen === true) lines.push(`frozen: ${String(record.directory ?? '')}`)
  for (const finding of findings) {
    lines.push(`${String(finding.severity ?? 'error')} ${String(finding.where ?? '')}: ${String(finding.message ?? '')}`)
  }
  if (lines.length === 0) lines.push(JSON.stringify(value, null, 2))
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderScaffold(_args: unknown, value: unknown): TextBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  if (typeof record.refused === 'string') return [{ type: 'text', text: `refused: ${record.refused}` }]
  const created = Array.isArray(record.created) ? record.created as string[] : []
  const lines = created.map(path => `created ${path}`)
  if (typeof record.next === 'string') lines.push(record.next)
  return [{ type: 'text', text: lines.join('\n') || JSON.stringify(value, null, 2) }]
}

function renderFreeze(_args: unknown, value: unknown): TextBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  if (typeof record.refused === 'string') return [{ type: 'text', text: `refused: ${record.refused}` }]
  if (record.frozen !== true) return renderFindings(_args, value)
  const lock = (record.lock ?? {}) as Record<string, unknown>
  const lines = [
    `frozen: ${String(record.directory ?? '')}`,
    `version: ${String(lock.version ?? 'null')}  catalog: ${String(lock.catalog ?? 'null')}  abi: ${String(lock.abi ?? 'null')}`,
  ]
  if (record.replaced_scaffold === true) lines.push('the scaffold draft was archived under versions/')
  if (record.skill && typeof record.skill === 'object') {
    const skill = record.skill as Record<string, unknown>
    lines.push(skill.written === true
      ? `skill: ${String(skill.path ?? '')}`
      : `skill not written: ${String(skill.reason ?? skill.path ?? '')}`)
  }
  if (record.replaced && typeof record.replaced === 'object') {
    const replaced = record.replaced as Record<string, unknown>
    lines.push(`replaced version ${String(replaced.previous_version)} with ${String(replaced.version)}`)
  }
  if (typeof record.note === 'string') lines.push(record.note)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderAudit(_args: unknown, value: unknown): TextBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities as Record<string, unknown>[] : []
  const findings = Array.isArray(record.findings)
    ? record.findings as Record<string, unknown>[] : []
  const lines = capabilities.map(entry =>
    `${String(entry.name)}  ${entry.lock ? 'locked' : 'unlocked'}  findings: ${String(entry.findings ?? 0)}`)
  for (const finding of findings) {
    lines.push(`${String(finding.severity ?? 'error')} ${String(finding.where ?? '')}: ${String(finding.message ?? '')}`)
  }
  if (lines.length === 0) lines.push('no capabilities under .iax/workflows')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderCandidates(_args: unknown, value: unknown): TextBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  const candidates = Array.isArray(record.candidates)
    ? record.candidates as Record<string, unknown>[] : []
  const lines = candidates.map((candidate) => {
    const artifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts.length : 0
    const frozen = Array.isArray(candidate.frozen_as) && candidate.frozen_as.length > 0
      ? `  frozen as ${(candidate.frozen_as as string[]).join(', ')}` : ''
    return `${String(candidate.latest_run)}  ${String(candidate.successes)} success(es)  ` +
      `${candidate.recommended ? 'recommended' : 'not yet recommended'}  ` +
      `${artifacts} artifact(s)${frozen}`
  })
  if (lines.length === 0) lines.push('no successful runs are waiting to become capabilities')
  if (typeof record.note === 'string') lines.push(record.note)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function capabilityScaffoldTool(
  config: CapabilityPluginConfig,
  probe?: WorkspaceProbe,
): RawToolDefinition {
  return {
    name: 'capability_scaffold',
    description:
      'Creates a capability package from the forge\'s templates: one workflow directory per ' +
      'stage, a skill, and the report/figure spec defaults. The workflow template carries ' +
      'selectable step ids and the reserved steps/resume inputs, so a later call can run only ' +
      'the steps it needs. The manifest starts as status "draft": iam_workflow_list shows it, ' +
      'but iam_workflow_run refuses it until capability_freeze has frozen it. It does NOT run ' +
      'the capability and does NOT freeze it; execution is ' +
      'iam_workflow_run and freezing is capability_freeze. Refuses when a target already exists ' +
      'unless force is true, in which case the old files are archived under versions/<timestamp>/ first.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          pattern: NAME_PATTERN,
          description: 'The domain part of the capability name, e.g. orebody or 矿体. ' +
            'Chinese and English are both accepted; stages are appended.',
        },
        domain: { type: 'string', description: 'Optional domain label for the generated skill.' },
        stages: {
          type: 'array',
          items: { enum: STAGES },
          minItems: 1,
          description: 'Which stages to generate; default model,report.',
        },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
        force: { type: 'boolean', default: false, description: 'Archive and replace existing files.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderScaffold },
    presentCall: args => ({ card: 'generic', title: `Scaffold capability: ${(args as { name?: string })?.name ?? ''}` }),
    async execute(args, exec) {
      const arguments_ = ['--name', requireString(args, 'name')]
      const domain = optionalString(args, 'domain')
      if (domain !== undefined) arguments_.push('--domain', domain)
      arguments_.push('--stages', stagesOf(args).join(','))
      workspaceArguments(arguments_, await workspaceOf(args, config, probe, exec))
      if (optionalBoolean(args, 'force') === true) arguments_.push('--force')
      const outcome = await callCapability('scaffold', arguments_, { ...config, signal: exec.signal })
      return outcome.value
    },
  }
}

export function capabilityValidateTool(
  config: CapabilityPluginConfig,
  probe?: WorkspaceProbe,
): RawToolDefinition {
  return {
    name: 'capability_validate',
    description:
      'Checks one capability manifest and program against the platform\'s contract and returns ' +
      'one finding per rule: the five core sections, the controlled input kinds, template ' +
      'placeholders, step ids and their backward-only requirements, the steps/resume selection ' +
      'contract, alignment of acceptance with acceptance_checks, scheme/version/spec references, ' +
      'and the program\'s hash and syntax. It does NOT run the capability or write anything; ' +
      'execution is iam_workflow_run. A relative `path` is resolved against the workspace and ' +
      'must stay inside it; a refusal names the absolute path it actually checked. strict turns ' +
      'warnings into errors.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A workflow directory or a manifest.json inside one. A relative path is ' +
            'resolved against the workspace, and must stay inside it.',
        },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
        strict: { type: 'boolean', default: false, description: 'Treat warnings as errors.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderFindings },
    presentCall: args => ({ card: 'generic', title: `Validate: ${(args as { path?: string })?.path ?? ''}` }),
    async execute(args, exec) {
      const arguments_ = ['--path', requireString(args, 'path')]
      // The workspace is the boundary a relative path is resolved against; the
      // CLI refuses to guess the server's cwd. An absolute path still needs no
      // boundary, so the argument is optional.
      workspaceArguments(arguments_, await workspaceOf(args, config, probe, exec))
      if (optionalBoolean(args, 'strict') === true) arguments_.push('--strict')
      const outcome = await callCapability('validate', arguments_, { ...config, signal: exec.signal })
      return outcome.value
    },
  }
}

export function capabilityFreezeTool(
  config: CapabilityPluginConfig,
  probe?: WorkspaceProbe,
): RawToolDefinition {
  return {
    name: 'capability_freeze',
    description:
      'Freezes a successful recorded run and a manifest into a named workflow by calling the ' +
      'AlgorithmBridge\'s own freeze, then records a lock with the catalog/algorithm/ABI versions ' +
      'and the schema hashes, and writes the capability\'s usage SKILL.md (unless a ' +
      'user-authored skill already owns that path). The target is frozen as a draft and marked ' +
      'active only after the lock and skill are written, so an interrupted freeze is never ' +
      'addressable. The manifest\'s step ids and prerequisite contract are validated ' +
      'first, so a partial-run selection cannot be frozen into an ambiguous shape. It does NOT ' +
      'execute the capability; execution is iam_workflow_run. confirmed must be true only after ' +
      'the run and its acceptance rules were reviewed by the user.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          pattern: NAME_PATTERN,
          description: 'The capability name, e.g. orebody-model or 矿体-model; Chinese and ' +
            'English are both accepted.',
        },
        run: { type: 'string', description: 'The recorded run id from iam_program_run.' },
        manifest: {
          // ONE OF, NOT A TYPE ARRAY.  The Harness rejects `type: ['object',
          // 'string']` and refuses the whole plugin entry; Render's subset test
          // documents the same gate. The two shapes are a JSON object or a path.
          oneOf: [
            { type: 'object' },
            { type: 'string' },
          ],
          description: 'The manifest object, or a manifest.json path inside the workspace.',
        },
        confirmed: { type: 'boolean', description: 'True only after review; false is refused.' },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['name', 'run', 'manifest', 'confirmed'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderFreeze },
    presentCall: args => ({ card: 'generic', title: `Freeze capability: ${(args as { name?: string })?.name ?? ''}` }),
    async execute(args, exec) {
      const record = (args ?? {}) as Record<string, unknown>
      const manifest = record.manifest
      const manifestIsObject = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      const manifestIsPath = typeof manifest === 'string' && manifest.length > 0
      if (!manifestIsObject && !manifestIsPath) {
        throw new Error('"manifest" must be an object or a non-empty file path')
      }
      if (typeof record.confirmed !== 'boolean') {
        throw new Error('"confirmed" is required and must be a boolean')
      }
      const workspace = await workspaceOf(args, config, probe, exec)
      if (workspace === undefined) {
        throw new Error('capability_freeze needs a workspace; name one or run in a session directory')
      }
      const arguments_ = [
        '--name', requireString(args, 'name'),
        '--run', requireString(args, 'run'),
        '--manifest', manifestIsObject ? '-' : manifest as string,
        '--workspace', workspace,
      ]
      if (record.confirmed === true) arguments_.push('--confirmed')
      const outcome = await callCapability('freeze', arguments_, {
        ...config,
        signal: exec.signal,
        stdin: manifestIsObject ? JSON.stringify(manifest) : undefined,
      })
      return outcome.value
    },
  }
}

export function capabilityAuditTool(
  config: CapabilityPluginConfig,
  probe?: WorkspaceProbe,
): RawToolDefinition {
  return {
    name: 'capability_audit',
    description:
      'Audits the capabilities frozen in a workspace: does workflow.py still match the hash the ' +
      'manifest recorded, did the lock drift from the manifest or the platform catalog, do the ' +
      'result artifacts and figures still exist and match their hashes, and is every manual ' +
      'figure registered? It does NOT run, repair or re-freeze anything; execution is ' +
      'iam_workflow_run. An empty workspace is an empty answer, not an error.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Audit one capability; omit to audit all.' },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderAudit },
    presentCall: () => ({ card: 'generic', title: 'Audit capabilities' }),
    async execute(args, exec) {
      const workspace = await workspaceOf(args, config, probe, exec)
      if (workspace === undefined) {
        throw new Error('capability_audit needs a workspace; name one or run in a session directory')
      }
      const arguments_ = ['--workspace', workspace]
      const name = optionalString(args, 'name')
      if (name !== undefined) arguments_.push('--name', name)
      const outcome = await callCapability('audit', arguments_, { ...config, signal: exec.signal })
      return outcome.value
    },
  }
}

export function capabilityCandidatesTool(
  config: CapabilityPluginConfig,
  probe?: WorkspaceProbe,
): RawToolDefinition {
  return {
    name: 'capability_candidates',
    description:
      'Finds recent successful runs in the workspace that look like reusable capabilities: ' +
      'the same program succeeded more than once, or a run produced accepted-looking products, ' +
      'and no frozen workflow carries its source hash yet. It returns the latest run, the product ' +
      'list and the reasons -- enough for you to ASK THE USER whether the result was accepted and ' +
      'will be needed again. It does NOT freeze, scaffold or run anything; freezing is ' +
      'capability_freeze with confirmed: true, and execution is iam_workflow_run. Propose a ' +
      'candidate only with its evidence, never as a decision already made.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
        limit: { type: 'integer', minimum: 1, description: 'How many proposals to return; default 10.' },
        includeFrozen: { type: 'boolean', default: false,
          description: 'Also list programs a workflow already froze.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderCandidates },
    presentCall: () => ({ card: 'generic', title: 'Capability candidates' }),
    async execute(args, exec) {
      const workspace = await workspaceOf(args, config, probe, exec)
      if (workspace === undefined) {
        throw new Error('capability_candidates needs a workspace; name one or run in a session directory')
      }
      const arguments_ = ['--workspace', workspace]
      const limit = (args as Record<string, unknown> | null)?.limit
      if (limit !== undefined && limit !== null) {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
          throw new Error('"limit" must be a positive integer')
        }
        arguments_.push('--limit', String(limit))
      }
      if (optionalBoolean(args, 'includeFrozen') === true) arguments_.push('--include-frozen')
      const outcome = await callCapability('candidates', arguments_, {
        ...config, signal: exec.signal,
      })
      return outcome.value
    },
  }
}
