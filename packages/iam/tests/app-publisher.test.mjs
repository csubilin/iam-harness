import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { cleanup, fakeTools, loadToolHost, mkdtemp } from './helpers.mjs'

after(cleanup)

const publisher = await loadToolHost('app-publisher', ['tools', 'publish'])
const { name, inject, apply } = publisher.index
const { APP_PUBLISH } = publisher.tools
const { resolvePublishSources } = publisher.publish

/** Mount the plugin the way a profile does, with an optional session seam. */
function mount(config = {}, workingDirectory) {
  const tools = fakeTools()
  const ctx = {
    tools,
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn(workingDirectory === undefined ? {} : { workingDirectory }),
  }
  apply(ctx, config)
  return tools
}

/** Call a tool the way the Harness does: a value, rendered by the definition. */
async function call(tools, toolName, args) {
  const definition = tools.registered.get(toolName)
  assert.ok(definition, `${toolName} is not registered`)
  const value = await definition.execute(args, { signal: new AbortController().signal })
  assert.ok(value !== null && typeof value === 'object', `${toolName} must return an object`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} rendered nothing`)
  return { value, text: blocks[0].text }
}

function writeWorkflow(root, label, manifest = {}) {
  const directory = join(root, label)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    name: label,
    title: `Title ${label}`,
    answers: `Runs ${label}.`,
    version: '1.0.0',
    inputs: { required: [], optional: [] },
    ...manifest,
  }))
  writeFileSync(join(directory, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
}

/** A workspace with two frozen capabilities, and the trees publishing copies. */
function fixture() {
  const root = mkdtemp('iam-app-publisher-')
  const workspace = join(root, 'workspace')
  const workflowsRoot = join(workspace, '.iax', 'workflows')
  mkdirSync(workflowsRoot, { recursive: true })
  writeWorkflow(workflowsRoot, 'orebody-model')
  writeWorkflow(workflowsRoot, 'orebody-report')

  const nativeDirectory = join(root, 'native')
  mkdirSync(nativeDirectory, { recursive: true })
  writeFileSync(join(nativeDirectory, process.platform === 'win32' ? 'IamMining.exe' : 'IamMining'), 'exe')
  writeFileSync(join(nativeDirectory, 'IAXCoreRuntime.dll'), 'dll')

  const pythonDirectory = join(root, 'python')
  mkdirSync(pythonDirectory, { recursive: true })
  writeFileSync(join(pythonDirectory, 'python.exe'), 'python')

  const algorithmsRoot = join(root, 'algorithms')
  mkdirSync(join(algorithmsRoot, 'iam_algorithms'), { recursive: true })
  writeFileSync(join(algorithmsRoot, 'iam_algorithms', '__init__.py'), '')
  const iamRoot = join(root, 'iam')
  mkdirSync(join(iamRoot, 'iam'), { recursive: true })
  writeFileSync(join(iamRoot, 'iam', '__init__.py'), '')

  const bridgeDirectory = join(root, 'bridge')
  mkdirSync(bridgeDirectory, { recursive: true })
  writeFileSync(join(bridgeDirectory, 'bridge.py'), '# bridge\n')

  return {
    root,
    workspace,
    workflowsRoot,
    config: {
      workspace,
      nativeDir: nativeDirectory,
      python: pythonDirectory,
      algorithms: algorithmsRoot,
      iam: iamRoot,
      bridge: join(bridgeDirectory, 'bridge.py'),
    },
  }
}

test('registers the one publish tool behind the tools registry', () => {
  assert.equal(name, 'iam-app-publisher')
  assert.deepEqual(inject, ['tools'])
  const tools = mount()
  assert.deepEqual([...tools.registered.keys()], [APP_PUBLISH])
  const definition = tools.registered.get(APP_PUBLISH)
  assert.deepEqual(definition.parameters.required, ['out'])
  assert.equal(definition.parameters.properties.base.default, 'mining')
})

test('publishes the selected workflows into a folder the native host reads', async () => {
  const { workspace, config } = fixture()
  const tools = mount(config, { ensure: async () => workspace })
  const { value, text } = await call(tools, APP_PUBLISH, {
    out: 'dist/mining-workbench',
    workflows: ['orebody-report', 'orebody-model'],
    title: 'Mine workbench',
  })

  assert.equal(value.ok, true)
  assert.equal(value.workflows.join(','), 'orebody-report,orebody-model')
  const output = value.output
  assert.ok(existsSync(join(output, 'IAXCoreRuntime.dll')))
  assert.ok(existsSync(join(output, 'python', 'vendor', 'iam_algorithms', '__init__.py')))
  assert.ok(existsSync(join(output, 'python-runtime', 'python.exe')))
  assert.ok(existsSync(join(output, 'workspace')))

  const configFile = JSON.parse(readFileSync(join(output, 'iam-app.json'), 'utf8'))
  assert.equal(configFile.title, 'Mine workbench')
  // Selection order is the ribbon order, not the directory's.
  assert.deepEqual(configFile.tabs[0].groups[0].items.map(item => item.workflow),
    ['orebody-report', 'orebody-model'])
  assert.match(text, /published: /)
})

test('refuses a draft rather than publishing it, and writes nothing', async () => {
  const { workspace, workflowsRoot, root, config } = fixture()
  writeWorkflow(workflowsRoot, 'draft-model', { status: 'draft' })
  const tools = mount(config, { ensure: async () => workspace })
  const { value, text } = await call(tools, APP_PUBLISH, { out: 'dist/app' })

  assert.equal(value.ok, false)
  assert.match(value.refused, /draft/i)
  assert.doesNotMatch(text, /published:/)
  assert.equal(existsSync(join(root, 'dist')), false)
})

test('keeps writes inside the workspace and refuses to replace it', async () => {
  const { workspace, config } = fixture()
  const tools = mount(config, { ensure: async () => workspace })

  const escaped = await call(tools, APP_PUBLISH, { out: '../outside' })
  assert.equal(escaped.value.ok, false)
  assert.match(escaped.value.refused, /escapes the workspace/i)

  const rootTarget = await call(tools, APP_PUBLISH, { out: '.' })
  assert.equal(rootTarget.value.ok, false)
  assert.match(rootTarget.value.refused, /cannot be the workspace itself/i)
})

test('refuses a job name that is a path, not a workflow directory', async () => {
  const { workspace, config } = fixture()
  const tools = mount(config, { ensure: async () => workspace })
  await assert.rejects(
    () => tools.registered.get(APP_PUBLISH).execute(
      { out: 'dist/app', workflows: ['../escape'] }, { signal: new AbortController().signal }),
    /not a workflow name/,
  )
})

test('requires force to replace a non-empty output', async () => {
  const { workspace, config } = fixture()
  const tools = mount(config, { ensure: async () => workspace })
  const first = await call(tools, APP_PUBLISH, { out: 'dist/app' })
  assert.equal(first.value.ok, true)

  const second = await call(tools, APP_PUBLISH, { out: 'dist/app' })
  assert.equal(second.value.ok, false)
  assert.match(second.value.refused, /not empty/i)

  const forced = await call(tools, APP_PUBLISH, { out: 'dist/app', force: true })
  assert.equal(forced.value.ok, true)
})

test('treats a runtime whose interpreter sits under bin/ as a portable root', async () => {
  const { root, workspace, config } = fixture()
  const staged = join(root, 'staged-runtime')
  mkdirSync(join(staged, 'bin'), { recursive: true })
  writeFileSync(join(staged, 'bin', 'python.exe'), 'python')

  // The staged runtime the Desktop ships names its interpreter, not its root;
  // copying the bin/ directory alone would leave the stdlib behind.
  const sources = resolvePublishSources({
    IAM_BRIDGE_PYTHON: join(staged, 'bin', 'python.exe'),
    IAM_BRIDGE_SCRIPT: config.bridge,
    IAM_NATIVE_DIR: config.nativeDir,
    IAM_PYTHON_PACKAGE_DIR: config.algorithms,
    IAM_MINING_PYTHON_DIR: config.iam,
  }, {})
  assert.equal(sources.pythonDirectory, staged)

  const tools = mount({ ...config, python: staged }, { ensure: async () => workspace })
  const { value } = await call(tools, APP_PUBLISH, { out: 'dist/staged' })
  assert.equal(value.ok, true)
  const appConfig = JSON.parse(readFileSync(join(value.output, 'iam-app.json'), 'utf8'))
  assert.equal(appConfig.python, 'python-runtime/bin/python.exe')
  assert.ok(existsSync(join(value.output, 'python-runtime', 'bin', 'python.exe')))
})

test('fails the call when the deployment has no base executable', async () => {
  const { workspace, config } = fixture()
  const empty = join(config.nativeDir, 'missing')
  const tools = mount({ ...config, nativeDir: empty }, { ensure: async () => workspace })
  await assert.rejects(
    () => tools.registered.get(APP_PUBLISH).execute(
      { out: 'dist/app' }, { signal: new AbortController().signal }),
    /base executable is missing/,
  )
})
