import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import {
  baseExecutableName,
  PublishRefusalError,
  publish,
  resolvePublishSources,
  resolveWorkspaceOutput,
  type PublishConfig,
} from './publish.js'

/** The one tool this package registers. */
export const APP_PUBLISH = 'iam_app_publish'

export interface AppPublisherConfig extends PublishConfig {
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
const WORKSPACE_DESCRIPTION =
  'The workspace holding `.iax/workflows`. Omit it and the session\'s own working ' +
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

/**
 * The selected workflow names, in ribbon order.
 *
 * A name is a directory under `.iax/workflows` and nothing else: a separator or
 * a `..` here would read a workflow from outside the workspace, so it is
 * refused before the first read rather than joined and discovered later.
 */
function workflowNamesOf(args: unknown): string[] | undefined {
  const value = (args as Record<string, unknown> | null)?.workflows
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('"workflows" must be a non-empty array of workflow names')
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('"workflows" must contain non-empty names')
    }
    if (entry === '.' || entry === '..' || entry.includes('/') || entry.includes('\\') || entry.includes('\0')) {
      throw new Error(`"${entry}" is not a workflow name; names are directories under .iax/workflows`)
    }
  }
  return [...new Set(value as string[])]
}

function baseOf(args: unknown): 'drawing' | 'mining' {
  const value = (args as Record<string, unknown> | null)?.base
  if (value === undefined || value === null) return 'mining'
  if (value !== 'drawing' && value !== 'mining') {
    throw new Error('"base" must be drawing or mining')
  }
  return value
}

/**
 * The workspace a call is about: the one it named, else the SESSION's, else the
 * one the deployment configured.
 *
 * The session is asked rather than assumed, for the reason the other tool
 * packages state: a profile is deployment-wide while a session's workspace is
 * the actual one.  A named workspace must stay inside the anchor.
 */
async function workspaceOf(
  args: unknown,
  config: AppPublisherConfig,
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

function renderPublish(_args: unknown, value: unknown): TextBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  if (record.ok === false) return [{ type: 'text', text: `refused: ${String(record.refused ?? '')}` }]
  const workflows = Array.isArray(record.workflows) ? record.workflows as string[] : []
  const lines = [
    `published: ${String(record.output ?? '')}`,
    `executable: ${String(record.executable ?? '')}`,
    `workflows: ${workflows.join(', ')}`,
    `config: ${String(record.config ?? '')}`,
  ]
  if (typeof record.zip === 'string') lines.push(`zip: ${record.zip}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function appPublishTool(config: AppPublisherConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: APP_PUBLISH,
    description:
      'Publishes a portable desktop app around the platform\'s base executable (IamMining by ' +
      'default, IamDrawing on request): the executable and its DLLs, the selected frozen ' +
      'workflows, bridge.py, the vendored bindings, the Python runtime and an iam-app.json ' +
      'ribbon descriptor. This is a file copy, not a build, and publishing the second app is ' +
      'the same call with another selection. Only active workflows ship; a draft, or a manifest ' +
      'the parameter dialog cannot draw, is a refusal. The order of `workflows` becomes ribbon ' +
      'order; omission publishes every active workflow sorted by name. `out` is resolved ' +
      'against the workspace and must stay inside it; an existing non-empty target is refused ' +
      'unless force is true. The published app runs its workflows through python/bridge.py ' +
      'directly: it needs no Harness installation and no model endpoint. Deployment paths ' +
      'come from IAM_NATIVE_DIR / IAM_FONTS_DIR / IAM_BRIDGE_SCRIPT / IAM_BRIDGE_PYTHON (or ' +
      'the publisher row\'s config), so a packaged Desktop publishes without extra setup; the ' +
      'Python runtime must already carry the packages the workflows import (the platform\'s own ' +
      'iam/ and iam_algorithms/ are copied for you).',
    parameters: {
      type: 'object',
      properties: {
        out: {
          type: 'string',
          description: 'The output folder, relative to the workspace and inside it. ' +
            'Replaced only with force. Example: dist/mining-workbench.',
        },
        base: {
          enum: ['mining', 'drawing'],
          default: 'mining',
          description: 'Which base executable the app is published around.',
        },
        workflows: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Workflow names under <workspace>/.iax/workflows, in ribbon order. ' +
            'Omit to publish every active workflow sorted by name.',
        },
        title: { type: 'string', description: 'The window title in iam-app.json.' },
        tab: { type: 'string', description: 'The ribbon tab label; default 能力 / Capabilities.' },
        group: {
          type: 'string',
          description: 'Put every workflow in one ribbon group with this label instead of ' +
            'grouping by the text before each name\'s last hyphen.',
        },
        zip: { type: 'boolean', default: false, description: 'Also write <out>.zip beside the folder.' },
        force: { type: 'boolean', default: false, description: 'Replace a non-empty output folder.' },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['out'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderPublish },
    presentCall: args => ({
      card: 'generic',
      title: `Publish desktop app: ${(args as { out?: string })?.out ?? ''}`,
    }),
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('publishing was cancelled')
      const workspace = await workspaceOf(args, config, probe, exec)
      if (workspace === undefined) {
        throw new Error('iam_app_publish needs a workspace; name one or run in a session directory')
      }
      const out = requireString(args, 'out')
      const base = baseOf(args)
      const workflowNames = workflowNamesOf(args)
      const title = optionalString(args, 'title')
      const tab = optionalString(args, 'tab')
      const group = optionalString(args, 'group')
      try {
        const sources = resolvePublishSources(process.env, config)
        const result = publish({
          ...sources,
          base,
          workflowsRoot: join(workspace, '.iax', 'workflows'),
          outputDirectory: resolveWorkspaceOutput(workspace, out),
          ...(workflowNames === undefined ? {} : { workflowNames }),
          ...(title === undefined ? {} : { title }),
          ...(tab === undefined ? {} : { tabLabel: tab }),
          ...(group === undefined ? {} : { groupLabel: group }),
          zip: optionalBoolean(args, 'zip') === true,
          force: optionalBoolean(args, 'force') === true,
        })
        return {
          ok: true,
          output: result.outputDirectory,
          executable: baseExecutableName(base),
          workflows: result.workflows.map(workflow => workflow.name),
          config: result.configPath,
          ...(result.zipPath === undefined ? {} : { zip: result.zipPath }),
        }
      }
      catch (error) {
        // A contract the request cannot meet is an answer the model can act on;
        // a deployment missing its native/Python files is a failed call.
        if (error instanceof PublishRefusalError) return { ok: false, refused: error.message }
        throw error
      }
    },
  }
}
