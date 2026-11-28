import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { cleanup, fakeTools, loadToolHost, mkdtemp, pluginRoot } from './helpers.mjs'

after(cleanup)

const forge = await loadToolHost('capability-forge')
const pythonHalf = await loadToolHost('capability-forge', ['python'])
const { name, inject, apply } = forge.index
// The one execution entry, used by the draft-lifecycle test: the forge never
// runs a capability, so the "before/after freeze" proof has to call the bridge.
const bridgeHost = await loadToolHost('algorithm-bridge')

/** Mount the plugin the way a profile does, with an optional session seam. */
function mount(config = {}, workingDirectory) {
  const tools = fakeTools()
  const ctx = {
    tools,
    effect: (fn) => fn(),
    inject: (deps, fn) => fn(workingDirectory === undefined ? {} : { workingDirectory }),
  }
  apply(ctx, config)
  return tools
}

function mountBridge(workspace) {
  const tools = fakeTools()
  const ctx = { tools, effect: (fn) => fn(), inject: (_deps, fn) => fn({}) }
  bridgeHost.index.apply(ctx, { allowUnsafeExecution: true, workspace })
  return tools
}

function exec(agent) {
  return { signal: new AbortController().signal, agent }
}

/** Call a tool the way the Harness does: a VALUE, rendered by the definition. */
async function call(tools, toolName, args, agent) {
  const definition = tools.registered.get(toolName)
  assert.ok(definition, `${toolName} is not registered`)
  const value = await definition.execute(args, exec(agent))
  assert.ok(value !== null && typeof value === 'object', `${toolName} must return an object`)
  assert.equal(value.content, undefined,
    `${toolName} returned a content envelope; this contract renders via output.render`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} rendered nothing`)
  return { value, text: blocks[0].text }
}

const CONTRACT = {
  title: 't',
  answers: 'a',
  inputs: {
    required: [
      { name: 'input', kind: 'path', means: 'm', refused_when: 'r' },
      { name: 'mode', kind: 'enum', choices: ['a'], means: 'm', refused_when: 'r' },
    ],
  },
  steps: [{ n: 1, does: 'x' }],
  acceptance: ['one'],
  acceptance_checks: [{ id: 'one', assert: 'True' }],
}

function contract(overrides = {}) {
  return { ...CONTRACT, ...overrides }
}

/** A workflow directory with one manifest and one program. */
function workflowAt(base, label, manifest, program = 'def run(**kwargs):\n    return {}\n') {
  const directory = join(base, label)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'workflow.py'), program)
  return directory
}

/** A recorded run, the way iam_program_run leaves one. */
function recordedRun(workspace, source, id = 'run-20261101-120000-forge1',
  artifacts = [], ok = true, started = '20261101-120000') {
  const directory = join(workspace, '.iax', 'runs', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'program.py'), source)
  const digest = createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
  writeFileSync(join(directory, 'run.json'), JSON.stringify({
    started, exit_code: ok ? 0 : 1, ok, timeout: false,
    stdout_truncated: false, stderr_truncated: false, source_sha256: digest,
    artifacts,
  }))
  return id
}

/**
 * Fill every TODO the scaffold left, the way the user would.
 *
 * The draft is supposed to fail validation until this happens; the tests that
 * need a frozen capability call this first. The stage-specific input names and
 * choices are already real, so only prose is replaced.
 */
function fillManifest(path, options = {}) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  // Real content, not "the TODO with its prefix removed": the old template
  // sentence is itself recognized as a placeholder, which is what catches an
  // already-generated package that never edited it.
  const fill = (value, label) => (typeof value === 'string' && value.startsWith('TODO:'))
    ? `filled ${label}`
    : value
  manifest.title = options.title || fill(manifest.title, 'title')
  manifest.answers = fill(manifest.answers, 'answers')
  for (const item of manifest.inputs?.required || []) {
    item.means = fill(item.means, 'means')
    item.refused_when = fill(item.refused_when, 'refused_when')
  }
  for (const step of manifest.steps || []) step.does = fill(step.does, 'step')
  if (Array.isArray(manifest.acceptance)) {
    manifest.acceptance = manifest.acceptance.map((rule) => fill(rule, 'acceptance'))
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  return manifest
}

describe('the plugin as a bundle', () => {
  test('exports the three things a bundle module must', () => {
    assert.equal(name, 'iam-capability-forge')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof apply, 'function')
  })

  test('IAM_CAPABILITY_SCRIPT names the copy outside app.asar', () => {
    // A packaged Desktop cannot run the asar copy: Python opens a real file,
    // and the forge finds schemas/templates beside that file.
    const directory = mkdtempSync(join(tmpdir(), 'iam-forge-script-'))
    const script = join(directory, 'capability.py')
    writeFileSync(script, '')
    const previous = process.env.IAM_CAPABILITY_SCRIPT
    process.env.IAM_CAPABILITY_SCRIPT = script
    try {
      assert.equal(pythonHalf.python.capabilityScript(), script)
    } finally {
      if (previous === undefined) delete process.env.IAM_CAPABILITY_SCRIPT
      else process.env.IAM_CAPABILITY_SCRIPT = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('registers five tools, and no tool can execute a capability', () => {
    const tools = mount()
    assert.deepEqual([...tools.registered.keys()].sort(), [
      'capability_audit',
      'capability_candidates',
      'capability_freeze',
      'capability_scaffold',
      'capability_validate',
    ])
    for (const [toolName, definition] of tools.registered) {
      assert.equal(typeof definition.description, 'string')
      assert.match(definition.description,
        /does NOT (run|execute|freeze)|does not (run|execute|freeze)/i,
        `${toolName}'s description must say it does not run capabilities`)
      assert.match(definition.description, /iam_workflow_run/,
        `${toolName}'s description must name the one execution entry`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(typeof definition.output.render, 'function')
    }
  })

  test('the name pattern accepts Chinese and English and refuses separators', () => {
    const tools = mount()
    for (const toolName of ['capability_scaffold', 'capability_freeze']) {
      const pattern = tools.registered.get(toolName).parameters.properties.name.pattern
      const accepted = new RegExp(pattern)
      for (const name of ['orebody', '矿体', 'orebody-model', '矿体-model']) {
        assert.ok(accepted.test(name), `${toolName} must accept ${name}`)
      }
      for (const name of ['a b', 'a/b', 'a.b', '矿 体']) {
        assert.equal(accepted.test(name), false, `${toolName} must refuse ${name}`)
      }
    }
  })

  test('parameters.required matches what execute checks', () => {
    const tools = mount()
    assert.deepEqual(tools.registered.get('capability_scaffold').parameters.required, ['name'])
    assert.deepEqual(tools.registered.get('capability_validate').parameters.required, ['path'])
    assert.deepEqual(tools.registered.get('capability_freeze').parameters.required,
      ['name', 'run', 'manifest', 'confirmed'])
    assert.deepEqual(tools.registered.get('capability_audit').parameters.required, [])
    assert.deepEqual(tools.registered.get('capability_candidates').parameters.required, [])
  })

  test('the tool schemas stay inside the harness JSON Schema subset', () => {
    // The Harness refuses an array-valued `type` and rejects the whole plugin
    // entry with it. Render's subset test documents the same gate; this walks
    // all five definitions so a union introduced here cannot pass unnoticed.
    const tools = mount()
    const visit = (node, path) => {
      assert.ok(node !== null && typeof node === 'object', `${path} is a schema object`)
      assert.ok(!Array.isArray(node.type),
        `${path}.type must be a single type string; use oneOf for a union`)
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        visit(child, `${path}.properties.${key}`)
      }
      if (node.items !== undefined) visit(node.items, `${path}.items`)
      for (const [index, child] of (node.oneOf ?? []).entries()) {
        visit(child, `${path}.oneOf[${index}]`)
      }
    }
    for (const [toolName, definition] of tools.registered) {
      visit(definition.parameters, `${toolName}.parameters`)
      visit(definition.output.schema, `${toolName}.output.schema`)
    }
  })
})

describe('scaffold', () => {
  test('generates a draft that must be filled before it validates', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    const created = await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    assert.deepEqual(created.value.created, [
      '.iax/workflows/orebody-model/manifest.json',
      '.iax/workflows/orebody-model/workflow.py',
      '.iax/workflows/orebody-report/manifest.json',
      '.iax/workflows/orebody-report/workflow.py',
      '.agents/skills/orebody/SKILL.md',
      '.iax/specs/orebody.report.json',
      '.iax/specs/orebody.figure.json',
    ])
    assert.match(created.value.next, /freeze/)
    const workshop = readFileSync(
      join(workspace, '.agents', 'skills', 'orebody', 'SKILL.md'), 'utf8')
    assert.match(workshop, /何时固化 \/ When to freeze/)
    assert.match(workshop, /Ask three questions/)
    const directory = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(directory, 'manifest.json')

    // The draft is a question, not an answer: validation must reject it.
    const draft = await call(tools, 'capability_validate', { path: directory })
    assert.equal(draft.value.ok, false)
    assert.ok(draft.value.findings.some((finding) => finding.id === 'manifest.placeholder'))
    assert.ok(draft.value.findings.some((finding) => finding.where === 'manifest.answers'))
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).status, 'draft')

    fillManifest(manifestPath)
    const filled = await call(tools, 'capability_validate', { path: directory })
    assert.equal(filled.value.ok, true, JSON.stringify(filled.value.findings))
    assert.deepEqual(filled.value.findings, [])

    // P7: a relative path is resolved against the workspace, not the server cwd.
    const relative = await call(tools, 'capability_validate', {
      path: '.iax/workflows/orebody-model', workspace,
    })
    assert.equal(relative.value.ok, true, JSON.stringify(relative.value.findings))

    await assert.rejects(
      () => call(tools, 'capability_validate', {
        path: '.iax/workflows/nope', workspace,
      }),
      (error) => {
        assert.match(error.message, /there is nothing at/)
        const resolved = join(workspace, '.iax', 'workflows', 'nope').replaceAll('\\', '/')
        assert.ok(error.message.replaceAll('\\', '/').includes(resolved),
          `the refusal names the resolved path: ${error.message}`)
        return true
      },
    )
    await assert.rejects(
      () => call(tools, 'capability_validate', { path: '../../evil', workspace }),
      /escapes the workspace/,
    )
  })

  test('stages generate three different, stage-specific manifests', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', {
      name: 'orebody', stages: ['ingest', 'model', 'report'], workspace,
    })
    const digests = []
    const names = []
    const inputs = []
    for (const stage of ['ingest', 'model', 'report']) {
      const path = join(workspace, '.iax', 'workflows', `orebody-${stage}`, 'manifest.json')
      const bytes = readFileSync(path)
      digests.push(createHash('sha256').update(bytes).digest('hex'))
      const manifest = JSON.parse(bytes.toString('utf8'))
      names.push(manifest.name)
      inputs.push(manifest.inputs.required.map((item) => item.name))
      const pathInput = manifest.inputs.required.find((item) => item.kind === 'path')
      const enumInput = manifest.inputs.required.find((item) => item.kind === 'enum')
      assert.match(manifest.answers, / \/ /, `${manifest.name} answers are bilingual`)
      assert.match(pathInput.means, / \/ /, `${manifest.name} input means are bilingual`)
      assert.match(enumInput.why_not_inferred, / \/ /,
        `${manifest.name} input reasons are bilingual`)
      assert.ok(pathInput.why_not_inferred && pathInput.why_not_inferred.trim(),
        `${manifest.name} must mark its path input non-inferable so the bridge asks before a run`)
      assert.ok(enumInput.why_not_inferred && enumInput.why_not_inferred.trim(),
        `${manifest.name} must mark its enum choice non-inferable too`)
      assert.equal(manifest.status, 'draft')
      assert.match(manifest.title, /^TODO:/)
      assert.match(manifest.answers, /^TODO:/)
      const validated = await call(tools, 'capability_validate', {
        path: join(workspace, '.iax', 'workflows', `orebody-${stage}`),
      })
      assert.equal(validated.value.ok, false)
      assert.ok(validated.value.findings.some((finding) => finding.id === 'manifest.placeholder'))
    }
    assert.equal(new Set(digests).size, 3, 'the three manifests are not distinct')
    assert.deepEqual(names, ['orebody-ingest', 'orebody-model', 'orebody-report'])
    assert.deepEqual(inputs, [
      ['source', 'format'], ['input', 'mode'], ['result', 'format'],
    ])
  })

  test('removing only the TODO prefix does not make a stage placeholder real', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const manifestPath = join(workspace, '.iax', 'workflows', 'orebody-model', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.answers = manifest.answers.replace('TODO: ', '')
    manifest.inputs.required[0].means = manifest.inputs.required[0].means.replace('TODO: ', '')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const validated = await call(tools, 'capability_validate', {
      path: join(workspace, '.iax', 'workflows', 'orebody-model'),
    })
    assert.equal(validated.value.ok, false)
    assert.ok(validated.value.findings.some((finding) =>
      finding.id === 'manifest.placeholder' && finding.where === 'manifest.answers'))
    assert.ok(validated.value.findings.some((finding) =>
      finding.id === 'manifest.placeholder'
      && finding.where === 'manifest.inputs.required[1].means'))
  })

  test('a Chinese capability name is an address, not a language switch', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    const created = await call(tools, 'capability_scaffold', { name: '矿体', workspace })
    assert.ok(created.value.created.includes('.iax/workflows/矿体-model/manifest.json'))
    assert.ok(created.value.created.includes('.agents/skills/矿体/SKILL.md'))
    // The harness skill name is lowercase ASCII only. The human-readable
    // directory and description keep 矿体; the frontmatter gets a valid address.
    const workshop = readFileSync(
      join(workspace, '.agents', 'skills', '矿体', 'SKILL.md'), 'utf8')
    const workshopName = workshop.match(/^name: "([^"]+)"/m)[1]
    assert.match(workshopName, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.match(workshop, /矿体/)
    const manifestPath = join(workspace, '.iax', 'workflows', '矿体-model', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    // The id carries the stage; the title is a question until the author names
    // it, not a mixed slug presented as one.
    assert.equal(manifest.title, 'TODO: 矿体')
    const draft = await call(tools, 'capability_validate', {
      path: join(workspace, '.iax', 'workflows', '矿体-model'),
    })
    assert.equal(draft.value.ok, false)
    fillManifest(manifestPath, { title: '矿体' })
    const validated = await call(tools, 'capability_validate', {
      path: join(workspace, '.iax', 'workflows', '矿体-model'),
    })
    assert.equal(validated.value.ok, true, JSON.stringify(validated.value.findings))
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).title, '矿体')
  })

  test('an uppercase or underscore name gets a harness-valid skill name', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'Orebody_Model', workspace })
    const text = readFileSync(
      join(workspace, '.agents', 'skills', 'Orebody_Model', 'SKILL.md'), 'utf8')
    const name = text.match(/^name: "([^"]+)"/m)[1]
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.match(text, /Orebody_Model/)
  })

  test('a second scaffold is refused, and --force archives the old files', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const refused = await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    assert.equal(refused.value.ok, false)
    assert.match(refused.value.refused, /already exist/)

    const forced = await call(tools, 'capability_scaffold',
      { name: 'orebody', workspace, force: true })
    assert.equal(forced.value.created.length, 7)
    const versions = join(workspace, '.iax', 'workflows', 'orebody-model', 'versions')
    assert.ok(existsSync(versions), '--force did not archive the files it replaced')
    assert.ok(readdirSync(versions).length === 1)
    assert.ok(existsSync(join(versions, readdirSync(versions)[0], 'manifest.json')))
  })

  test('the template is rejected as a placeholder, as it must be', async () => {
    // The corrected self-test: the template must be CHECKABLE, and the answer
    // must be "not yet". A template that validated clean would freeze
    // "not known yet" into a contract.
    const validated = await call(mount(), 'capability_validate', {
      path: join(pluginRoot, 'capability-forge', 'templates'),
    })
    assert.equal(validated.value.ok, false)
    assert.ok(validated.value.findings.some((finding) => finding.id === 'manifest.placeholder'))
    assert.ok(validated.value.findings.some((finding) => finding.where === 'manifest.title'))
  })

  test('the spec templates carry the fields their schemas require', () => {
    // There is no JSON Schema validator dependency. The least a template can be
    // checked against is the schema's required list, so a template and its
    // schema cannot drift apart silently.
    for (const [templateName, schemaName] of [
      ['report-spec.default.json', 'report-spec.schema.json'],
      ['figure-spec.default.json', 'figure.schema.json'],
    ]) {
      const template = JSON.parse(readFileSync(join(
        pluginRoot, 'capability-forge', 'templates', templateName), 'utf8'))
      const schema = JSON.parse(readFileSync(join(
        pluginRoot, 'capability-forge', 'schemas', schemaName), 'utf8'))
      for (const field of schema.required) {
        assert.ok(field in template, `${templateName} is missing required field ${field}`)
      }
      assert.equal(template.schema, schema.$id)
    }
  })

  test('the workflow template runs only the steps it was asked for', () => {
    // The asset, driven directly: no bridge, no native build. A partial run must
    // say so in run.steps, refuse a missing prerequisite, and accept a resume
    // result as the stand-in for the skipped steps.
    const workspace = mkdtemp('forge-template-')
    const workflow = join(pluginRoot, 'capability-forge', 'templates', 'workflow.py')
    const input = join(workspace, 'input.txt')
    writeFileSync(input, 'sample input\n')
    const python = process.env.IAX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    // The template's manifest declares `mode` as a required enum. Supplying it
    // is the caller's job; the skeleton refuses to invent one.
    const run = (...args) => spawnSync(
      python, ['-X', 'utf8', workflow, '--input', input, '--mode', 'default', ...args],
      { encoding: 'utf8' })

    // A required input that is not supplied is a refusal naming it, not a
    // fabricated default -- including the enum, which used to fall back to
    // "default" even when the manifest's choices did not contain it.
    const missingMode = spawnSync(python, ['-X', 'utf8', workflow, '--input', input],
      { encoding: 'utf8' })
    assert.equal(missingMode.status, 1)
    assert.match(missingMode.stderr, /requires 'mode'/)

    const readOnly = run('--steps', 'read', '--out', join(workspace, 'read.json'))
    assert.equal(readOnly.status, 0, readOnly.stderr)
    const readResult = JSON.parse(readFileSync(join(workspace, 'read.json'), 'utf8'))
    assert.deepEqual(readResult.run.steps, {
      requested: ['read'], executed: ['read'], skipped: ['compute', 'summarize'],
    })
    assert.ok(readResult.facts.input_bytes > 0)
    assert.deepEqual(readResult.solids, [])
    assert.ok(readResult.warnings.some((warning) => /partial run/.test(warning)))

    const refused = run('--steps', 'summarize', '--out', join(workspace, 'bad.json'))
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /requires compute/)

    const full = run('--out', join(workspace, 'full.json'))
    assert.equal(full.status, 0, full.stderr)
    const fullResult = JSON.parse(readFileSync(join(workspace, 'full.json'), 'utf8'))
    assert.deepEqual(fullResult.run.steps, {
      requested: ['read', 'compute', 'summarize'],
      executed: ['read', 'compute', 'summarize'],
      skipped: [],
    })
    // The template's own result must carry every field its schema requires; a
    // skeleton that cannot produce a valid result is not a starting point.
    const resultSchema = JSON.parse(readFileSync(join(
      pluginRoot, 'capability-forge', 'schemas', 'result.schema.json'), 'utf8'))
    for (const field of resultSchema.required) {
      assert.ok(field in fullResult, `the template result is missing ${field}`)
    }
    assert.equal(fullResult.schema, resultSchema.$id)

    const summary = run('--steps', 'summarize', '--resume', join(workspace, 'full.json'),
      '--out', join(workspace, 'summary.json'))
    assert.equal(summary.status, 0, summary.stderr)
    const summaryResult = JSON.parse(readFileSync(join(workspace, 'summary.json'), 'utf8'))
    assert.deepEqual(summaryResult.run.steps, {
      requested: ['summarize'], executed: ['summarize'], skipped: ['read', 'compute'],
    })
    assert.equal(summaryResult.facts.input_bytes, fullResult.facts.input_bytes)
  })

  test('a stage workflow takes its input names from its manifest', async () => {
    // Ingest names its inputs source/format, not the template's input/mode. The
    // skeleton reads those names from the manifest, records them under the same
    // names in result.json, and refuses a missing enum instead of guessing.
    const workspace = mkdtemp('forge-stage-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', stages: ['ingest'], workspace })
    const workflow = join(workspace, '.iax', 'workflows', 'orebody-ingest', 'workflow.py')
    const input = join(workspace, 'upload.dim')
    writeFileSync(input, 'raw input\n')
    const out = join(workspace, 'result.json')
    const python = process.env.IAX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

    const full = spawnSync(python,
      ['-X', 'utf8', workflow, '--input', input, '--mode', 'auto', '--out', out],
      { encoding: 'utf8' })
    assert.equal(full.status, 0, full.stderr)
    const result = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(Object.keys(result.inputs), ['source'])
    assert.equal(result.parameters.format, 'auto')
    assert.equal(result.parameters.mode, undefined)
    assert.equal(result.inputs.source.sha256.length, 64)

    const missing = spawnSync(python, ['-X', 'utf8', workflow, '--input', input],
      { encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /requires 'format'/)
  })
})

describe('candidates', () => {
  test('a program that succeeded twice is proposed, with its latest products', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    const source = 'print("same")\n'
    recordedRun(workspace, source, 'run-20261101-120000-cand1',
      [{ path: 'out/a.bin', bytes: 3, sha256_16: 'aaa' }], true, '20261101-120000')
    recordedRun(workspace, source, 'run-20261101-130000-cand2',
      [{ path: 'out/b.bin', bytes: 4, sha256_16: 'bbb' }], true, '20261101-130000')
    recordedRun(workspace, 'print("other")\n', 'run-20261101-140000-cand3', [], true,
      '20261101-140000')
    recordedRun(workspace, source, 'run-20261101-150000-cand4', [], false, '20261101-150000')

    const { value } = await call(tools, 'capability_candidates', { workspace })
    assert.equal(value.scanned, 4)
    assert.equal(value.candidates.length, 2)
    const repeated = value.candidates.find((candidate) => candidate.successes === 2)
    assert.ok(repeated)
    assert.equal(repeated.latest_run, 'run-20261101-130000-cand2')
    assert.equal(repeated.artifacts.length, 1)
    assert.equal(repeated.artifacts[0].path, 'out/b.bin')
    assert.equal(repeated.recommended, true)
    assert.equal(repeated.needs_user_confirmation, true)
    assert.equal(repeated.source_lines, 1)
    assert.match(repeated.program_path, /run-20261101-130000-cand2\/program\.py$/)
    const single = value.candidates.find((candidate) => candidate.successes === 1)
    assert.equal(single.recommended, false)
    assert.ok(single.reasons.some((reason) => /only one successful run/.test(reason)))
    assert.match(value.note, /Proposals only/)
  })

  test('a source a workflow already froze is excluded unless includeFrozen is true', async () => {
    const workspace = mkdtemp('forge-')
    const source = 'print("frozen")\n'
    recordedRun(workspace, source, 'run-20261101-120000-frozen1')
    const digest = createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
    const directory = join(workspace, '.iax', 'workflows', 'orebody-model')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'workflow.py'), source)
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      workflow_version: 1, name: 'orebody-model', entry: 'workflow.py',
      source_sha256: digest, title: 't', answers: 'a',
      inputs: {}, steps: [], acceptance: [],
    }))
    const tools = mount({ workspace })
    let result = await call(tools, 'capability_candidates', { workspace })
    assert.deepEqual(result.value.candidates, [])
    result = await call(tools, 'capability_candidates', { workspace, includeFrozen: true })
    assert.equal(result.value.candidates.length, 1)
    assert.deepEqual(result.value.candidates[0].frozen_as, ['orebody-model'])
    assert.equal(result.value.candidates[0].recommended, false)
  })

  test('a draft workflow does not hide a candidate as already frozen', async () => {
    const workspace = mkdtemp('forge-')
    const source = 'print("draft")\n'
    recordedRun(workspace, source, 'run-20261101-120000-draft1')
    const digest = createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
    const directory = join(workspace, '.iax', 'workflows', 'orebody-model')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'workflow.py'), source)
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      workflow_version: 1, name: 'orebody-model', entry: 'workflow.py', status: 'draft',
      source_sha256: digest, title: 't', answers: 'a',
      inputs: {}, steps: [], acceptance: [],
    }))
    const { value } = await call(mount({ workspace }), 'capability_candidates', { workspace })
    assert.equal(value.candidates.length, 1)
    assert.deepEqual(value.candidates[0].frozen_as, [])
  })

  test('an empty workspace is an empty answer, not an error', async () => {
    const workspace = mkdtemp('forge-')
    const { value } = await call(mount({ workspace }), 'capability_candidates', { workspace })
    assert.deepEqual(value.candidates, [])
    assert.equal(value.scanned, 0)
  })
})

describe('validate', () => {
  test('a misspelt kind is one finding that names the controlled vocabulary', async () => {
    const workspace = mkdtemp('forge-')
    const directory = workflowAt(workspace, 'badkind', contract({
      inputs: { required: [{ name: 'x', kind: 'colour', means: 'm', refused_when: 'r' }] },
    }))
    const { value } = await call(mount(), 'capability_validate', { path: directory })
    assert.equal(value.ok, false)
    assert.deepEqual(value.findings.map((finding) => finding.id), ['inputs.kind'])
    assert.match(value.findings[0].message, /colour/)
  })

  test('enum without choices and misaligned acceptance are their own findings', async () => {
    const workspace = mkdtemp('forge-')
    const noChoices = workflowAt(workspace, 'nochoices', contract({
      inputs: { required: [{ name: 'x', kind: 'enum', means: 'm', refused_when: 'r' }] },
    }))
    let result = await call(mount(), 'capability_validate', { path: noChoices })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['inputs.enum'])

    const unaligned = workflowAt(workspace, 'unaligned',
      contract({ acceptance: ['one', 'two'] }))
    result = await call(mount(), 'capability_validate', { path: unaligned })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['acceptance.aligned'])
    assert.match(result.value.findings[0].message, /rule with no assertion/)
  })

  test('a schema that names no file, a program that does not compile, and a hash that moved', async () => {
    const workspace = mkdtemp('forge-')
    const missingSchema = workflowAt(workspace, 'schema',
      contract({ produces: { schema: 'iax.nope/1' } }))
    let result = await call(mount(), 'capability_validate', { path: missingSchema })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['consumes/produces.schema'])

    const broken = workflowAt(workspace, 'syntax', contract(), 'def run(:\n')
    result = await call(mount(), 'capability_validate', { path: broken })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['workflow.run'])

    const moved = workflowAt(workspace, 'moved',
      contract({ source_sha256: '0'.repeat(64) }))
    result = await call(mount(), 'capability_validate', { path: moved })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['workflow.sha'])
  })

  test('a P1 input that also carries suggested is a warning, and --strict makes it an error', async () => {
    const workspace = mkdtemp('forge-')
    const directory = workflowAt(workspace, 'inferred', contract({
      inputs: { required: [{
        name: 'x', kind: 'number', means: 'm', refused_when: 'r',
        suggested: 1, why_not_inferred: 'no default exists',
      }] },
    }))
    const tools = mount()
    const warning = await call(tools, 'capability_validate', { path: directory })
    assert.equal(warning.value.ok, true)
    assert.deepEqual(warning.value.findings.map((finding) => finding.id), ['inputs.inferred'])
    assert.equal(warning.value.findings[0].severity, 'warning')

    const strict = await call(tools, 'capability_validate', { path: directory, strict: true })
    assert.equal(strict.value.ok, false)
    assert.equal(strict.value.findings[0].severity, 'error')
  })

  test('the five core sections, version and requires_catalog each get their finding', async () => {
    const workspace = mkdtemp('forge-')
    const empty = workflowAt(workspace, 'core', {
      title: '', answers: '', inputs: { required: [] }, steps: [], acceptance: [],
    })
    let result = await call(mount(), 'capability_validate', { path: empty })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), [
      'manifest.title', 'manifest.answers', 'manifest.steps', 'manifest.acceptance',
    ])

    const version = workflowAt(workspace, 'version', contract({ version: '1.2' }))
    result = await call(mount(), 'capability_validate', { path: version })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['manifest.version'])

    const catalog = workflowAt(workspace, 'catalog', contract({ requires_catalog: 0 }))
    result = await call(mount(), 'capability_validate', { path: catalog })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['manifest.requires_catalog'])

    // Python's True IS an int; a boolean catalogue number is not a number.
    const booleanCatalog = workflowAt(workspace, 'boolcatalog',
      contract({ requires_catalog: true }))
    result = await call(mount(), 'capability_validate', { path: booleanCatalog })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['manifest.requires_catalog'])

    const status = workflowAt(workspace, 'status', contract({ status: 'published' }))
    result = await call(mount(), 'capability_validate', { path: status })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['manifest.status'])

    // null is not "absent": the field is present and is not the string the
    // bridge will insist on, so validate must reject it before freeze does.
    const nullStatus = workflowAt(workspace, 'nullstatus', contract({ status: null }))
    result = await call(mount(), 'capability_validate', { path: nullStatus })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['manifest.status'])
  })

  test('a selectable step contract is checked only when the manifest opts in', async () => {
    const workspace = mkdtemp('forge-')
    const optional = (steps, resumeKind = 'path') => ([
      { name: 'steps', kind: 'list', choices: steps, means: 'm' },
      { name: 'resume', kind: resumeKind, means: 'm' },
    ])
    const read = { id: 'read', n: 1, does: 'r', requires: [], produces: ['facts'] }
    const compute = { id: 'compute', n: 2, does: 'c', requires: ['read'], produces: ['solids'] }
    const selectable = (steps, choices, resumeKind) => contract({
      steps,
      inputs: { required: CONTRACT.inputs.required,
                optional: optional(choices, resumeKind) },
    })

    const valid = workflowAt(workspace, 'steps-ok', selectable([read, compute], ['read', 'compute']))
    let result = await call(mount(), 'capability_validate', { path: valid })
    assert.deepEqual(result.value.findings, [], JSON.stringify(result.value.findings))

    // A Chinese id is an address too; the label is the human short name.
    const han = workflowAt(workspace, 'steps-han', selectable([
      { ...read, id: '读取', label: '读取输入' },
      { ...compute, id: '计算', label: '计算', requires: ['读取'] },
    ], ['读取', '计算']))
    result = await call(mount(), 'capability_validate', { path: han })
    assert.deepEqual(result.value.findings, [], JSON.stringify(result.value.findings))

    const badLabel = workflowAt(workspace, 'steps-label',
      selectable([{ ...read, label: '' }, compute], ['read', 'compute']))
    result = await call(mount(), 'capability_validate', { path: badLabel })
    assert.ok(result.value.findings.some((finding) => finding.id === 'manifest.steps.label'))

    const badId = workflowAt(workspace, 'steps-badid',
      selectable([{ ...read, id: 'read.me' }, compute], ['read', 'compute']))
    result = await call(mount(), 'capability_validate', { path: badId })
    assert.ok(result.value.findings.some((finding) => finding.id === 'manifest.steps.id'))

    const badProduces = workflowAt(workspace, 'steps-produces',
      selectable([{ ...read, produces: 'facts' }, compute], ['read', 'compute']))
    result = await call(mount(), 'capability_validate', { path: badProduces })
    assert.ok(result.value.findings.some((finding) => finding.id === 'manifest.steps.produces'))

    // A manifest whose steps stay prose is a full-run capability, not an error.
    const prose = workflowAt(workspace, 'steps-prose', contract())
    result = await call(mount(), 'capability_validate', { path: prose })
    assert.deepEqual(result.value.findings, [])

    const duplicate = workflowAt(workspace, 'steps-duplicate',
      selectable([read, { ...compute, id: 'read', requires: [] }], ['read']))
    result = await call(mount(), 'capability_validate', { path: duplicate })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['manifest.steps.id'])

    const forward = workflowAt(workspace, 'steps-forward',
      selectable([{ ...read, requires: ['compute'] }, compute], ['read', 'compute']))
    result = await call(mount(), 'capability_validate', { path: forward })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['manifest.steps.requires'])

    const noProduce = workflowAt(workspace, 'steps-noproduce',
      selectable([{ ...read, produces: [] }, compute], ['read', 'compute']))
    result = await call(mount(), 'capability_validate', { path: noProduce })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['manifest.steps.requires'])
    assert.match(result.value.findings[0].message, /produces nothing/)

    const choices = workflowAt(workspace, 'steps-choices',
      selectable([read, compute], ['read']))
    result = await call(mount(), 'capability_validate', { path: choices })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['manifest.steps.selection'])

    const resume = workflowAt(workspace, 'steps-resume',
      selectable([read, compute], ['read', 'compute'], 'number'))
    result = await call(mount(), 'capability_validate', { path: resume })
    assert.deepEqual(result.value.findings.map((finding) => finding.id),
      ['manifest.steps.resume'])
  })

  test('deliverable, specs and the required input fields each get their finding', async () => {
    const workspace = mkdtemp('forge-')
    const deliverable = workflowAt(workspace, 'deliverable', contract({ deliverable: {} }))
    let result = await call(mount(), 'capability_validate', { path: deliverable })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['deliverable'])

    const specs = workflowAt(workspace, 'specs', contract({
      specs: { report: { default: 'missing.json' } },
    }))
    result = await call(mount(), 'capability_validate', { path: specs })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['specs.*.default'])

    const malformedSpec = workflowAt(workspace, 'specs-malformed', contract({
      specs: { report: [] },
    }))
    result = await call(mount(), 'capability_validate', { path: malformedSpec })
    assert.deepEqual(result.value.findings.map((finding) => finding.id), ['specs.*.default'])

    const inputs = workflowAt(workspace, 'inputs', contract({
      inputs: { required: [{ name: 'x', kind: 'path', means: 'm' }] },
    }))
    result = await call(mount(), 'capability_validate', { path: inputs })
    assert.ok(result.value.findings.some((finding) => finding.id === 'inputs.required'))
    assert.ok(result.value.findings.some((finding) => finding.where.endsWith('.refused_when')))
  })
})

describe('freeze', () => {
  test('a recorded run and a contract become one workflow and one lock', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    const source = 'def run(**kwargs):\n    return {"ok": True}\n'
    const run = recordedRun(workspace, source)
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: contract(), confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.equal(value.lock.schema, 'iax.capability.lock/1')
    // No version in this manifest, so the lock says null rather than inventing
    // one; the task's "no invented defaults" applies to version numbers too.
    assert.equal(value.lock.version, null)
    assert.equal(value.lock.frozen_from_run, run)
    assert.match(value.lock.source_sha256, /^[0-9a-f]{64}$/)
    assert.ok(value.lock.catalog === null || Number.isInteger(value.lock.catalog))
    assert.ok(existsSync(join(workspace, '.iax', 'specs', 'orebody-model.lock.json')))
    assert.match(readFileSync(join(workspace, '.iax', 'workflows', 'orebody-model',
      'workflow.py'), 'utf8'), /return \{"ok": True\}/)
  })

  test('an unconfirmed freeze is refused and writes nothing', async () => {
    const workspace = mkdtemp('forge-')
    const run = recordedRun(workspace, 'def run(**kwargs):\n    return {}\n')
    const { value } = await call(mount({ workspace }), 'capability_freeze', {
      name: 'orebody-model', run, manifest: contract(), confirmed: false, workspace,
    })
    assert.equal(value.ok, false)
    assert.match(value.refused, /confirmed/)
    assert.equal(existsSync(join(workspace, '.iax', 'workflows', 'orebody-model')), false)
  })

  test('a contract that does not hold is refused BEFORE the bridge is called', async () => {
    const workspace = mkdtemp('forge-')
    const run = recordedRun(workspace, 'def run(**kwargs):\n    return {}\n')
    const { value } = await call(mount({ workspace }), 'capability_freeze', {
      name: 'broken', run, workspace, confirmed: true,
      manifest: contract({ acceptance: ['one', 'two'] }),
    })
    assert.equal(value.ok, false)
    assert.ok(value.findings.some((finding) => finding.id === 'acceptance.aligned'))
    assert.equal(existsSync(join(workspace, '.iax', 'workflows', 'broken')), false,
      'the freeze wrote a workflow even though validation refused')
  })

  test('a placeholder manifest is refused before the bridge', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    const source = readFileSync(join(workflowDir, 'workflow.py'), 'utf8')
    const run = recordedRun(workspace, source)
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: manifestPath, confirmed: true, workspace,
    })
    assert.equal(value.ok, false)
    assert.ok(value.findings.some((finding) => finding.id === 'manifest.placeholder'))
    // The scaffold is still a draft and has no source hash: the bridge was never
    // reached, so nothing was frozen.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.status, 'draft')
    assert.equal(manifest.source_sha256, undefined)
    assert.equal(existsSync(join(workspace, '.iax', 'specs', 'orebody-model.lock.json')), false)
  })

  test('freeze resolves a relative manifest path against the workspace', async () => {
    // A relative manifest path is a workspace path, not the server's cwd. The
    // test process does not run inside the temporary workspace, so resolving
    // against the cwd would refuse (or read) the wrong file.
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    fillManifest(join(workflowDir, 'manifest.json'))
    const run = recordedRun(workspace, readFileSync(join(workflowDir, 'workflow.py'), 'utf8'))
    const relative = join('.iax', 'workflows', 'orebody-model', 'manifest.json')
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: relative, confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.equal(JSON.parse(readFileSync(join(workflowDir, 'manifest.json'), 'utf8')).status,
      'active')
  })

  test('a failed lock write leaves the capability a draft, not published', async () => {
    // The draft marker must survive the whole freeze: active is written only
    // after lock.json exists. A directory where the lock should be makes the
    // lock write fail; the frozen manifest must still say draft, so a
    // half-finished freeze can never be addressed by iam_workflow_run.
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    fillManifest(manifestPath)
    const source = readFileSync(join(workflowDir, 'workflow.py'), 'utf8')
    const run = recordedRun(workspace, source)
    mkdirSync(join(workspace, '.iax', 'specs', 'orebody-model.lock.json'), { recursive: true })
    await assert.rejects(
      () => call(tools, 'capability_freeze', {
        name: 'orebody-model', run, manifest: manifestPath, confirmed: true, workspace,
      }),
      /remains a draft/,
    )
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.status, 'draft')
    assert.ok(manifest.source_sha256)
  })

  test('freeze carries specs.default files into the frozen directory', async () => {
    // A spec default lives beside the manifest; the program comes from the run
    // record. The freeze must carry the spec file or the frozen manifest would
    // name a file that is not there.
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    const manifest = fillManifest(manifestPath)
    writeFileSync(join(workflowDir, 'report-spec.default.json'),
      JSON.stringify({ schema: 'iax.report-spec/1', version: 7 }))
    manifest.specs = { report: { default: 'report-spec.default.json' } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const run = recordedRun(workspace, readFileSync(join(workflowDir, 'workflow.py'), 'utf8'))
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: manifestPath, confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.ok(existsSync(join(workflowDir, 'report-spec.default.json')))
    const validated = await call(tools, 'capability_validate', { path: workflowDir })
    assert.equal(validated.value.ok, true, JSON.stringify(validated.value.findings))
    rmSync(join(workflowDir, 'report-spec.default.json'))
    const audit = await call(tools, 'capability_audit', { workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.specs'
      && finding.severity === 'error'))
  })

  test('a spec default may not overwrite the manifest, program or history', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    const manifest = fillManifest(manifestPath)
    manifest.specs = { report: { default: 'manifest.json' } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const run = recordedRun(workspace, readFileSync(join(workflowDir, 'workflow.py'), 'utf8'))
    await assert.rejects(
      () => call(tools, 'capability_freeze', {
        name: 'orebody-model', run, manifest: manifestPath, confirmed: true, workspace,
      }),
      /overwrite the frozen contract/,
    )

    const history = await mkdtemp('forge-')
    const historyTools = mount({ workspace: history })
    await call(historyTools, 'capability_scaffold', { name: 'orebody', workspace: history })
    const historyDir = join(history, '.iax', 'workflows', 'orebody-model')
    const historyManifestPath = join(historyDir, 'manifest.json')
    const historyManifest = fillManifest(historyManifestPath)
    mkdirSync(join(historyDir, 'versions'), { recursive: true })
    writeFileSync(join(historyDir, 'versions', 'spec.json'), '{}')
    historyManifest.specs = { report: { default: 'versions/spec.json' } }
    writeFileSync(historyManifestPath, JSON.stringify(historyManifest, null, 2))
    const historyRun = recordedRun(history,
      readFileSync(join(historyDir, 'workflow.py'), 'utf8'))
    await assert.rejects(
      () => call(historyTools, 'capability_freeze', {
        name: 'orebody-model', run: historyRun, manifest: historyManifestPath,
        confirmed: true, workspace: history,
      }),
      /reserved for frozen history/,
    )
  })

  test('an unreadable spec is named, not silently dropped from the lock', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    fillManifest(join(workflowDir, 'manifest.json'))
    const run = recordedRun(workspace, readFileSync(join(workflowDir, 'workflow.py'), 'utf8'))
    writeFileSync(join(workspace, '.iax', 'specs', 'orebody.report.json'), '{ not json')
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: join(workflowDir, 'manifest.json'),
      confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.ok(value.lock.specs_error.some((path) => path.includes('orebody.report.json')))
    assert.match(value.note, /spec files/)
    assert.equal(value.lock.specs.report, undefined)
    const audit = await call(tools, 'capability_audit', { workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.specs'
      && finding.message.includes('orebody.report.json')))
  })

  test('freeze writes a capability-specific usage skill', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    fillManifest(join(workflowDir, 'manifest.json'))
    const run = recordedRun(workspace, readFileSync(join(workflowDir, 'workflow.py'), 'utf8'))
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: join(workflowDir, 'manifest.json'),
      confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.equal(value.skill.written, true)
    assert.equal(value.skill.path, '.agents/skills/orebody-model/SKILL.md')
    const text = readFileSync(join(workspace, value.skill.path), 'utf8')
    assert.match(text, /^---\nname: "orebody-model"/)
    assert.match(text, /generated_by: "iam-capability-forge"/)
    assert.match(text, /iam_workflow_run/)
    for (const heading of ['## 调用 / How to run', '## 输入 / Inputs', '## 步骤 / Steps',
      '## 结果 / Result', '## 归因 / Provenance']) {
      assert.ok(text.includes(heading), `the skill is missing ${heading}`)
    }
    // The manifest's human text keeps its own language (the fill helper writes
    // English); the structure carries both languages.
    assert.ok(text.includes('filled title'))
    assert.ok(text.includes('filled answers'))
    for (const fragment of ['`input`', '`mode`', '`read`', '`compute`', '`summarize`',
      'result.json', '0.1.0']) {
      assert.ok(text.includes(fragment), `the skill is missing ${fragment}`)
    }
    // Acceptance thresholds belong to the manifest, not to the skill.
    assert.equal(text.includes('filled acceptance'), false)
    rmSync(join(workspace, value.skill.path))
    const audit = await call(tools, 'capability_audit', { workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.skill'
      && finding.severity === 'warning'))
  })

  test('an existing user-authored capability skill is not overwritten', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    fillManifest(join(workflowDir, 'manifest.json'))
    const skillDir = join(workspace, '.agents', 'skills', 'orebody-model')
    mkdirSync(skillDir, { recursive: true })
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(skillPath, '---\nname: mine-skill\n---\n\nMY SKILL\n')
    const run = recordedRun(workspace, readFileSync(join(workflowDir, 'workflow.py'), 'utf8'))
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: join(workflowDir, 'manifest.json'),
      confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.equal(value.skill.written, false)
    assert.match(value.skill.reason, /not generated by the forge/)
    assert.equal(readFileSync(skillPath, 'utf8'), '---\nname: mine-skill\n---\n\nMY SKILL\n')
    const audit = await call(tools, 'capability_audit', { workspace })
    assert.equal(audit.value.findings.some((finding) => finding.id === 'audit.skill'), false)
  })

  test('a generated usage skill is refreshed by a versioned freeze', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    fillManifest(manifestPath)
    const source = readFileSync(join(workflowDir, 'workflow.py'), 'utf8')
    const firstRun = recordedRun(workspace, source, 'run-20261101-120000-skill1')
    await call(tools, 'capability_freeze', {
      name: 'orebody-model', run: firstRun, manifest: manifestPath,
      confirmed: true, workspace,
    })
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = '0.2.0'
    const nextManifest = join(workspace, 'next-manifest.json')
    writeFileSync(nextManifest, JSON.stringify(manifest, null, 2))
    const secondRun = recordedRun(workspace, source, 'run-20261101-130000-skill2')
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run: secondRun, manifest: nextManifest,
      confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.equal(value.skill.written, true)
    const text = readFileSync(join(workspace, value.skill.path), 'utf8')
    assert.match(text, /capability_version: "0.2.0"/)
    assert.ok(text.includes('version: `0.2.0`'))
  })

  test('a Chinese capability freezes through the bridge and keeps its specs', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: '矿体', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', '矿体-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    fillManifest(manifestPath)
    const source = readFileSync(join(workflowDir, 'workflow.py'), 'utf8')
    const run = recordedRun(workspace, source)
    const { value } = await call(tools, 'capability_freeze', {
      name: '矿体-model', run, manifest: manifestPath, confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.deepEqual(value.lock.specs, { report: 1, figure: 1 })
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).status, 'active')
    assert.ok(existsSync(join(workspace, '.iax', 'specs', '矿体-model.lock.json')))
    const skill = readFileSync(
      join(workspace, '.agents', 'skills', '矿体-model', 'SKILL.md'), 'utf8')
    const skillName = skill.match(/^name: "([^"]+)"/m)[1]
    assert.match(skillName, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(skill.includes('矿体-model'))
    assert.ok(skill.includes('## 输入 / Inputs'))
    assert.ok(skill.includes('## 结果 / Result'))
    const audit = await call(tools, 'capability_audit', { workspace })
    const entry = audit.value.capabilities.find((candidate) => candidate.name === '矿体-model')
    assert.equal(entry.findings, 0)
  })

  test('freezing a scaffold archives the draft instead of mistaking it for history', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const manifestPath = join(workspace, '.iax', 'workflows', 'orebody-model', 'manifest.json')
    fillManifest(manifestPath)
    const source = readFileSync(join(workspace, '.iax', 'workflows', 'orebody-model',
      'workflow.py'), 'utf8')
    const run = recordedRun(workspace, source)
    const { value } = await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: manifestPath, confirmed: true, workspace,
    })
    assert.equal(value.frozen, true)
    assert.equal(value.replaced_scaffold, true)
    assert.deepEqual(value.lock.specs, { report: 1, figure: 1 })
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).status, 'active')
    assert.ok(existsSync(join(workspace, '.iax', 'workflows', 'orebody-model', 'versions')))

    const audit = await call(tools, 'capability_audit', { workspace })
    const entry = audit.value.capabilities.find((candidate) => candidate.name === 'orebody-model')
    assert.equal(entry.lock.schema, 'iax.capability.lock/1')
    assert.equal(entry.findings, 0)
  })
})

describe('the draft lifecycle', () => {
  test('a scaffold is draft, refused by run, and active after freeze', async () => {
    const workspace = mkdtemp('forge-')
    const forgeTools = mount({ workspace })
    await call(forgeTools, 'capability_scaffold', { name: 'orebody', workspace })
    const workflowDir = join(workspace, '.iax', 'workflows', 'orebody-model')
    const manifestPath = join(workflowDir, 'manifest.json')
    fillManifest(manifestPath)
    const input = join(workspace, 'input.txt')
    writeFileSync(input, 'sample input\n')

    const bridgeTools = mountBridge(workspace)
    const draft = await call(bridgeTools, 'iam_workflow_run', {
      name: 'orebody-model', workspace, arguments: { input, mode: 'default' },
    })
    assert.equal(draft.value.ok, false)
    assert.match(draft.value.refused, /draft/)
    assert.match(draft.value.refused, /freeze/)

    const listed = await call(bridgeTools, 'iam_workflow_list', { workspace })
    const entry = listed.value.workflows.find((workflow) => workflow.name === 'orebody-model')
    assert.equal(entry.status, 'draft')

    const source = readFileSync(join(workflowDir, 'workflow.py'), 'utf8')
    const runId = recordedRun(workspace, source)
    const frozen = await call(forgeTools, 'capability_freeze', {
      name: 'orebody-model', run: runId, manifest: manifestPath,
      confirmed: true, workspace,
    })
    assert.equal(frozen.value.frozen, true)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).status, 'active')

    const ran = await call(bridgeTools, 'iam_workflow_run', {
      name: 'orebody-model', workspace, arguments: { input, mode: 'default' },
    })
    assert.equal(ran.value.ok, true, JSON.stringify(ran.value).slice(0, 400))
    assert.deepEqual(ran.value.report.run.steps.requested,
      ['read', 'compute', 'summarize'])

    // The scaffolded path input carries why_not_inferred, so a missing file is
    // asked for before the workflow starts rather than discovered as a crash.
    const asked = await call(bridgeTools, 'iam_workflow_run', {
      name: 'orebody-model', workspace, arguments: { mode: 'default' },
    })
    assert.equal(asked.value.ok, false)
    assert.equal(asked.value.needs_input, true)
    assert.ok(asked.value.questions.some((question) => question.parameter === 'input'))
  })
})

describe('audit', () => {
  async function frozenCapability(manifest = contract()) {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    const source = 'def run(**kwargs):\n    return {}\n'
    const run = recordedRun(workspace, source)
    await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest, confirmed: true, workspace,
    })
    return { workspace, tools, source }
  }

  test('an empty workspace is an empty answer, not an error', async () => {
    const workspace = mkdtemp('forge-')
    const { value } = await call(mount({ workspace }), 'capability_audit', { workspace })
    assert.deepEqual(value.capabilities, [])
    assert.deepEqual(value.findings, [])
  })

  test('an empty workspace is still empty when the catalog cannot be read', () => {
    // No capability means there was no catalog check to skip; a warning about
    // the platform would make "nothing here" read like a finding.
    const workspace = mkdtemp('forge-')
    const emptyPackage = mkdtemp('forge-empty-package-')
    const python = process.env.IAX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const outcome = spawnSync(python, [
      '-X', 'utf8', join(pluginRoot, 'capability-forge', 'python', 'capability.py'),
      'audit', '--workspace', workspace,
    ], {
      encoding: 'utf8',
      env: { ...process.env, IAM_PYTHON_PACKAGE_DIR: emptyPackage },
    })
    assert.equal(outcome.status, 0, outcome.stderr)
    const value = JSON.parse(outcome.stdout)
    assert.deepEqual(value.capabilities, [])
    assert.deepEqual(value.findings, [])
  })

  test('a parked .draft directory is not audited as a capability', async () => {
    const workspace = mkdtemp('forge-')
    const parked = join(workspace, '.iax', 'workflows', '.draft-ghost-20260101-000000')
    mkdirSync(parked, { recursive: true })
    writeFileSync(join(parked, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
    writeFileSync(join(parked, 'manifest.json'), JSON.stringify(contract()))
    const { value } = await call(mount({ workspace }), 'capability_audit', { workspace })
    assert.deepEqual(value.capabilities, [])
    assert.deepEqual(value.findings, [])
  })

  test('a missing lock is a warning, and a corrupt lock is an error', async () => {
    // The lock is the record of what the capability was frozen with. Missing is
    // visible but not fatal; unreadable is an error, not a silent skip.
    const missing = await frozenCapability()
    const lock = join(missing.workspace, '.iax', 'specs', 'orebody-model.lock.json')
    rmSync(lock)
    const without = await call(missing.tools, 'capability_audit', { workspace: missing.workspace })
    const missingFinding = without.value.findings.find((finding) => finding.id === 'audit.lock')
    assert.ok(missingFinding)
    assert.equal(missingFinding.severity, 'warning')

    const corrupt = await frozenCapability()
    const corruptLock = join(corrupt.workspace, '.iax', 'specs', 'orebody-model.lock.json')
    writeFileSync(corruptLock, '{ not json')
    const broken = await call(corrupt.tools, 'capability_audit', { workspace: corrupt.workspace })
    const corruptFinding = broken.value.findings.find((finding) => finding.id === 'audit.lock')
    assert.ok(corruptFinding)
    assert.equal(corruptFinding.severity, 'error')

    const malformed = await frozenCapability()
    const malformedLock = join(malformed.workspace, '.iax', 'specs', 'orebody-model.lock.json')
    const malformedDocument = JSON.parse(readFileSync(malformedLock, 'utf8'))
    malformedDocument.specs = []
    writeFileSync(malformedLock, JSON.stringify(malformedDocument))
    const typed = await call(malformed.tools, 'capability_audit', { workspace: malformed.workspace })
    assert.ok(typed.value.findings.some((finding) => finding.id === 'audit.lock'
      && finding.severity === 'error'))
  })

  test('a program edited after its freeze is an error', async () => {
    const { workspace, tools } = await frozenCapability()
    writeFileSync(join(workspace, '.iax', 'workflows', 'orebody-model', 'workflow.py'),
      'def run(**kwargs):\n    return {"tampered": True}\n')
    const { value } = await call(tools, 'capability_audit', { workspace })
    const sources = value.findings.filter((finding) => finding.id === 'audit.source')
    assert.equal(sources.length, 1)
    assert.equal(sources[0].severity, 'error')
  })

  test('a frozen manifest whose program is missing or unlocatable is an error', async () => {
    const missing = await frozenCapability()
    rmSync(join(missing.workspace, '.iax', 'workflows', 'orebody-model', 'workflow.py'))
    let audit = await call(missing.tools, 'capability_audit', { workspace: missing.workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.source'
      && finding.severity === 'error'))

    const badEntry = await frozenCapability()
    const manifestPath = join(badEntry.workspace, '.iax', 'workflows', 'orebody-model',
      'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.entry = null
    writeFileSync(manifestPath, JSON.stringify(manifest))
    audit = await call(badEntry.tools, 'capability_audit', { workspace: badEntry.workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.manifest'
      && finding.severity === 'error'))
  })

  test('an artifact named by a result but missing from disk is an error', async () => {
    const { workspace, tools } = await frozenCapability()
    const directory = join(workspace, 'out', 'orebody-model', 'run-probe')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'model.bin'), 'bytes')
    writeFileSync(join(directory, 'result.json'), JSON.stringify({
      schema: 'iax.capability.result/1', capability: 'orebody-model', version: '0.1.0',
      artifacts: [{
        role: 'model', path: 'model.bin', bytes: 5,
        sha256: createHash('sha256').update('bytes').digest('hex'),
      }],
    }))
    let audit = await call(tools, 'capability_audit', { workspace })
    assert.equal(audit.value.findings.filter((finding) => finding.id === 'audit.artifact').length, 0)
    // The hash is what catches a file that was replaced rather than removed.
    writeFileSync(join(directory, 'model.bin'), 'other')
    audit = await call(tools, 'capability_audit', { workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.artifact'))
  })

  test('a manifest whose version moved after the freeze is a warning', async () => {
    const { workspace, tools } = await frozenCapability(contract({ version: '1.0.0' }))
    const manifestPath = join(workspace, '.iax', 'workflows', 'orebody-model', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = '2.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const { value } = await call(tools, 'capability_audit', { workspace })
    const finding = value.findings.find((candidate) => candidate.id === 'audit.version')
    assert.ok(finding)
    assert.equal(finding.severity, 'warning')
  })

  test('a figure whose source hash moved is an error', async () => {
    const { workspace, tools } = await frozenCapability()
    const directory = join(workspace, 'out', 'orebody-model', 'run-probe')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'model.bin'), 'bytes')
    writeFileSync(join(directory, 'figures.json'), JSON.stringify({
      figures: [{
        id: 'fig-model', caption: 'x', kind: 'model-view',
        source: { artifact: 'model.bin',
                  sha256: createHash('sha256').update('bytes').digest('hex') },
      }],
    }))
    let audit = await call(tools, 'capability_audit', { workspace })
    assert.equal(audit.value.findings.filter((finding) => finding.id === 'audit.figure').length, 0)
    writeFileSync(join(directory, 'model.bin'), 'other')
    audit = await call(tools, 'capability_audit', { workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.figure'
      && finding.severity === 'error'))
  })

  test('a figure may name its source by artifact role', async () => {
    // §7.4: source.artifact points into result.json.artifacts, not at a bare
    // filename. The role is resolved against the run's result.json.
    const { workspace, tools } = await frozenCapability()
    const directory = join(workspace, 'out', 'orebody-model', 'run-role')
    mkdirSync(directory, { recursive: true })
    const digest = createHash('sha256').update('bytes').digest('hex')
    writeFileSync(join(directory, 'model.bin'), 'bytes')
    writeFileSync(join(directory, 'result.json'), JSON.stringify({
      schema: 'iax.capability.result/1', capability: 'orebody-model',
      artifacts: [{ role: 'model', path: 'model.bin', bytes: 5, sha256: digest }],
    }))
    writeFileSync(join(directory, 'figures.json'), JSON.stringify({
      figures: [{
        id: 'fig-role', caption: 'x', kind: 'model-view',
        source: { artifact: 'model', sha256: digest },
      }],
    }))
    let audit = await call(tools, 'capability_audit', { workspace })
    assert.equal(audit.value.findings.filter((finding) => finding.id === 'audit.figure').length, 0)
    writeFileSync(join(directory, 'model.bin'), 'other')
    audit = await call(tools, 'capability_audit', { workspace })
    assert.ok(audit.value.findings.some((finding) => finding.id === 'audit.figure'
      && finding.severity === 'error'))
  })

  test('a lock behind the catalog is a warning, not an error', async () => {
    const { workspace, tools } = await frozenCapability()
    const lockPath = join(workspace, '.iax', 'specs', 'orebody-model.lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.catalog = 1
    writeFileSync(lockPath, JSON.stringify(lock))
    const { value } = await call(tools, 'capability_audit', { workspace })
    const finding = value.findings.find((candidate) => candidate.id === 'audit.catalog')
    assert.ok(finding)
    assert.equal(finding.severity, 'warning')
  })

  test('a missing spec and an unregistered manual figure are warnings', async () => {
    const workspace = mkdtemp('forge-')
    const tools = mount({ workspace })
    await call(tools, 'capability_scaffold', { name: 'orebody', workspace })
    const manifestPath = join(workspace, '.iax', 'workflows', 'orebody-model', 'manifest.json')
    fillManifest(manifestPath)
    const source = readFileSync(join(workspace, '.iax', 'workflows', 'orebody-model',
      'workflow.py'), 'utf8')
    const run = recordedRun(workspace, source)
    await call(tools, 'capability_freeze', {
      name: 'orebody-model', run, manifest: manifestPath, confirmed: true, workspace,
    })
    // Removing a spec the lock recorded must be visible.
    const specPath = join(workspace, '.iax', 'specs', 'orebody.report.json')
    assert.ok(existsSync(specPath))
    writeFileSync(specPath, JSON.stringify({ schema: 'iax.report-spec/1', version: 2 }))

    const directory = join(workspace, 'out', 'orebody-model', 'run-probe')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'figures.json'), JSON.stringify({
      figures: [{ id: 'fig-manual', caption: 'x', kind: 'manual' }],
    }))
    const { value } = await call(tools, 'capability_audit', { workspace })
    assert.ok(value.findings.some((finding) => finding.id === 'audit.specs'
      && finding.severity === 'warning'))
    assert.ok(value.findings.some((finding) => finding.id === 'audit.manual'
      && finding.severity === 'warning'))
  })
})

describe('the workspace seam', () => {
  test('the session directory is used when the call names none', async () => {
    const workspace = mkdtemp('forge-session-')
    const tools = mount({}, { ensure: async (agent) => workspace })
    const { value } = await call(tools, 'capability_audit', {}, { session: 'an-agent' })
    assert.deepEqual(value.capabilities, [])
  })
})
