import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { cleanup, fakeTools, loadToolHost, mkdtemp, pluginRoot } from './helpers.mjs'

const repoRoot = resolve(pluginRoot, '..', '..')
const {
  index: renderPlugin,
  'render-document-tool': { planHeadlessRenderArguments },
  'headless-render-process': { readSupportedRendererOptions },
  'headless-renderer-path': { resolveHeadlessRendererExecutablePath },
  'ppm-to-png': { convertP6PpmToPng },
} = await loadToolHost('render', [
  'render-document-tool', 'headless-render-process', 'headless-renderer-path', 'ppm-to-png',
])

function toolDefinition(config = {}) {
  // The same two-method slice the neighbouring tool tests mount with: `apply`
  // reads `ctx.tools` and optionally `ctx.inject`, and nothing else.
  const tools = fakeTools()
  const context = {
    tools,
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn({}),
  }
  renderPlugin.apply(context, config)
  assert.equal(tools.registered.size, 1, 'the plugin registers exactly one tool')
  return { definition: tools.registered.get('iam_render_document'), context, tools }
}

test('apply registers iam_render_document with the contract schema', () => {
  const { definition } = toolDefinition()
  assert.equal(definition.name, 'iam_render_document')
  assert.deepEqual(definition.parameters.required, ['document'])
  assert.equal(definition.parameters.properties.document.type, 'string')
  assert.deepEqual(definition.parameters.properties.view.enum,
    ['iso', 'top', 'front', 'side', 'section', 'current'])
  assert.deepEqual(definition.parameters.properties.overlay.items.enum,
    ['axis', 'legend', 'scale'])
  const document = definition.parameters.properties.document
  assert.match(document.description, /Absolute path/)
})

test('the tool schemas stay inside the harness JSON Schema subset', () => {
  // The harness rejects `"type": ["integer", "null"]` outright and refuses the
  // whole plugin entry, so a nullable scalar has to be oneOf.  Walking the two
  // schemas here catches that regression without needing a harness checkout.
  const { definition } = toolDefinition()
  const visit = (node, path) => {
    assert.ok(node !== null && typeof node === 'object', `${path} is a schema object`)
    assert.ok(!Array.isArray(node.type),
      `${path}.type must be a single type string; use oneOf for a nullable value`)
    for (const [key, child] of Object.entries(node.properties ?? {}))
      visit(child, `${path}.properties.${key}`)
    if (node.items !== undefined) visit(node.items, `${path}.items`)
    for (const [index, child] of (node.oneOf ?? []).entries())
      visit(child, `${path}.oneOf[${index}]`)
  }
  visit(definition.parameters, 'parameters')
  visit(definition.output.schema, 'output.schema')
})

test('the render argument plan uses only the options the build lists', () => {
  const build = new Set(['--fit', '--fit-bbox', '--overlay', '--imgui'])
  const plan = planHeadlessRenderArguments(
    {
      width: 120,
      height: 80,
      viewPreset: 'iso',
      fitElementIds: [],
      overlays: ['axis'],
      includeImGui: false,
    },
    build,
  )
  assert.ok(plan.commandArguments.includes('--overlay'), 'a supported option is passed')
  assert.ok(!plan.commandArguments.includes('--view'), 'an unsupported option is not passed')
  assert.ok(plan.skippedOptions.includes('view=iso (--view unsupported)'),
    'the unsupported option is named rather than dropped')
  assert.ok(plan.commandArguments.includes('--fit'), 'a plain fit is the fallback')
})

test('a real executable whose --help lacks --view has view skipped, not passed', async (t) => {
  // The options test executable is a real process that answers --help with its
  // own usage and knows nothing about the renderer's flags: exactly the old
  // build this rule exists for, without having to keep one around.
  const optionsTestExecutablePath = join(repoRoot, 'build', 'exe', 'win-native', 'IamHeadlessOptionsTest.exe')
  if (!existsSync(optionsTestExecutablePath)) {
    t.skip('the options test executable has not been built')
    return
  }
  const supported = await readSupportedRendererOptions(optionsTestExecutablePath, 20000)
  assert.ok(!supported.has('--view'), 'the stand-in does not advertise --view')
  const plan = planHeadlessRenderArguments(
    {
      width: 100, height: 80,
      viewPreset: 'iso',
      fitElementIds: [],
      overlays: ['axis'],
      includeImGui: false,
    },
    supported,
  )
  assert.ok(!plan.commandArguments.includes('--view'), 'the view flag is not passed')
  assert.ok(!plan.commandArguments.includes('--overlay'), 'the overlay flag is not passed')
  assert.ok(plan.skippedOptions.includes('view=iso (--view unsupported)'))
  assert.ok(plan.skippedOptions.includes('overlay=axis (--overlay unsupported)'))
})

test('the render argument plan follows the framing precedence', () => {
  const build = new Set(['--fit', '--fit-elements', '--fit-bbox', '--view', '--overlay'])
  const elementsFirst = planHeadlessRenderArguments(
    {
      width: 120, height: 80,
      viewPreset: 'top',
      fitElementIds: ['orebody-RE1'],
      fitWorldBounds: [0, 0, 0, 1, 1, 1],
      overlays: [],
      includeImGui: false,
    },
    build,
  )
  assert.ok(elementsFirst.commandArguments.includes('--fit-elements'))
  assert.ok(!elementsFirst.commandArguments.includes('--fit-bbox'), 'the box is below elements')
  assert.ok(!elementsFirst.commandArguments.includes('--view'), 'the view is below elements')
  assert.ok(elementsFirst.skippedOptions.some((entry) => entry.includes('superseded by fitElements')))

  const cameraFirst = planHeadlessRenderArguments(
    {
      width: 120, height: 80,
      cameraSpec: '1,2,3,4,5',
      viewPreset: 'top',
      fitElementIds: ['orebody-RE1'],
      fitWorldBounds: undefined,
      overlays: [],
      includeImGui: false,
    },
    build,
  )
  assert.ok(cameraFirst.commandArguments.includes('--camera'))
  assert.ok(!cameraFirst.commandArguments.includes('--fit-elements'))
  assert.ok(!cameraFirst.commandArguments.includes('--view'))
  assert.ok(cameraFirst.skippedOptions.includes('fitElements=orebody-RE1 (superseded by camera)'))

  const section = planHeadlessRenderArguments(
    { width: 64, height: 64, viewPreset: 'section', fitElementIds: [], overlays: [], includeImGui: false },
    build,
  )
  assert.deepEqual(section.commandArguments.slice(-2), ['--view', 'section:0'])
})

test('the PPM encoder converts a complete frame and refuses a truncated one', () => {
  const pixels = Buffer.from([
    255, 0, 0, 0, 255, 0,
    0, 0, 255, 255, 255, 255,
  ])
  const ppm = Buffer.concat([Buffer.from('P6\n2 2\n255\n', 'ascii'), pixels])
  const converted = convertP6PpmToPng(ppm)
  assert.equal(converted.width, 2)
  assert.equal(converted.height, 2)
  assert.deepEqual(converted.pngBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  assert.throws(
    () => convertP6PpmToPng(ppm.subarray(0, ppm.length - 5)),
    /truncated/,
    'a short frame is never decoded as a success',
  )
})

test('a wrong IAM_NATIVE_HEADLESS_TOOL is an error naming that path', () => {
  const saved = process.env.IAM_NATIVE_HEADLESS_TOOL
  const wrong = join(repoRoot, 'no-such-dir', 'NoSuchRenderer.exe')
  process.env.IAM_NATIVE_HEADLESS_TOOL = wrong
  try {
    assert.throws(() => resolveHeadlessRendererExecutablePath(), (error) => {
      assert.match(error.message, /NoSuchRenderer/)
      assert.match(error.message, /IAM_NATIVE_HEADLESS_TOOL/)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env.IAM_NATIVE_HEADLESS_TOOL
    else process.env.IAM_NATIVE_HEADLESS_TOOL = saved
  }
})

test('the document is checked before any subprocess starts', async () => {
  const { definition } = toolDefinition()
  const saved = process.env.IAM_NATIVE_HEADLESS_TOOL
  process.env.IAM_NATIVE_HEADLESS_TOOL = join(repoRoot, 'no-such-dir', 'NoSuchRenderer.exe')
  try {
    const missing = join(repoRoot, 'mining-test-output', 'no-such-document.iamh')
    await assert.rejects(
      definition.execute({ document: missing }, { signal: new AbortController().signal }),
      (error) => {
        assert.match(error.message, /no such file/)
        assert.ok(error.message.includes(missing))
        assert.doesNotMatch(error.message, /NoSuchRenderer/,
          'the renderer was never looked up, so the document check ran first')
        return true
      },
    )
  } finally {
    if (saved === undefined) delete process.env.IAM_NATIVE_HEADLESS_TOOL
    else process.env.IAM_NATIVE_HEADLESS_TOOL = saved
  }
})

async function realRenderer() {
  try {
    return resolveHeadlessRendererExecutablePath()
  } catch {
    return undefined
  }
}

test('a real render writes the requested PNG, deterministically', async (t) => {
  const tool = await realRenderer()
  const document = join(repoRoot, 'mining-test-output', 'alpha.iamh')
  if (tool === undefined || !existsSync(document)) {
    t.skip('no renderer or fixture in this checkout')
    return
  }

  const { definition } = toolDefinition()
  const scratch = mkdtemp('iam-render-test-')
  try {
    const first = join(scratch, 'first.png')
    const second = join(scratch, 'second.png')
    const args = {
      document,
      width: 160,
      height: 120,
      view: 'top',
      overlay: ['axis'],
    }
    const one = await definition.execute({ ...args, out: first }, { signal: new AbortController().signal })
    const two = await definition.execute({ ...args, out: second }, { signal: new AbortController().signal })

    assert.equal(one.exitCode, 0)
    assert.equal(one.width, 160)
    assert.equal(one.height, 120)
    assert.ok(one.bytes > 0)
    assert.ok(statSync(first).size > 0)
    assert.equal(statSync(first).size, one.bytes)
    assert.deepEqual(readFileSync(first), readFileSync(second),
      'the same request produces the same PNG')
    assert.match(one.command, /IamNativeHeadlessMining/)
    assert.match(one.command, /--out/)

    const supported = await readSupportedRendererOptions(tool, 20000)
    if (supported.has('--view')) {
      assert.ok(!one.skipped.some((entry) => entry.startsWith('view=')),
        'a supported --view is not reported as skipped')
    } else {
      assert.ok(one.skipped.some((entry) => entry.startsWith('view=')),
        'an unsupported --view is reported')
    }
    if (supported.has('--overlay')) {
      assert.ok(!one.skipped.some((entry) => entry.startsWith('overlay=')),
        'a supported --overlay is not reported as skipped')
    }

    if (supported.has('--fit-elements')) {
      await assert.rejects(
        definition.execute(
          { document, width: 160, height: 120, fitElements: ['definitely-not-an-element'], out: join(scratch, 'missing.png') },
          { signal: new AbortController().signal },
        ),
        (error) => {
          assert.match(error.message, /definitely-not-an-element/,
            'the renderer\'s missing-id diagnosis reaches the caller')
          assert.match(error.message, /command:/)
          return true
        },
      )
    }
  } finally {
    cleanup()
  }
})

test('the tool works with no config at all', async (t) => {
  const tool = await realRenderer()
  const document = join(repoRoot, 'mining-test-output', 'alpha.iamh')
  if (tool === undefined || !existsSync(document)) {
    t.skip('no renderer or fixture in this checkout')
    return
  }
  // The same definition apply(ctx) with no config registers, used directly.
  // Only `document` and `out` are given: width, height, timeout and the tool
  // search all have defaults, and this is the proof that they work together.
  const { definition } = toolDefinition()
  assert.match(definition.parameters.properties.width.description, /1600/)
  assert.match(definition.parameters.properties.height.description, /900/)

  const scratch = mkdtemp('iam-render-default-')
  try {
    const out = join(scratch, 'default.png')
    const result = await definition.execute({ document, out }, { signal: new AbortController().signal })
    assert.equal(result.width, 1600)
    assert.equal(result.height, 900)
    assert.ok(result.bytes > 0)
    assert.ok(existsSync(out))
  } finally {
    cleanup()
  }
})
