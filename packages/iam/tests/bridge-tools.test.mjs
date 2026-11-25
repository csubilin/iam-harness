import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { cleanup, fakeTools, loadToolHost, mkdtemp, pluginRoot } from './helpers.mjs'

after(cleanup)

// The generated Python package comes from the platform build, which lives
// outside this checkout; the packaging tests skip until it is staged.
const NATIVE_PLATFORM = { win32: 'win-native', linux: 'linux-native', darwin: 'macos-native' }[process.platform]
const GENERATED_PYTHON_PACKAGE = process.env.IAM_PYTHON_PACKAGE_DIR
  ?? join(process.env.IAX_PLATFORM_ROOT ?? join(pluginRoot, '..', '..'), 'build', 'CMakePlatforms', NATIVE_PLATFORM, 'python-package')
const HAS_GENERATED_PYTHON_PACKAGE = existsSync(join(GENERATED_PYTHON_PACKAGE, 'iam_algorithms', '__init__.py'))

const bridge = await loadToolHost('algorithm-bridge')
const { name, inject, apply } = bridge.index

/**
 * Mount the plugin the way a profile does and hand back its tool table.
 *
 * `workingDirectory` is offered only when a test asks for it, because the
 * plugin treats that service as optional -- a composition without it must still
 * load, and `mount()` with no argument is how that composition is exercised.
 */
function mount(config = {}, workingDirectory) {
  const tools = fakeTools()
  const ctx = {
    tools,
    effect: (fn) => fn(),
    inject: (deps, fn) =>
      fn(workingDirectory === undefined ? {} : { workingDirectory }),
  }
  apply(ctx, { allowUnsafeExecution: true, ...config })
  return tools
}

/** An `exec` as the Harness hands one to a tool. */
function exec(agent) {
  return { signal: new AbortController().signal, agent }
}

/** The bridge's program files that are sitting in the temp directory right now. */
function programFiles() {
  return readdirSync(tmpdir()).filter((entry) => /^iam-program-.*\.py$/.test(entry)).sort()
}

/**
 * A workflow in a temp workspace, whose `run()` writes a marker before refusing.
 *
 * The marker is the stub the asking tests assert on: a workflow the platform
 * has to ask about must not be started at all, and "it did not run" is only
 * observable through something the run would have written. The refusal is a
 * WorkflowError rather than a crash, so a test can also show the old route --
 * the workflow deciding for itself -- still produces a value.
 */
function writeWorkflow(workspace, name, required, marker) {
  const directory = join(workspace, '.iax', 'workflows', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    workflow_version: 1, name, entry: 'workflow.py', title: name, answers: 'a test workflow',
    inputs: { required }, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'],
  }))
  writeFileSync(join(directory, 'workflow.py'), [
    'from pathlib import Path',
    'class WorkflowError(RuntimeError):',
    '    pass',
    'def run(**kwargs):',
    `    Path(${JSON.stringify(marker)}).write_text('ran')`,
    "    raise WorkflowError('the workflow itself refused')",
  ].join('\n'))
}

const PROJECT = 'D:/dev/MiningFlatform/workspace/test1.iam'
const PLATFORM = existsSync(PROJECT)
const SKIP = 'needs the built platform and D:/dev/MiningFlatform/workspace/test1.iam'

/**
 * Call a tool the way the harness does: `execute` yields a VALUE, and the
 * definition's own `render` turns it into the text blocks a card shows.
 *
 * Driving both halves rather than only `execute` is the point -- the failure
 * this replaced was `Error: content.some is not a function`, which came from
 * `execute` returning MCP's `{ content, isError }` envelope where the contract
 * wants the value itself. A test that read `result.content[0].text` directly
 * would have encoded the bug instead of catching it.
 */
async function call(tools, toolName, args, agent) {
  const definition = tools.registered.get(toolName)
  assert.ok(definition, `${toolName} is not registered`)
  const value = await definition.execute(args, exec(agent))
  assert.ok(value !== null && typeof value === 'object', `${toolName} must return an object value`)
  assert.equal(value.content, undefined,
    `${toolName} returned a content envelope; this contract renders via output.render`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} rendered nothing`)
  return { value, json: value, text: blocks[0].text }
}

describe('the plugin as a bundle', () => {
  test('exports the three things a bundle module must', () => {
    assert.equal(name, 'iam-algorithm-bridge')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof apply, 'function')
  })

  test('registers eight tools, and every name is distinct', () => {
    const tools = mount()
    assert.deepEqual([...tools.registered.keys()].sort(), [
      'iam_algorithm_describe',
      'iam_algorithm_run',
      'iam_algorithm_search',
      'iam_mine_describe',
      'iam_program_run',
      'iam_workflow_freeze',
      'iam_workflow_list',
      'iam_workflow_run',
    ])
  })

  test('every tool declares parameters and an output renderer', () => {
    for (const [toolName, definition] of mount().registered) {
      assert.equal(typeof definition.description, 'string', `${toolName} has no description`)
      assert.equal(definition.parameters.type, 'object', `${toolName} has no parameter schema`)
      assert.equal(typeof definition.output.render, 'function', `${toolName} cannot render a result`)
    }
  })
})

describe('the tools that only read the catalog', () => {
  test('mine_describe pages project features', { skip: PLATFORM ? false : SKIP }, async () => {
    const { json } = await call(mount(), 'iam_mine_describe', { project: PROJECT, offset: 0, limit: 1 })
    assert.equal(json.features.length, 1)
    assert.ok(json.feature_count > 1)
    assert.equal(json.next_offset, 1)
  })

  test('mine_describe names each column\'s field, so a choice can be offered', { skip: PLATFORM ? false : SKIP }, async () => {
    // This is what makes asking possible: a user cannot answer "which column is
    // the grade?" against a list of ids like `merge-2-dimine-cell-1`. The field
    // is where the name lives, and the reference model declares unit='1' for
    // every one of them -- so the names are the whole of what can be offered.
    const { json } = await call(mount(), 'iam_mine_describe', { project: PROJECT })
    const columns = json.block_models[0].columns
    assert.ok(columns.length >= 5)
    for (const column of columns) {
      assert.equal(typeof column.field_name, 'string')
      assert.equal(typeof column.field_unit, 'string')
      assert.equal(typeof column.value_type, 'string')
      assert.equal(typeof column.numeric, 'boolean')
    }
    assert.ok(columns.some((column) => column.field_name === 'CU'), 'the grade column is named')
    // And the project is on record as not saying what the numbers mean, so a
    // caller does not go looking for a field it will not find.
    assert.match(json.field_names_are_not_semantics, /ASK/)
  })

  test('search groups by operation family and stays short', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_algorithm_search', { query: 'boolean', backend: 'iam' })
    // Every word of the query is matched against the WHOLE entry, so a family
    // whose summary mentions booleans comes back too -- which is why the
    // assertion is on the family that was asked about rather than on the total.
    const family = json.families.find((candidate) => candidate.operation === 'geometry.boolean')
    assert.ok(family, 'the boolean family is among the results')
    assert.deepEqual(family.entries.map((entry) => entry.variant).sort(),
      ['difference', 'intersection', 'union'])
    for (const candidate of json.families) {
      for (const entry of candidate.entries) {
        // Short means short: a search result carries no preconditions, no limits
        // and no schema, because sixteen of those is a context problem. The
        // `brief` is the deliberate exception -- one sentence, which is what
        // turns "is there anything here for this problem" into a question the
        // search itself can answer.
        assert.deepEqual(Object.keys(entry).sort(),
          ['backend', 'brief', 'call_kind', 'execution', 'id', 'provenance',
            'python_direct', 'python_return', 'route', 'select', 'title', 'variant'])
        if (entry.call_kind === 'direct') {
          assert.ok(entry.python_direct)
        } else {
          assert.equal(entry.call_kind, 'invoke')
          assert.equal(entry.python_direct, null)
        }
      }
    }
  })

  test('search matches words, not a contiguous phrase', { skip: PLATFORM ? false : SKIP }, async () => {
    // The old rule was one substring test over the entry's JSON, so a phrase
    // that read naturally found nothing: `interpolate contours` returned none.
    const tools = mount()
    const { json } = await call(tools, 'iam_algorithm_search',
      { query: 'interpolate contours', backend: 'iam' })
    const ids = json.families.flatMap((family) => family.entries.map((entry) => entry.id))
    assert.ok(ids.includes('geometry.section.interpolate_contours'), 'both words find the entry')
    // A full id names one entry above everything else that mentions its words.
    const exact = await call(tools, 'iam_algorithm_search',
      { query: 'geometry.section.interpolate_contours' })
    assert.equal(exact.json.families[0].entries[0].id, 'geometry.section.interpolate_contours')
    // And a word that is nowhere is an empty answer rather than an approximation.
    const absent = await call(tools, 'iam_algorithm_search', { query: 'zzzznotanalgorithm' })
    assert.equal(absent.json.entry_count, 0)
  })

  test('a Chinese question reaches the entry it names', { skip: PLATFORM ? false : SKIP }, async () => {
    // Every declaration carries a one-line Chinese route beside its English
    // contract. That phrase is what lets a user's words reach an English entry,
    // and it is returned so a hit can be confirmed without the full contract.
    const tools = mount()
    const cases = [
      ['体积', ['block_model.volume', 'surface.volume', 'geometry.mesh.surface.volume']],
      ['布尔', ['geometry.boolean.union', 'geometry.boolean.intersection',
                'geometry.boolean.difference', 'geometry.polygon.boolean']],
      ['块段模型', ['block_model.volume', 'mine.block_model.plane_cut']],
      ['品位', ['block_model.metal', 'geostat.idw.estimate', 'geostat.kriging.estimate']],
      ['巷道', ['network.length', 'mine.polyline.station_frame']],
      ['变差函数', ['geostat.variogram.cloud', 'geostat.variogram.fit_spherical']],
    ]
    for (const [query, expected] of cases) {
      const { json } = await call(tools, 'iam_algorithm_search', { query })
      const ids = json.families.flatMap((family) => family.entries.map((entry) => entry.id))
      for (const id of expected) assert.ok(ids.includes(id), `${query} must reach ${id}`)
      for (const family of json.families) {
        for (const entry of family.entries) assert.equal(typeof entry.route, 'string')
      }
    }
  })

  test('selection claims travel beside the entry, and unknown stays unknown', { skip: PLATFORM ? false : SKIP }, async () => {
    // The fields are one word each and the choice is made here, so they belong
    // in the search result rather than one describe call per candidate.
    const tools = mount()
    const boolean = await call(tools, 'iam_algorithm_search', { operation: 'geometry.boolean' })
    const union = boolean.json.families[0].entries
      .find((entry) => entry.id === 'geometry.boolean.union')
    assert.deepEqual(union.select, { exact: 'false', fails_silently: 'false' })
    const sampled = await call(tools, 'iam_algorithm_search', { query: 'geometry.mesh.implicit_difference' })
    assert.deepEqual(sampled.json.families[0].entries[0].select,
      { exact: 'false', fails_silently: 'true' })
    // An entry nobody has established says so rather than claiming the safe answer.
    const unknown = await call(tools, 'iam_algorithm_search', { query: 'geometry.point.distance' })
    assert.deepEqual(unknown.json.families[0].entries[0].select,
      { exact: 'unknown', fails_silently: 'unknown' })
  })

  test('an empty search is the operation index, not the whole catalog', { skip: PLATFORM ? false : SKIP }, async () => {
    const { json } = await call(mount(), 'iam_algorithm_search', {})
    // One row per family: the cheap answer to "what exists here". Listing every
    // entry instead is about 68 KB of context for a question the caller has not
    // asked yet.
    assert.equal(json.families, undefined, 'the index carries no entries')
    assert.ok(Array.isArray(json.operations))
    assert.ok(json.operation_count > 100, 'the platform covers more than a hundred families')
    assert.equal(json.operations.length, json.operation_count)
    let entries = 0
    for (const row of json.operations) {
      assert.equal(typeof row.operation, 'string')
      assert.ok(row.entry_count >= 1, `${row.operation} claims no entries`)
      assert.ok(Array.isArray(row.backends) && row.backends.length >= 1)
      entries += row.entry_count
    }
    assert.equal(entries, json.entry_count)
    // The backend filter narrows the index as well as an entry search.
    const iam = await call(mount(), 'iam_algorithm_search', { backend: 'iam' })
    assert.ok(iam.json.operations.length > 0)
    assert.ok(iam.json.operations.every((row) => row.backends.every((backend) => backend === 'iam')))
    // And one family can then be listed exactly, which is what the index is for.
    const family = await call(mount(), 'iam_algorithm_search', { operation: 'geometry.boolean' })
    assert.deepEqual(family.json.families.map((candidate) => candidate.operation),
      ['geometry.boolean'])
    assert.deepEqual(family.json.families[0].entries.map((entry) => entry.variant).sort(),
      ['difference', 'intersection', 'union'])
    // A family name that is not there says how to find the right one.
    const missing = await call(mount(), 'iam_algorithm_search', { operation: 'nope.nothing' })
    assert.equal(missing.json.entry_count, 0)
    assert.match(missing.json.hint, /family index/)
  })

  test('every brief is one line of what the algorithm does', { skip: PLATFORM ? false : SKIP }, async () => {
    // `*` is the explicit whole-catalog request; the index is what an omitted
    // query returns now, and it is tested above.
    const { json } = await call(mount(), 'iam_algorithm_search', { operation: '*' })
    // Built-ins only: a workspace algorithm is the user's own manifest, and
    // whether it carries a summary is theirs to decide.
    const entries = json.families.flatMap((family) => family.entries)
      .filter((entry) => entry.provenance === 'builtin')
    assert.ok(entries.length > 100, 'operation "*" is the whole catalog')
    for (const entry of entries) {
      // A brief is a sentence, so it ends like one -- and it is bounded, so a
      // family of sixteen is still a result and not a context problem.
      assert.ok(typeof entry.brief === 'string' && entry.brief.length > 0,
        `${entry.id} has no brief`)
      assert.ok(entry.brief.length <= 161, `${entry.id}'s brief is not one line`)
      assert.match(entry.brief, /[.!?…]$/, `${entry.id}'s brief does not end`)
      assert.doesNotMatch(entry.brief, /\n/, `${entry.id}'s brief is not one line`)
    }
    // And it says what the entry does, not what it is called: this is the
    // assertion that would have caught a search returning titles alone.
    const difference = entries.find((entry) => entry.id === 'geometry.boolean.difference')
    assert.match(difference.brief, /Subtracts|subtract/)
  })

  test('describe returns the whole contract for one entry', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_algorithm_describe',
      { id: 'geometry.boolean.intersection' })
    assert.equal(json.entry.backend, 'iam')
    assert.ok(json.entry.preconditions.length > 0, 'a contract without its refusals is not a contract')
    assert.ok(json.entry.limits.max_triangles_per_operand > 0)
    assert.equal(json.entry.c_symbol, 'iamGeometryBoolean')
    assert.ok(json.result_schema, 'the result schema travels with the entry')
  })

  test('an unknown id is a thrown error whose message names what exists', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    // A wrong id means the bridge could not answer at all, which is the half of
    // the contract that throws -- the harness shows the message as a tool error,
    // and it has to be one the model can correct itself from. "not found" alone
    // leaves it nothing to work with, so the count is asserted too.
    await assert.rejects(
      () => call(tools, 'iam_algorithm_describe', { id: 'no.such.algorithm' }),
      (error) => {
        assert.match(error.message, /no algorithm with id/)
        assert.match(error.message, /[1-9]\d* entries/)
        return true
      },
    )
  })

  test('a missing required argument is refused before the bridge is spawned', async () => {
    const tools = mount()
    await assert.rejects(() => call(tools, 'iam_algorithm_describe', {}), /"id" is required/)
  })
})

describe('the tools that execute', () => {
  test('native contour pipeline is discoverable and both methods save through Harness', { skip: PLATFORM ? false : SKIP }, async () => {
    const workspace = mkdtemp('iam-contour-model-')
    const tools = mount({ workspace })
    const id = 'geometry.surface.build_contour_model'
    const { json: search } = await call(tools, 'iam_algorithm_search', { query: '轮廓 简化 单文件' })
    assert.ok(search.families.some(family => family.entries.some(entry => entry.id === id)))
    const { json: described } = await call(tools, 'iam_algorithm_describe', { id })
    assert.equal(described.entry.call_kind, 'invoke')
    assert.equal(described.entry.c_symbol, 'iamBuildContourModel')
    for (const text of ['contour-model-20261106-v1', '6000', '0.02', 'timeoutSeconds=3600']) {
      assert.ok(described.entry.doc.includes(text), text)
    }
    const { json: exporter } = await call(tools, 'iam_algorithm_describe', { id: 'geometry.surface.save_contour_model' })
    assert.equal(exporter.entry.c_symbol, 'iamSaveContourModels')
    const code = readFileSync(join(pluginRoot, 'algorithm-bridge', 'examples', 'build_contour_model.py'), 'utf8')
    const { json } = await call(tools, 'iam_program_run', { workspace, code, timeoutSeconds: 60 })
    assert.equal(json.exit_code, 0, json.stderr)
    const results = json.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.deepEqual(results.map(result => result.profile.method), ['ordinary', 'variational'])
    for (const result of results) {
      assert.equal(result.native_pipeline, true)
      assert.equal(result.output.material_count, 2)
      assert.equal(result.output.all_geometry_rows_verified, true)
      assert.equal(result.simplification.observed_faces_unchanged, true)
      assert.ok(result.simplification.material_triangles_after < result.simplification.material_triangles_before)
      assert.ok(existsSync(result.output.path))
      const replay = JSON.parse(readFileSync(result.report_path, 'utf8'))
      assert.equal(replay.resolved_parameters.preset_version, 'contour-model-20261106-v1')
      assert.ok(replay.simplification.patches.length > 0)
    }
  })

  test('critical slice contact retains separate volume lineage through Harness', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', { code: `
import json
from iam_algorithms import modeling
def ring(z,a,b):
    return dict(material="A",vertices=[[a,0,z],[b,0,z],[b,1,z],[a,1,z]])
sections=[dict(plane=dict(origin=[0,0,z],normal=[0,0,1]),contours=[ring(z,-1,-.5),ring(z,.5,1)]) for z in (0,10)]
model=dict(size=[3,2,3],origin=[-1,0],spacing=[1,1],materials=[0,"A"],
    scores=[s for t in (0,.5,1) for y in (0,1) for x in (-1,0,1) for s in (0,abs(x)-.5*abs(2*t-1))])
r=modeling.interpolate_contours(sections,space_time_model=model,recursive_rounds=2,
    coordinate_frame="harness-lineage",length_unit="m",unit_to_meters=1)
interval,=r["intervals"]
regions=[[c for c in l["contours"] if c["material"]=="A" and not c["is_hole"]] for l in interval["inserted"]]
groups=[g for g in interval["correspondences"] if g["material"]=="A"]
assert all(n["composition_valid"] for n in interval["refinement_tree"])
print(json.dumps(dict(version=r["algorithm_semantic_version"],counts=list(map(len,regions)),
    critical_components=len(regions[1][0]["model_components"]),relations=[g["relation_kind"] for g in groups],context=r["refinement_context"]["version"])))
` })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout), { version: 14, counts: [2, 1, 2],
      critical_components: 2, relations: ['continuation', 'continuation'], context: 4 })
  })

  test('variational reconstruction is discoverable and its comparison example runs through Harness', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const id = 'geometry.surface.reconstruct_contours_variational'
    const { json: search } = await call(tools, 'iam_algorithm_search', { query: '三维变分隐式重建' })
    assert.ok(search.families.some(family => family.entries.some(entry => entry.id === id)))
    const { json: described } = await call(tools, 'iam_algorithm_describe', { id })
    assert.equal(described.entry.call_kind, 'invoke')
    assert.equal(described.entry.c_symbol, 'iamReconstructSectionsVariational')
    assert.ok(described.result_schema)
    const inputs = new Set(described.entry.inputs.map(input => input.name))
    for (const parameter of ['axial_resolution', 'smooth_length', 'bending_weight',
      'prior_weight', 'solver_tolerance', 'max_iterations']) assert.ok(inputs.has(parameter), parameter)
    for (const parameter of ['interface_mode', 'field_smooth_sigma', 'require_section_continuity']) {
      assert.equal(inputs.has(parameter), false, parameter)
    }
    const code = readFileSync(join(pluginRoot, 'algorithm-bridge', 'examples',
      'reconstruct_sections_variational.py'), 'utf8')
    const { json } = await call(tools, 'iam_program_run', { code, timeoutSeconds: 60 })
    assert.equal(json.exit_code, 0, json.stderr)
    const [original, variational] = json.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(original.algorithm, 'geometry.surface.reconstruct_contours')
    assert.equal(variational.algorithm, id)
    for (const result of [original, variational]) {
      assert.deepEqual(result.meshes.map(mesh => mesh.material), [1, 2])
      assert.ok(result.meshes.every(mesh => mesh.closed_manifold && mesh.triangles > 0))
    }
    assert.equal(variational.solver.observed_station_count, 2)
    assert.equal(variational.solver.computational_station_count, 5)
    assert.equal(variational.solver.converged, true)
    assert.ok(variational.solver.relative_projected_gradient <= 1e-4)
  })

  test('explicit space-time model preserves unknown and scoped continuous proof in Harness', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', { code: `
import json
from iam_algorithms import modeling
sections=[dict(plane=dict(origin=[0,0,z],normal=[0,0,1]),contours=[dict(material="A",
    vertices=[[.5,0,z],[2,0,z],[2,2,z],[.5,2,z]])]) for z in (0,10)]
model=dict(size=[2,2,2],origin=[0,0],spacing=[2,2],materials=[0,"A","unknown"],unknown_material="unknown",
    scores=[s for t in (0,1) for y in (0,2) for x in (0,2) for s in (0,x-.5,.5-x)])
kw=dict(space_time_model=model,coordinate_frame="harness-pl",length_unit="m",unit_to_meters=1)
first=modeling.interpolate_contours(sections,recursive_rounds=1,**kw)
r=modeling.interpolate_contours(sections,recursive_rounds=2,
    refinement_context=json.loads(json.dumps(first["refinement_context"])),**kw)
interval,=r["intervals"]
assert all(any(a["material"]=="unknown" for a in l["areas"]) for l in interval["inserted"])
assert all(l["incidence_valid"] for l in interval["inserted"])
print(json.dumps(dict(version=r["algorithm_semantic_version"],parameters=[l["fraction"] for l in interval["inserted"]],
    certificate=interval["continuous_certificate"]["status"],scope=r["diagnostics"]["certificate_scope"],
    geological=interval["continuous_certificate"]["geological_truth_certified"],context=r["refinement_context"]["version"])))
` })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout), { version: 14, parameters: [.25, .5, .75],
      certificate: 'proved_for_explicit_pl_model', scope: 'explicit_exact_PL_model_only', geological: false, context: 4 })
  })

  test('positioned branch events keep formal midpoints and shared critical seams in Harness', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', { code: `
import json
from iam_algorithms import modeling
def rectangle(z,a,b):
    return dict(material="A",vertices=[[a,0,z],[b,0,z],[b,2,z],[a,2,z]])
sections=[dict(contours=[rectangle(0,0,6)]),dict(contours=[rectangle(10,0,2),rectangle(10,4,6)])]
r=modeling.interpolate_contours(sections,resolution=.25,recursive_rounds=3,
    event_priors=[dict(interval=0,group=0,event="split",fraction=.75)],
    coordinate_frame="harness-branch",length_unit="m",unit_to_meters=1)
interval,=r["intervals"]
assert "explicit root event positions" in r["diagnostics"]["branch_location_prior"]
critical=next(s for s in interval["inserted"] if s["fraction"]==.75)
event,=[e for e in interval["events"] if e["type"]=="split"]
assert all(critical["interfaces"][i]["left"]==critical["interfaces"][i]["right"]=="A" for i in critical["degeneracies"][0]["interfaces"])
print(json.dumps(dict(version=r["algorithm_semantic_version"],
    parameters=[s["fraction"] for s in interval["inserted"]],
    counts=[len(s["contours"]) for s in interval["inserted"]],
    critical=critical["status"],event_owners=sum(event["id"] in n["critical_events"] for n in interval["refinement_tree"]))))
` })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout), { version: 14,
      parameters: [.125, .25, .375, .5, .625, .75, .875],
      counts: [1, 1, 1, 1, 1, 2, 2], critical: 'critical', event_owners: 1 })
  })

  test('section feature correspondence survives Harness and diagnoses cyclic reconnection', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', { code: `
import json
from iam_algorithms import modeling, IamError
meta = dict(resolution=.25, coordinate_frame="harness-incidence", length_unit="m", unit_to_meters=1)
def rect(z,x0,x1,y0,y1,m):
    return dict(material=m, vertices=[[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]])
def triple(z,dx=0,flip=False):
    b,c = ("C","B") if flip else ("B","C")
    return dict(contours=[rect(z,dx,dx+2,0,4,"A"),rect(z,dx+2,dx+4,0,2,b),rect(z,dx+2,dx+4,2,4,c)])
r = modeling.interpolate_contours([triple(0),triple(10,100)],recursive_rounds=2,**meta)
g = r["intervals"][0]["topology_correspondence"]
assert all(n["feature_composition_valid"] for n in r["intervals"][0]["refinement_tree"])
try:
    modeling.interpolate_contours([triple(0),triple(10,flip=True)],recursive_rounds=1,**meta)
except IamError as e:
    diagnostic = e.diagnostics["code"]
else:
    diagnostic = "unexpected success"
print(json.dumps(dict(status=g["status"],junctions=len(g["junctions"]["links"]),
    interfaces=len(g["interfaces"]["links"]),diagnostic=diagnostic)))
` })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout),
      { status: 'resolved', junctions: 4, interfaces: 6, diagnostic: 'JUNCTION_RECONNECTION_REQUIRED' })
  })

  test('midpoint refinement and critical events use the catalog direct route in Harness', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json: described } = await call(tools, 'iam_algorithm_describe',
      { id: 'geometry.section.interpolate_contours' })
    assert.equal(described.entry.call_kind, 'direct')
    assert.equal(described.entry.invoke_enabled, false)
    assert.ok(described.entry.inputs.some(input => input.name === 'recursive_rounds'))
    const { json } = await call(tools, 'iam_program_run', { code: `
import json
from iam_algorithms import Library, modeling
meta = dict(resolution=.25, coordinate_frame="harness-midpoint", length_unit="m", unit_to_meters=1)
def square(z):
    return dict(contours=[dict(material="ore", vertices=[[0,0,z],[4,0,z],[4,4,z],[0,4,z]])])
source = [square(0), square(10)]
first = modeling.interpolate_contours(source, recursive_rounds=1, **meta)
dense = modeling.interpolate_contours(source, recursive_rounds=2,
    refinement_context=json.loads(json.dumps(first["refinement_context"])), **meta)
assert first["intervals"][0]["inserted"][0] == dense["intervals"][0]["inserted"][1]
empty = dict(contours=[], plane=dict(origin=[0,0,10], normal=[0,0,1]))
death = modeling.interpolate_contours([square(0), empty], recursive_rounds=1,
    event_priors=[dict(interval=0, group=0, event="termination", fraction=.5)], **meta)
try:
    Library().invoke("geometry.section.interpolate_contours")
except TypeError:
    invoke_refused = True
else:
    invoke_refused = False
print(json.dumps(dict(fractions=[s["fraction"] for s in dense["intervals"][0]["inserted"]],
    critical=death["intervals"][0]["inserted"][0]["status"], invoke_refused=invoke_refused)))
` })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout),
      { fractions: [.25, .5, .75], critical: 'critical', invoke_refused: true })
  })

  test('program_run hands back the program\'s own output', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', {
      code: 'import iam_algorithms\nprint("catalog", iam_algorithms.Library().algorithm_count)',
    })
    assert.equal(json.exit_code, 0)
    assert.match(json.stdout, /catalog [1-9]\d*/)
  })

  test('a program that fails is a result, not an error', { skip: PLATFORM ? false : SKIP }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', { code: 'raise SystemExit(3)' })
    assert.equal(json.exit_code, 3)
  })

  test('the program file is gone once the run is over', { skip: PLATFORM ? false : SKIP }, async () => {
    // One file per run, made and removed around it -- not a directory per run.
    // The directory form was measured failing against the desktop harness's
    // `workspace-write` sandbox, where a confined child cannot remove what it
    // wrote one level down, and the cleanup refusal failed the whole call after
    // the program had already produced its answer.
    const before = programFiles()
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', { code: 'print("done")' })
    assert.equal(json.exit_code, 0)
    assert.equal(json.leftover, undefined, 'a run left the program file behind')
    assert.deepEqual(programFiles(), before, 'the run left a file in the temp directory')
  })

  test('a refused cleanup is reported, not turned into a failed run', {
    // Making the file undeletable is the one way a test can arrange the refusal
    // a sandbox produced: `os.chmod` blocks the unlink on Windows and does not
    // on POSIX, where the directory's permission governs instead.
    skip: process.platform === 'win32' && PLATFORM ? false : 'arranges a Windows-only refusal',
  }, async () => {
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', {
      code: 'import os, pathlib\nos.chmod(pathlib.Path(__file__), 0o400)\nprint("locked")\n',
    })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.match(json.stdout, /locked/, 'the program ran but its output was thrown away')
    assert.match(json.leftover.reason, /Permission|denied|拒绝/i)
    assert.ok(existsSync(json.leftover.path), 'the reported leftover is not there')
    chmodSync(json.leftover.path, 0o600)
    rmSync(json.leftover.path, { force: true })
  })

  test('the bridge imports both libraries for the child', { skip: PLATFORM ? false : SKIP }, async () => {
    // Neither import is spelled out by the program: the PYTHONPATH is the
    // bridge's, which is the whole reason a generated program can be short.
    const tools = mount()
    const { json } = await call(tools, 'iam_program_run', {
      code: 'import iam\nprint("port ok", bool(iam))',
    })
    assert.equal(json.exit_code, 0, json.stderr)
    assert.match(json.stdout, /port ok/)
  })

  test('workflow_run refuses an unknown name as a result', { skip: PLATFORM ? false : SKIP }, async () => {
    // A fresh workspace has no platform capability; the refusal names the one
    // the user froze, so a wrong name is still correctable from the answer.
    const workspace = mkdtemp('bridge-ws-')
    writeWorkflow(workspace, 'known-workflow', [], join(workspace, 'marker'))
    const tools = mount({ workspace })
    const { json } = await call(tools, 'iam_workflow_run', {
      name: 'no-such-workflow', workspace,
    })
    assert.equal(json.ok, false)
    assert.match(json.refused, /no workflow named/)
    assert.match(json.refused, /known-workflow/, 'the refusal names what does exist')
  })

  test('the session\'s own workspace is used when neither the call nor the config names one', { skip: PLATFORM ? false : SKIP }, async () => {
    // This is what makes a workspace setting optional: the Harness tracks a
    // directory per session, and the plugin asks it rather than being told.
    const workspace = mkdtemp('bridge-ws-')
    const asked = []
    const tools = mount({}, {
      ensure: async (agent, signal) => {
        asked.push([agent, signal !== undefined])
        return workspace
      },
    })
    const { json } = await call(tools, 'iam_workflow_list', {}, { session: 'the-agent' })
    assert.equal(json.workspace, workspace, 'the session directory reached the bridge')
    assert.equal(asked.length, 1)
    assert.deepEqual(asked[0][0], { session: 'the-agent' }, 'the tool passed the Session it was given')
    assert.deepEqual(json.workflow_roots.map((root) => root.provenance), ['builtin', 'workspace'])
  })

  test('a named workspace cannot escape the session, and the config is the last resort', async () => {
    const named = mkdtemp('bridge-ws-')
    const session = mkdtemp('bridge-ws-')
    let asked = 0
    const tools = mount({ workspace: 'D:/from-config', allowUnsafeExecution: false }, {
      ensure: async () => {
        asked += 1
        return session
      },
    })
    await assert.rejects(() => call(tools, 'iam_workflow_run', { name: 'nope', workspace: named }, {}),
      /outside this session/)
    assert.equal(asked, 1)

    const fallback = await call(mount({ workspace: 'D:/from-config' }), 'iam_workflow_list', {}, undefined)
    assert.equal(fallback.json.workspace, 'D:/from-config', 'no service and no argument: the config is used')
  })

  test('a workflow found in the workspace is run in a child, not in the bridge', { skip: PLATFORM ? false : SKIP }, async () => {
    // The property under test is that a USER's workflow cannot take the bridge
    // down with it. A built-in one is repository code; this one raises
    // SystemExit(7), and the call still comes back with an answer.
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const program = [
      'class WorkflowError(RuntimeError):',
      '    pass',
      'def run(**kwargs):',
      '    raise SystemExit(7)',
    ].join('\n')
    const ran = await call(tools, 'iam_program_run', { code: program, workspace })
    assert.equal(ran.json.record.recorded, true, 'the run was kept for a later freeze')

    const frozen = await call(tools, 'iam_workflow_freeze', {
      name: 'explode', run: ran.json.record.id, workspace, confirmed: true,
      manifest: { title: 't', answers: 'a', inputs: {}, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'] },
    })
    assert.equal(frozen.json.frozen, true)

    const listed = await call(tools, 'iam_workflow_list', { workspace })
    const entry = listed.json.workflows.find((w) => w.name === 'explode')
    assert.equal(entry.provenance, 'workspace')

    const outcome = await call(tools, 'iam_workflow_run', { name: 'explode', workspace })
    assert.equal(outcome.json.ok, false)
    assert.equal(outcome.json.crashed, true, 'the child died, and the bridge is still here')
    assert.equal(outcome.json.exit_code, 7)
  })

  test('a name that resolves to two programs is refused, not shadowed', { skip: PLATFORM ? false : SKIP }, async () => {
    // Two directories in one root can carry the same manifest name. Running one
    // quietly would hide the other, and the caller could not tell which one
    // answered; the refusal names both paths.
    const workspace = mkdtemp('bridge-ws-')
    for (const directory of ['first', 'second']) {
      const target = join(workspace, '.iax', 'workflows', directory)
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
      writeFileSync(join(target, 'manifest.json'), JSON.stringify({
        workflow_version: 1, name: 'duplicate-name', entry: 'workflow.py',
        title: 't', answers: 'a', inputs: {}, steps: [], acceptance: [],
      }))
    }
    await assert.rejects(
      () => call(mount({ workspace }), 'iam_workflow_list', { workspace }),
      (error) => {
        assert.match(error.message, /two workflows are named/)
        assert.match(error.message, /first/, 'the refusal names both paths')
        assert.match(error.message, /second/, 'the refusal names both paths')
        return true
      },
    )
  })

  test('freezing refuses a manifest that states none of the three things', { skip: PLATFORM ? false : SKIP }, async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const ran = await call(tools, 'iam_program_run', { code: 'print(1)', workspace })
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'thin', run: ran.json.record.id, workspace, confirmed: true,
        manifest: { title: 't', answers: 'a' },
      }),
      /'inputs' is missing/,
    )
  })

  test('generated code is refused without an execution sandbox', async () => {
    await assert.rejects(
      () => call(mount({ allowUnsafeExecution: false }), 'iam_program_run', { code: 'print(1)' }),
      /programRunner sandbox/,
    )
  })

  test('a declared result schema is enforced, in the part that can be', async () => {
    // `workspace_algorithms` REQUIRES a result_schema and `iam_algorithm_describe`
    // publishes it, so leaving it unchecked made it decoration wearing the word
    // "required". Two rules are enforced -- type and required -- and the test
    // pins the boundary as well as the rules, because a check that quietly grew
    // into a partial JSON Schema would be worse than this one.
    const workspace = mkdtemp('bridge-ws-')
    const write = (name, schema, body) => {
      const directory = join(workspace, '.iax', 'algorithms', name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
        id: 'user.' + name, operation: 'x.' + name, title: name,
        inputs: [{ name: 'unused', required: false }], result_schema: schema,
      }))
      writeFileSync(join(directory, 'algorithm.py'),
        ['class WorkflowError(RuntimeError):', '    pass', 'def run(**kwargs):', '    return ' + body].join('\n'))
    }
    write('wrongtype', { type: 'object' }, '[1, 2]')
    write('missingfield', { type: 'object', required: ['total'] }, '{"other": 1}')
    write('booleannotnumber', { type: 'number' }, 'True')
    write('unchecked', { type: 'object', properties: { a: { type: 'string' } } }, '{"a": 5}')

    const tools = mount({ workspace })
    await assert.rejects(
      () => call(tools, 'iam_algorithm_run', { id: 'user.wrongtype', workspace }),
      /returned array but its result_schema declares type object/,
    )
    await assert.rejects(
      () => call(tools, 'iam_algorithm_run', { id: 'user.missingfield', workspace }),
      /nothing for required field\(s\): total/,
    )
    // Python's True IS an int, so a schema asking for a number must not take it.
    await assert.rejects(
      () => call(tools, 'iam_algorithm_run', { id: 'user.booleannotnumber', workspace }),
      /returned boolean but its result_schema declares type number/,
    )
    // `properties` is carried and published, and NOT enforced -- by design.
    const passed = await call(tools, 'iam_algorithm_run', { id: 'user.unchecked', workspace })
    assert.equal(passed.json.ok, true)
    assert.deepEqual(passed.json.report, { a: 5 })
  })

  test('the bridge and the programs it spawns import the same copy of a library', async () => {
    // The vendored copy exists so an installed package stands alone, and it must
    // not shadow the checkout for a DEVELOPER: with the two disagreeing, an edit
    // to `iam_algorithms` was live for a generated program and stale for the
    // bridge describing it. This pins the child's half -- the observable one --
    // and `bridge.py` applies one ordered path list to itself and its child.
    const { json } = await call(mount({ allowUnsafeExecution: true }), 'iam_program_run', {
      code: 'import iam_algorithms, iam\nprint(iam_algorithms.__file__)\nprint(iam.__file__)',
    })
    const [algorithms, mining] = json.stdout.trim().split(/\r?\n/)
    assert.ok(algorithms.includes(join('build', 'CMakePlatforms')) &&
      algorithms.endsWith(join('IAM', 'Host', 'Python', 'iam_algorithms', '__init__.py')),
      `expected the generated build package, got ${algorithms}`)
    assert.ok(mining.endsWith(join('Mining', 'Host', 'python', 'iam', '__init__.py')),
      `expected the checkout's iam, got ${mining}`)
    assert.ok(!algorithms.includes('vendor') && !mining.includes('vendor'),
      'the packaged copy shadowed the checkout, which is the bug this pins')
  })

  test('a deployed bridge gives programs its packaged Python bindings', { skip: !HAS_GENERATED_PYTHON_PACKAGE }, async () => {
    const packageRoot = join(pluginRoot, 'algorithm-bridge')
    const vendor = join(packageRoot, 'python', 'vendor')
    const previous = process.env.IAM_PYTHON_PACKAGE_DIR
    process.env.IAM_PYTHON_PACKAGE_DIR = GENERATED_PYTHON_PACKAGE
    const build = (mode) => spawnSync(process.execPath, ['scripts/build.mjs', mode],
      { cwd: packageRoot, encoding: 'utf8' })
    const host = build('host')
    assert.equal(host.status, 0, host.stderr)
    assert.equal(existsSync(vendor), false, 'a normal checkout still contains copied bindings')
    const staged = build('package')
    assert.equal(staged.status, 0, staged.stderr)
    try {
      const platformRoot = mkdtemp('bridge-platform-')
      const { json } = await call(mount({ platformRoot }), 'iam_program_run', {
        code: 'import iam_algorithms, iam\nprint(iam_algorithms.__file__)\nprint(iam.__file__)',
      })
      assert.equal(json.exit_code, 0, json.stderr)
      const [algorithms, mining] = json.stdout.trim().split(/\r?\n/)
      assert.ok(algorithms.endsWith(join('algorithm-bridge', 'python', 'vendor', 'iam_algorithms', '__init__.py')),
        `expected packaged iam_algorithms, got ${algorithms}`)
      assert.ok(mining.endsWith(join('algorithm-bridge', 'python', 'vendor', 'iam', '__init__.py')),
        `expected packaged iam, got ${mining}`)
    } finally {
      const cleaned = build('clean')
      assert.equal(cleaned.status, 0, cleaned.stderr)
      if (previous === undefined) delete process.env.IAM_PYTHON_PACKAGE_DIR
      else process.env.IAM_PYTHON_PACKAGE_DIR = previous
    }
    assert.equal(existsSync(vendor), false, 'packaging left copied bindings in the checkout')
  })

  test('an explicit generated package is used by the bridge and its child', { skip: !HAS_GENERATED_PYTHON_PACKAGE }, async () => {
    const previous = process.env.IAM_PYTHON_PACKAGE_DIR
    process.env.IAM_PYTHON_PACKAGE_DIR = GENERATED_PYTHON_PACKAGE
    try {
      const found = await call(mount(), 'iam_algorithm_search', { operation: '*' })
      assert.ok(found.json.entry_count > 0)
      const ran = await call(mount(), 'iam_program_run', {
        code: 'import iam_algorithms as a\nprint(a.__file__)\nprint(a.Library().algorithm_count)',
      })
      assert.equal(ran.json.exit_code, 0, ran.json.stderr)
      const [filename, count] = ran.json.stdout.trim().split(/\r?\n/)
      assert.ok(filename.includes(join('python-package', 'iam_algorithms', '__init__.py')), filename)
      assert.equal(Number(count), found.json.entry_count)
    } finally {
      if (previous === undefined) delete process.env.IAM_PYTHON_PACKAGE_DIR
      else process.env.IAM_PYTHON_PACKAGE_DIR = previous
    }
  })

  test('a workspace algorithm is discoverable, described and executed', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const directory = join(workspace, '.iax', 'algorithms', 'sample')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      id: 'user.sample', operation: 'arithmetic.sum', title: 'Sum two numbers',
      inputs: [{ name: 'a' }, { name: 'b' }], result_schema: { type: 'number' },
    }))
    writeFileSync(join(directory, 'algorithm.py'), [
      'class WorkflowError(RuntimeError):', '    pass',
      'def run(a, b, log=None):', '    return a + b',
    ].join('\n'))
    const tools = mount({ workspace })
    const found = await call(tools, 'iam_algorithm_search', { query: 'user.sample', workspace })
    assert.equal(found.json.entry_count, 1)
    assert.equal(found.json.families[0].entries[0].provenance, 'workspace')
    const described = await call(tools, 'iam_algorithm_describe', { id: 'user.sample', workspace })
    assert.equal(described.json.execution, 'iam_algorithm_run')
    assert.match(described.json.entry.source_sha256, /^[0-9a-f]{64}$/)
    const missing = await call(tools, 'iam_algorithm_run', { id: 'user.sample', workspace, arguments: { a: 2 } })
    assert.match(missing.json.refused, /missing required inputs: b/)
    const ran = await call(tools, 'iam_algorithm_run', {
      id: 'user.sample', workspace, arguments: { a: 2, b: 3 },
    })
    assert.equal(ran.json.ok, true)
    assert.equal(ran.json.report, 5)
    assert.equal(ran.json.source_sha256, described.json.entry.source_sha256)
  })

  test('freeze rejects an escaping name and an unconfirmed run', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const ran = await call(tools, 'iam_program_run', { code: 'print(1)', workspace })
    const manifest = { title: 't', answers: 'a', inputs: {}, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'] }
    await assert.rejects(() => call(tools, 'iam_workflow_freeze', {
      name: '../outside', run: ran.json.record.id, workspace, manifest, confirmed: true,
    }), /one path component/)
    await assert.rejects(() => call(tools, 'iam_workflow_freeze', {
      name: 'unconfirmed', run: ran.json.record.id, workspace, manifest, confirmed: false,
    }), /explicit confirmation/)
  })

  test('a failed program cannot be frozen', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const ran = await call(tools, 'iam_program_run', { code: 'raise RuntimeError("failed")', workspace })
    assert.equal(ran.json.ok, false)
    await assert.rejects(() => call(tools, 'iam_workflow_freeze', {
      name: 'failed', run: ran.json.record.id, workspace, confirmed: true,
      manifest: { title: 't', answers: 'a', inputs: {}, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'] },
    }), /only a successful recorded run/)
  })

  test('freeze detects a modified recorded source', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const ran = await call(tools, 'iam_program_run', { code: 'print(1)', workspace })
    writeFileSync(join(ran.json.record.directory, 'program.py'), 'print(2)')
    await assert.rejects(() => call(tools, 'iam_workflow_freeze', {
      name: 'changed', run: ran.json.record.id, workspace, confirmed: true,
      manifest: { title: 't', answers: 'a', inputs: {}, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'] },
    }), /changed after it ran/)
  })

  test('generated output is bounded before the bridge serializes it', async () => {
    const { json } = await call(mount(), 'iam_program_run', { code: 'print("x" * 2000000)' })
    assert.equal(json.ok, false)
    assert.match(json.detail, /1 MiB limit/)
    assert.ok(json.stdout.length <= 256 * 1024)
  })

  test('Harness cancellation stops a running generated program', async () => {
    const tool = mount().registered.get('iam_program_run')
    const controller = new AbortController()
    const pending = tool.execute({ code: 'import time\ntime.sleep(30)' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await assert.rejects(pending, /cancelled/)
  })

  test('Harness cancellation stops descendants of a generated program', async () => {
    const tool = mount().registered.get('iam_program_run')
    const controller = new AbortController()
    const workspace = mkdtemp('bridge-cancel-')
    const ready = join(workspace, 'ready')
    const marker = join(workspace, 'descendant-survived')
    const childCode = `import time; from pathlib import Path; time.sleep(1); Path(${JSON.stringify(marker)}).write_text('alive')`
    const code = [
      'import subprocess, sys, time',
      'from pathlib import Path',
      `subprocess.Popen([sys.executable, '-c', ${JSON.stringify(childCode)}])`,
      `Path(${JSON.stringify(ready)}).write_text('ready')`,
      'time.sleep(5)',
    ].join('\n')
    const started = Date.now()
    const pending = tool.execute({ code }, { signal: controller.signal })
    while (!existsSync(ready) && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(existsSync(ready), 'the generated program started its descendant')
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    assert.ok(Date.now() - started < 3000, 'cancellation must not wait for a descendant to exit')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.ok(!existsSync(marker), 'cancellation must terminate the descendant')
  })

  test('a draft is listed after active and refused by run; missing status is active', async () => {
    // P9: a scaffold is on disk but is not a capability. The list marks it, the
    // run refuses it, and a workflow with no status at all is still active --
    // every workflow that predates the field must behave as it did.
    const workspace = mkdtemp('bridge-ws-')
    const write = (name, status) => {
      const directory = join(workspace, '.iax', 'workflows', name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
      const manifest = {
        workflow_version: 1, name, entry: 'workflow.py', title: 't', answers: 'a',
        inputs: {}, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'],
      }
      if (status !== undefined) manifest.status = status
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
    }
    write('active-one', undefined)
    write('draft-one', 'draft')
    const tools = mount({ workspace })
    const listed = await call(tools, 'iam_workflow_list', { workspace })
    assert.deepEqual(listed.json.workflows.map((workflow) => workflow.name),
      ['active-one', 'draft-one'], 'drafts sort after active')
    assert.deepEqual(listed.json.workflows.map((workflow) => workflow.status),
      ['active', 'draft'])

    const refused = await call(tools, 'iam_workflow_run', {
      name: 'draft-one', workspace, arguments: {},
    })
    assert.equal(refused.json.ok, false)
    assert.match(refused.json.refused, /draft/)
    assert.match(refused.json.refused, /freeze/)

    const ran = await call(tools, 'iam_workflow_run', {
      name: 'active-one', workspace, arguments: {},
    })
    assert.equal(ran.json.ok, true, JSON.stringify(ran.json).slice(0, 300))
    assert.deepEqual(ran.json.report, {})
  })

  test('a dot-directory parked while freezing is not a workflow', async () => {
    // The forge moves a scaffold to .draft-<name>-<stamp> while the bridge
    // freezes it. If the catalog scanned that directory, a half-finished freeze
    // would be listed and runnable under its manifest name.
    const workspace = mkdtemp('bridge-ws-')
    const parked = join(workspace, '.iax', 'workflows', '.draft-ghost-20260101-000000')
    mkdirSync(parked, { recursive: true })
    writeFileSync(join(parked, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
    writeFileSync(join(parked, 'manifest.json'), JSON.stringify({
      workflow_version: 1, name: 'ghost', entry: 'workflow.py', title: 't', answers: 'a',
      inputs: {}, steps: [{ n: 1, does: 'run' }], acceptance: ['returns'],
    }))
    const tools = mount({ workspace })
    const listed = await call(tools, 'iam_workflow_list', { workspace })
    assert.deepEqual(listed.json.workflows, [])
    const refused = await call(tools, 'iam_workflow_run', {
      name: 'ghost', workspace, arguments: {},
    })
    assert.equal(refused.json.ok, false)
    assert.match(refused.json.refused, /no workflow named 'ghost'/)
  })

  test('the by-product example runs end to end from a workspace', { skip: PLATFORM ? false : SKIP }, async () => {
    // The example is a fixture, not a shipped capability: copy it into the
    // workspace first, which is also the only way a capability reaches the
    // catalog now. Its run is then the workspace (isolated) path.
    const workspace = mkdtemp('bridge-ws-')
    const example = join(pluginRoot, 'algorithm-bridge', 'workflows-source', 'Examples', 'ByProductOre')
    const target = join(workspace, '.iax', 'workflows', 'by-product-ore')
    mkdirSync(join(workspace, '.iax', 'workflows'), { recursive: true })
    cpSync(example, target, { recursive: true })
    const tools = mount({ workspace })
    const listed = await call(tools, 'iam_workflow_list', { workspace })
    const entry = listed.json.workflows.find((workflow) => workflow.name === 'by-product-ore')
    assert.ok(entry, 'the example copied into the workspace is discovered')
    assert.equal(entry.provenance, 'workspace')
    // The manifest is the contract a caller reads, so its input names are what
    // this call uses -- the same names run() declares, which is what makes
    // `run(**arguments)` work without a translation table.
    assert.deepEqual(entry.required_inputs, ['project', 'block_model', 'grades', 'density'])

    const { json } = await call(tools, 'iam_workflow_run', {
      name: 'by-product-ore',
      workspace,
      arguments: {
        project: PROJECT,
        block_model: 'merge-2-dimine-block-model',
        // The METAL is named, not just the column: the model declares every
        // field's unit as '1', so nothing in the project says CU is a grade.
        grades: [{ column: 'merge-2-dimine-cell-1', metal: 'Cu', scale: 1.0 }],
        density: 2.7,
        log: undefined,
      },
    })
    delete json?.report?.rows
    assert.equal(json.ok, true, JSON.stringify(json).slice(0, 400))
    const totals = json.report.totals
    assert.equal(totals.roadways_selected, 33)
    assert.ok(totals.roadways_judged > 0 && totals.roadways_judged < 33)
    // The one property the whole workflow exists for: the totals cover the
    // judged roadways and the report says how many that was.
    assert.ok(totals.coverage > 0 && totals.coverage < 1)
    assert.ok(totals.by_product_volume_m3 > 0)
    assert.ok(totals.ore_tonnes > totals.metals.Cu)
    assert.deepEqual(Object.keys(totals.metals), ['Cu'], 'the total is keyed by the metal asked for')
  })

  test('a --directory fixture still runs in the bridge process', () => {
    // The workspace path is the isolated one; this is the built-in path. With
    // no shipped workflow left, a fixture is its only user -- so the path keeps
    // a test instead of becoming dead code somebody later removes by accident.
    // --directory names the ROOT the catalog scans, not one workflow directory;
    // it is the same `*/manifest.json` shape the built-in root has.
    const root = mkdtemp('bridge-builtin-')
    const fixture = join(root, 'probe')
    mkdirSync(fixture, { recursive: true })
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify({
      workflow_version: 1, name: 'probe', entry: 'workflow.py',
      title: 't', answers: 'a', inputs: {}, steps: [{ n: 1, does: 'probe' }],
      acceptance: ['returns'],
    }))
    writeFileSync(join(fixture, 'workflow.py'), [
      'class WorkflowError(RuntimeError):',
      '    pass',
      'def run(**kwargs):',
      '    return {"probe": True}',
    ].join('\n'))
    const bridge = join(pluginRoot, 'algorithm-bridge', 'python', 'bridge.py')
    const python = process.env.IAX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const completed = spawnSync(python, ['-X', 'utf8', bridge, 'workflow-run',
      '--name', 'probe', '--directory', root], { encoding: 'utf8' })
    assert.equal(completed.status, 0, completed.stderr)
    const value = JSON.parse(completed.stdout)
    assert.equal(value.ok, true)
    assert.deepEqual(value.report, { probe: true })
  })
})

describe('a missing required input is a question, not a failure', () => {
  test('algorithm_run answers with needs_input, in the declaration\'s own words', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const directory = join(workspace, '.iax', 'algorithms', 'ask')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      id: 'user.ask', operation: 'test.ask', title: 'Ask',
      inputs: [
        { name: 'known' },
        {
          name: 'density', kind: 'number, t/m3', means: '体重。没有默认值。',
          reason: 'no default exists; a default would be a number invented',
          examples: ['2.7'],
        },
        { name: 'metal', means: '要报的金属。', choices: ['Cu', 'Pb'] },
      ],
      result_schema: { type: 'object' },
    }))
    writeFileSync(join(directory, 'algorithm.py'), [
      'class WorkflowError(RuntimeError):', '    pass',
      'def run(**kwargs):', '    return {}',
    ].join('\n'))

    const { json } = await call(mount({ workspace }), 'iam_algorithm_run', {
      id: 'user.ask', workspace, arguments: { known: 1 },
    })
    assert.equal(json.ok, false)
    assert.equal(json.needs_input, true)
    // The sentence callers already read is the contract, so it stays verbatim.
    assert.equal(json.refused, 'missing required inputs: density, metal')
    assert.deepEqual(json.questions, [
      {
        parameter: 'density', kind: 'number, t/m3', means: '体重。没有默认值。',
        reason: 'no default exists; a default would be a number invented',
        suggested: null, choices: [], examples: ['2.7'],
      },
      // No suggestion is authored, so the first choice is the only one used.
      { parameter: 'metal', means: '要报的金属。', suggested: 'Cu', choices: ['Cu', 'Pb'] },
    ])

    // A refusal that is not about a missing input carries none of this.
    const unknown = await call(mount({ workspace }), 'iam_algorithm_run',
      { id: 'user.absent', workspace })
    assert.equal(unknown.json.needs_input, undefined)
    assert.equal(unknown.json.questions, undefined)
    assert.match(unknown.json.refused, /no workspace algorithm with this id/)
  })

  test('a workflow input declared non-inferable is asked for before the run', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const marker = join(workspace, 'ran')
    writeWorkflow(workspace, 'ask-first', [
      { name: 'project', kind: 'path', means: '项目。', refused_when: '打不开。' },
      {
        name: 'density', kind: 'number, t/m3', means: '体重。没有默认值。',
        refused_when: '不给就拒绝运行。', why_not_inferred: '模型里没有体重列。', suggested: 2.7,
      },
    ], marker)

    const { json } = await call(mount({ workspace }), 'iam_workflow_run', {
      name: 'ask-first', workspace, arguments: { project: 'x.iam' },
    })
    assert.equal(json.ok, false)
    assert.equal(json.needs_input, true)
    assert.equal(json.workflow, 'ask-first')
    assert.equal(json.refused, 'missing required inputs: density')
    assert.deepEqual(json.questions, [{
      parameter: 'density', kind: 'number, t/m3', means: '体重。没有默认值。',
      reason: '模型里没有体重列。', suggested: 2.7, choices: [],
    }])
    assert.equal(existsSync(marker), false, 'the workflow ran although the platform had to ask')
  })

  test('an input with no such declaration keeps the old route into the workflow', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const marker = join(workspace, 'ran')
    writeWorkflow(workspace, 'ask-late', [
      { name: 'project', kind: 'path', means: '项目。', refused_when: '打不开。' },
      { name: 'density', kind: 'number, t/m3', means: '体重。', refused_when: '不给就拒绝运行。' },
    ], marker)

    const { json } = await call(mount({ workspace }), 'iam_workflow_run', {
      name: 'ask-late', workspace, arguments: { project: 'x.iam' },
    })
    assert.equal(json.ok, false)
    assert.equal(json.needs_input, undefined)
    assert.equal(json.questions, undefined)
    assert.match(json.refused, /the workflow itself refused/)
    assert.ok(existsSync(marker), 'the workflow decides for itself, as before')
  })

  test('a workspace manifest written in the catalog vocabulary asks the same way', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const directory = join(workspace, '.iax', 'algorithms', 'catalog-style')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      id: 'user.catalog', operation: 'test.catalog', title: 'Catalog style',
      inputs: [{ name: 'mesh', type: 'geometry.owned-mesh-or-brep', unit: '', description: '被合并的闭合实体。' }],
      result_schema: { type: 'object' },
    }))
    writeFileSync(join(directory, 'algorithm.py'), [
      'class WorkflowError(RuntimeError):', '    pass',
      'def run(**kwargs):', '    return {}',
    ].join('\n'))

    const { json } = await call(mount({ workspace }), 'iam_algorithm_run',
      { id: 'user.catalog', workspace })
    assert.equal(json.needs_input, true)
    assert.deepEqual(json.questions, [{
      parameter: 'mesh', kind: 'geometry.owned-mesh-or-brep', means: '被合并的闭合实体。',
      suggested: null, choices: [],
    }])
  })

  test('a built-in algorithm invoked without its declared inputs answers with questions', {
    skip: PLATFORM ? false : SKIP,
  }, async () => {
    const tools = mount()
    // The invoke route and a direct function both reach the same declaration
    // check; the program's traceback is all this process sees of either, which
    // is why the C++ side appends the marker.
    for (const [code, id, missing] of [
      ["from iam_algorithms import Library\nLibrary().invoke('geometry.boolean.union')",
        'geometry.boolean.union', ['operand_a', 'operand_b']],
      ['from iam_algorithms import modeling\nmodeling.interpolate_contours()',
        'geometry.section.interpolate_contours',
        ['sections', 'coordinate_frame', 'length_unit', 'unit_to_meters']],
    ]) {
      const { json } = await call(tools, 'iam_program_run', { code })
      assert.equal(json.ok, false, JSON.stringify(json).slice(0, 300))
      assert.equal(json.needs_input, true)
      assert.equal(json.algorithm, id)
      assert.deepEqual(json.questions.map((question) => question.parameter), missing)
      assert.equal(json.refused, `missing required inputs: ${missing.join(', ')}`)
      assert.match(json.stderr, /IAM_NEEDS_INPUT/, 'the traceback still carries the payload')
    }
  })

  test('freeze names the position and the field a declaration left out', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const ran = await call(tools, 'iam_program_run', { code: 'print(1)', workspace })
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'vague', run: ran.json.record.id, workspace, confirmed: true,
        manifest: {
          title: 't', answers: 'a',
          inputs: {
            required: [
              { name: 'project', kind: 'path', means: '项目。', refused_when: '打不开。' },
              { name: 'density', kind: 'number, t/m3', refused_when: '不给就拒绝运行。' },
            ],
          },
          steps: [{ n: 1, does: 'run' }], acceptance: ['returns'],
        },
      }),
      (error) => {
        assert.match(error.message, /inputs\.required\[2\]/)
        assert.match(error.message, /"means"/)
        return true
      },
    )
  })
})

describe('freezing keeps the manifest a contract, not a bag of fields', () => {
  /** The five fields every workflow must state, with the rest left to the case. */
  function contract(overrides = {}) {
    return {
      title: 't', answers: 'a', inputs: {},
      steps: [{ n: 1, does: 'run' }], acceptance: ['returns'],
      ...overrides,
    }
  }

  async function frozenRun(workspace, code = 'print(1)') {
    const ran = await call(mount({ workspace }), 'iam_program_run', { code, workspace })
    return ran.json.record.id
  }

  test('a misspelt extension field is refused with the field it meant', async () => {
    // The failure this prevents is silent: the typo used to freeze, the check it
    // meant to carry never existed, and a report could then call the rule
    // "accepted" without anything having tested it.
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'typo', run, workspace, confirmed: true,
        manifest: contract({ accepatance_checks: [{ id: 'one', assert: 'True' }] }),
      }),
      (error) => {
        assert.match(error.message, /"accepatance_checks" is not one this platform reads/)
        assert.match(error.message, /did you mean "acceptance_checks"/)
        return true
      },
    )
    assert.equal(existsSync(join(workspace, '.iax', 'workflows', 'typo')), false,
      'a refused freeze wrote the directory anyway')
  })

  test('acceptance_checks must be as long as acceptance, and say which rule is bare', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'unaligned', run, workspace, confirmed: true,
        manifest: contract({
          acceptance: ['one', 'two', 'three'],
          acceptance_checks: [{ id: 'one', assert: 'True' }, { id: 'two', assert: 'True' }],
        }),
      }),
      /rule 3 has no assertion/,
    )
  })

  test('a check must follow the rule it belongs to', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'misordered', run, workspace, confirmed: true,
        manifest: contract({
          acceptance: [{ id: 'one', rule: 'returns' }],
          acceptance_checks: [{ id: 'two', assert: 'True' }],
        }),
      }),
      /acceptance\[1\] names id "one"/,
    )
  })

  test('every documented extension field freezes', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    const { json } = await call(tools, 'iam_workflow_freeze', {
      name: 'all-fields', run, workspace, confirmed: true,
      manifest: contract({
        version: '1.0.0', status: 'active', supersedes: null, requires_catalog: 54,
        derived: [], consumes: {}, produces: {}, specs: {},
        acceptance: ['one', 'two'],
        acceptance_checks: [{ id: 'one', assert: 'True' }, { id: 'two', assert: 'True' }],
        acceptance_params: {}, known_limits: [], deliverable: { primary: 'report.docx' },
      }),
    })
    assert.equal(json.frozen, true)
    assert.equal(json.status, 'active')
    const manifest = JSON.parse(readFileSync(
      join(workspace, '.iax', 'workflows', 'all-fields', 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, '1.0.0')
    assert.equal(manifest.status, 'active')
    assert.equal(manifest.requires_catalog, 54)
    assert.deepEqual(manifest.acceptance_checks.map((check) => check.id), ['one', 'two'])
  })

  test('a manifest can freeze as a draft, and a bad status is refused', async () => {
    // The catalog reads status, so the freezer must understand it. A direct
    // bridge freeze preserves the caller's draft; iam_workflow_run refuses it.
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    const { json } = await call(tools, 'iam_workflow_freeze', {
      name: 'still-draft', run, workspace, confirmed: true,
      manifest: contract({ status: 'draft' }),
    })
    assert.equal(json.frozen, true)
    assert.equal(json.status, 'draft')
    assert.match(json.next, /draft/)
    const manifest = JSON.parse(readFileSync(
      join(workspace, '.iax', 'workflows', 'still-draft', 'manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'draft')
    const listed = await call(tools, 'iam_workflow_list', { workspace })
    assert.equal(listed.json.workflows.find((entry) => entry.name === 'still-draft').status,
      'draft')
    const refused = await call(tools, 'iam_workflow_run', {
      name: 'still-draft', workspace, arguments: {},
    })
    assert.equal(refused.json.ok, false)

    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'bad-status', run, workspace, confirmed: true,
        manifest: contract({ status: 'published' }),
      }),
      /status.*draft.*active/,
    )
  })

  test('the example ByProductOre manifest still freezes as it is written', async () => {
    // Its reserved keys (workflow_version/name/entry) are the platform's, so a
    // caller omits them; everything else -- including `comment`, deliverable and
    // known_limits -- is the contract this workflow publishes. If the whitelist
    // rejected `comment`, the repository's own example would stop being usable.
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    const shipped = JSON.parse(readFileSync(
      join(pluginRoot, 'algorithm-bridge', 'workflows-source', 'Examples', 'ByProductOre', 'manifest.json'), 'utf8'))
    for (const reserved of ['workflow_version', 'name', 'entry']) delete shipped[reserved]
    const { json } = await call(tools, 'iam_workflow_freeze', {
      name: 'by-product-copy', run, workspace, confirmed: true, manifest: shipped,
    })
    assert.equal(json.frozen, true)
  })

  test('a same-name freeze may advance a version and keeps the old files', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const first = await frozenRun(workspace, 'print("one")')
    const second = await frozenRun(workspace, 'print("two")')
    const one = await call(tools, 'iam_workflow_freeze', {
      name: 'evolve', run: first, workspace, confirmed: true,
      manifest: contract({ version: '1.0.0' }),
    })
    assert.equal(one.json.replaced, null)
    const two = await call(tools, 'iam_workflow_freeze', {
      name: 'evolve', run: second, workspace, confirmed: true,
      manifest: contract({ version: '1.1.0' }),
    })
    assert.deepEqual(two.json.replaced, { version: '1.1.0', previous_version: '1.0.0' })

    const root = join(workspace, '.iax', 'workflows', 'evolve')
    const archived = JSON.parse(readFileSync(join(root, 'versions', '1.0.0', 'manifest.json'), 'utf8'))
    assert.equal(archived.version, '1.0.0')
    assert.match(readFileSync(join(root, 'versions', '1.0.0', 'workflow.py'), 'utf8'), /print\("one"\)/)
    assert.equal(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version, '1.1.0')
    assert.match(readFileSync(join(root, 'workflow.py'), 'utf8'), /print\("two"\)/)

    const listed = await call(tools, 'iam_workflow_list', { workspace })
    const entry = listed.json.workflows.find((workflow) => workflow.name === 'evolve')
    assert.equal(entry.version, '1.1.0')
    assert.deepEqual(entry.versions, ['1.0.0'])
  })

  test('an equal or lower version is refused, and both versions are named', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    await call(tools, 'iam_workflow_freeze', {
      name: 'evolve', run, workspace, confirmed: true,
      manifest: contract({ version: '1.1.0' }),
    })
    for (const version of ['1.1.0', '0.9.0']) {
      await assert.rejects(
        () => call(tools, 'iam_workflow_freeze', {
          name: 'evolve', run, workspace, confirmed: true,
          manifest: contract({ version }),
        }),
        (error) => {
          assert.match(error.message, new RegExp(`at version ${version.replaceAll('.', '\\.')}`))
          assert.match(error.message, /already frozen at 1\.1\.0/)
          return true
        },
      )
    }
  })

  test('a directory with no recorded version keeps the old refusal', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    const legacy = join(workspace, '.iax', 'workflows', 'legacy')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'workflow.py'), 'def run(**kwargs):\n    return {}\n')
    writeFileSync(join(legacy, 'manifest.json'), JSON.stringify({
      workflow_version: 1, name: 'legacy', entry: 'workflow.py',
      title: 't', answers: 'a', inputs: {}, steps: [], acceptance: [],
    }))
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'legacy', run, workspace, confirmed: true,
        manifest: contract({ version: '9.9.9' }),
      }),
      /already exists and its manifest records no version/,
    )
  })

  test('a workflow target that resolves outside the root is refused', async (t) => {
    const workspace = mkdtemp('bridge-ws-')
    const outside = mkdtemp('bridge-outside-')
    const workflows = join(workspace, '.iax', 'workflows')
    mkdirSync(workflows, { recursive: true })
    const link = join(workflows, 'escape')
    try {
      symlinkSync(outside, link, 'junction')
    } catch (error) {
      t.skip(`directory links are not available here: ${error.message}`)
      return
    }
    const tools = mount({ workspace })
    const run = await frozenRun(workspace)
    await assert.rejects(
      () => call(tools, 'iam_workflow_freeze', {
        name: 'escape', run, workspace, confirmed: true, manifest: contract(),
      }),
      /outside the workflow root/,
    )
  })
})

describe('a run records the files it produced', () => {
  function recordOf(ran) {
    return JSON.parse(readFileSync(join(ran.json.record.directory, 'run.json'), 'utf8'))
  }

  test('a written file is listed with its size, mtime and a matching hash', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const ran = await call(tools, 'iam_program_run', {
      workspace,
      code: [
        'import json, os',
        'from pathlib import Path',
        "root = Path(os.environ['IAX_EXECUTION_WORKSPACE'])",
        "(root / 'out' / 'x').mkdir(parents=True, exist_ok=True)",
        "(root / 'out' / 'x' / 'result.json').write_text(json.dumps({'volume': 1.0441e8}), encoding='utf-8')",
      ].join('\n'),
    })
    const record = recordOf(ran)
    const entry = record.artifacts.find((artifact) => artifact.path === 'out/x/result.json')
    assert.ok(entry, 'the file the run wrote is not in the record')
    assert.equal(entry.bytes, readFileSync(join(workspace, 'out', 'x', 'result.json')).length)
    assert.match(entry.mtime, /^\d{4}-\d\d-\d\dT/)
    const expected = createHash('sha256')
      .update(readFileSync(join(workspace, 'out', 'x', 'result.json'))).digest('hex').slice(0, 16)
    assert.equal(entry.sha256_16, expected)
    assert.equal(record.artifacts_truncated, false)
  })

  test('a run that writes nothing records an empty list, not a missing field', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const ran = await call(mount({ workspace }), 'iam_program_run',
      { workspace, code: 'print(sum(range(10)))' })
    const record = recordOf(ran)
    assert.deepEqual(record.artifacts, [])
    assert.equal(record.artifacts_truncated, false)
  })

  test('a pre-existing file the run changes is a product of that run', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const notes = join(workspace, 'notes.txt')
    writeFileSync(notes, 'before\n')
    const ran = await call(mount({ workspace }), 'iam_program_run', {
      workspace,
      code: [
        'import os',
        'from pathlib import Path',
        "root = Path(os.environ['IAX_EXECUTION_WORKSPACE'])",
        "with (root / 'notes.txt').open('a', encoding='utf-8') as stream:",
        '    stream.write("after")',
        '    stream.write(chr(10))',
      ].join('\n'),
    })
    const record = recordOf(ran)
    assert.equal(record.artifacts.length, 1)
    assert.equal(record.artifacts[0].path, 'notes.txt')
    // Text mode writes CRLF on Windows; the newline is not what is under test.
    assert.match(readFileSync(notes, 'utf8'), /^before\nafter\r?\n$/)
  })

  test('two runs of one program produce the same record apart from time and products', async () => {
    const workspace = mkdtemp('bridge-ws-')
    const tools = mount({ workspace })
    const run = () => call(tools, 'iam_program_run', { workspace, code: 'print("same")\n' })
    const first = recordOf(await run())
    const second = recordOf(await run())
    const reduced = (record) => JSON.stringify(
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'started' && key !== 'artifacts')),
    )
    assert.equal(reduced(first), reduced(second))
    assert.deepEqual(first.artifacts, [])
    assert.deepEqual(second.artifacts, [])
  })
})
