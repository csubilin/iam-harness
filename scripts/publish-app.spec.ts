import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_SCHEMA_VERSION, baseExecutableName, buildAppConfig, groupWorkflows, publish,
  readWorkflowSources,
} from './publish-app.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'publish-app-'))
  roots.push(root)
  return root
}

function writeWorkflow(root: string, name: string, manifest: Record<string, unknown> = {}): void {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    name,
    title: `Title ${name}`,
    answers: `Runs ${name}.`,
    version: '1.0.0',
    inputs: { required: [], optional: [] },
    steps: [{ id: 'run', does: 'Do it.', requires: [], produces: ['result'] }],
    ...manifest,
  }))
  writeFileSync(join(directory, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('readWorkflowSources', () => {
  it('sorts discovery but keeps an explicit selection in the caller’s order', () => {
    const root = temporaryRoot()
    writeWorkflow(root, 'zeta-model')
    writeWorkflow(root, 'alpha-model')
    expect(readWorkflowSources(root).map(source => source.name)).toEqual(['alpha-model', 'zeta-model'])
    expect(readWorkflowSources(root, ['zeta-model', 'alpha-model']).map(source => source.name))
      .toEqual(['zeta-model', 'alpha-model'])
  })

  it('refuses a draft and a missing entry', () => {
    const root = temporaryRoot()
    writeWorkflow(root, 'draft-model', { status: 'draft' })
    expect(() => readWorkflowSources(root)).toThrow(/draft/i)
    const missing = temporaryRoot()
    writeWorkflow(missing, 'broken-model', { entry: 'missing.py' })
    expect(() => readWorkflowSources(missing)).toThrow(/entry/i)
  })

  it('refuses a manifest the parameter dialog cannot draw', () => {
    const emptyMeans = temporaryRoot()
    writeWorkflow(emptyMeans, 'empty-means', {
      inputs: { required: [{ name: 'input', kind: 'path', means: '', refused_when: 'no' }] },
    })
    expect(() => readWorkflowSources(emptyMeans)).toThrow(/means/)

    const unknownKind = temporaryRoot()
    writeWorkflow(unknownKind, 'unknown-kind', {
      inputs: { required: [{ name: 'input', kind: 'mystery', means: 'x', refused_when: 'y' }] },
    })
    expect(() => readWorkflowSources(unknownKind)).toThrow(/kind/)

    const noChoices = temporaryRoot()
    writeWorkflow(noChoices, 'no-choices', {
      inputs: { required: [{ name: 'mode', kind: 'enum', means: 'x', refused_when: 'y' }] },
    })
    expect(() => readWorkflowSources(noChoices)).toThrow(/choices/)

    const todoTitle = temporaryRoot()
    writeWorkflow(todoTitle, 'todo-title', { title: 'TODO: name this capability' })
    expect(() => readWorkflowSources(todoTitle)).toThrow(/placeholder/)
  })
})

describe('groupWorkflows', () => {
  const sources = ['orebody-model', 'orebody-report', 'plain'].map(name => ({
    name, title: name, version: null, directory: '', entry: 'workflow.py',
  }))

  it('groups by the domain before the last hyphen', () => {
    expect(groupWorkflows(sources)).toEqual([
      { label: 'orebody', items: [{ workflow: 'orebody-model', label: 'orebody-model' }, { workflow: 'orebody-report', label: 'orebody-report' }] },
      { label: '流程', items: [{ workflow: 'plain', label: 'plain' }] },
    ])
  })

  it('honours one explicit group label', () => {
    expect(groupWorkflows(sources, '全部')).toEqual([{
      label: '全部',
      items: sources.map(source => ({ workflow: source.name, label: source.name })),
    }])
  })
})

describe('buildAppConfig', () => {
  it('writes one tab, the bundled paths and the selected order', () => {
    const sources = ['orebody-model', 'orebody-report'].map(name => ({
      name, title: name, version: null, directory: '', entry: 'workflow.py',
    }))
    expect(buildAppConfig(sources, { base: 'mining', python: 'python-runtime/python.exe' })).toEqual({
      schemaVersion: APP_SCHEMA_VERSION,
      title: 'Mining 工作台',
      workflows: 'workflows',
      workspace: 'workspace',
      python: 'python-runtime/python.exe',
      bridge: 'python/bridge.py',
      pythonPath: ['python/vendor'],
      timeoutSeconds: 1800,
      tabs: [{
        label: { en: 'Capabilities', zh: '能力' },
        groups: [{ label: 'orebody', items: sources.map(source => ({ workflow: source.name, label: source.name })) }],
      }],
    })
  })
})

describe('publish', () => {
  function fixture(): { root: string; options: Parameters<typeof publish>[0] } {
    const root = temporaryRoot()
    const native = join(root, 'native')
    const python = join(root, 'python-runtime-source')
    const algorithms = join(root, 'algorithms')
    const iamRoot = join(root, 'iam-source')
    const bridge = join(root, 'bridge')
    const workspace = join(root, 'workspace')
    const workflowsRoot = join(workspace, '.iax', 'workflows')

    mkdirSync(native, { recursive: true })
    writeFileSync(join(native, baseExecutableName('mining')), 'exe')
    writeFileSync(join(native, 'IAXCoreRuntime.dll'), 'dll')
    writeFileSync(join(native, 'SomeTest.exe'), 'not shipped')
    mkdirSync(join(python), { recursive: true })
    writeFileSync(join(python, 'python.exe'), 'python')
    mkdirSync(join(algorithms, 'iam_algorithms'), { recursive: true })
    writeFileSync(join(algorithms, 'iam_algorithms', '__init__.py'), '')
    mkdirSync(join(iamRoot, 'iam'), { recursive: true })
    writeFileSync(join(iamRoot, 'iam', '__init__.py'), '')
    mkdirSync(bridge, { recursive: true })
    writeFileSync(join(bridge, 'bridge.py'), '# bridge\n')
    writeWorkflow(workflowsRoot, 'orebody-model')
    writeWorkflow(workflowsRoot, 'orebody-report')

    return {
      root,
      options: {
        base: 'mining',
        nativeDirectory: native,
        workflowsRoot,
        outputDirectory: join(root, 'published'),
        pythonDirectory: python,
        bridgePath: join(bridge, 'bridge.py'),
        algorithmsRoot: algorithms,
        iamRoot,
        workflowNames: ['orebody-report', 'orebody-model'],
      },
    }
  }

  it('builds the portable folder the native host reads', () => {
    const { options } = fixture()
    const result = publish(options)
    const output = result.outputDirectory

    expect(existsSync(join(output, baseExecutableName('mining')))).toBe(true)
    expect(existsSync(join(output, 'IAXCoreRuntime.dll'))).toBe(true)
    expect(existsSync(join(output, 'SomeTest.exe'))).toBe(false)
    expect(existsSync(join(output, 'workflows', 'orebody-model', 'manifest.json'))).toBe(true)
    expect(existsSync(join(output, 'python', 'bridge.py'))).toBe(true)
    expect(existsSync(join(output, 'python', 'vendor', 'iam_algorithms', '__init__.py'))).toBe(true)
    expect(existsSync(join(output, 'python', 'vendor', 'iam', '__init__.py'))).toBe(true)
    expect(existsSync(join(output, 'python-runtime', 'python.exe'))).toBe(true)
    expect(existsSync(join(output, 'workspace'))).toBe(true)

    const config = JSON.parse(readFileSync(join(output, 'iam-app.json'), 'utf8')) as {
      schemaVersion: number
      python: string
      tabs: { groups: { label: string; items: { workflow: string }[] }[] }[]
    }
    const tab = config.tabs[0]
    if (tab === undefined) throw new Error('iam-app.json has no tab')
    const group = tab.groups[0]
    if (group === undefined) throw new Error('iam-app.json has no group')
    expect(config.schemaVersion).toBe(APP_SCHEMA_VERSION)
    expect(config.python).toBe('python-runtime/python.exe')
    expect(group.label).toBe('orebody')
    // Selection order is the ribbon order, not the directory's.
    expect(group.items.map(item => item.workflow)).toEqual(['orebody-report', 'orebody-model'])

    const receipt = JSON.parse(readFileSync(join(output, 'publish.json'), 'utf8')) as {
      workflows: { entrySha256: string }[]
    }
    const first = receipt.workflows[0]
    if (first === undefined) throw new Error('publish.json has no workflow')
    expect(receipt.workflows).toHaveLength(2)
    expect(first.entrySha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('refuses to replace a non-empty output without --force', () => {
    const { options } = fixture()
    publish(options)
    expect(() => publish(options)).toThrow(/not empty/i)
    expect(() => publish({ ...options, force: true })).not.toThrow()
  })
})
