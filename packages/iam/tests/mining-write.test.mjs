import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { cleanup, fakeTools, loadToolHost, mkdtemp } from './helpers.mjs'

after(cleanup)

const repository = await loadToolHost('mining-repository')
const { apply } = repository.index

const PROJECT = 'D:/dev/MiningFlatform/workspace/test1.iam'
const STORE = 'D:/dev/MiningFlatform/workspace/test2.iamh'
const OREBODY = 'merge-1-dimine-36-entity-0'
const PLATFORM = existsSync(PROJECT)
const SKIP = 'needs the built platform and D:/dev/MiningFlatform/workspace/test1.iam'

function mount(config = {}, workingDirectory, carrier) {
  const tools = fakeTools()
  const ctx = {
    tools,
    effect: (fn) => fn(),
    inject: (deps, fn) => {
      const scope = {}
      if (workingDirectory !== undefined) scope.workingDirectory = { ensure: async () => workingDirectory }
      if (carrier !== undefined) scope.profileContext = { name: carrier }
      return fn(scope)
    },
  }
  apply(ctx, config)
  return tools
}

function exec() {
  return { signal: new AbortController().signal, agent: { id: 'session' } }
}

/** One call, through the registered definition, exactly as the Harness makes it. */
async function call(tools, tool, args, agent) {
  const definition = tools.registered.get(tool)
  assert.ok(definition, `${tool} is not registered`)
  const value = await definition.execute(args, exec(agent))
  assert.ok(value !== null && typeof value === 'object', 'the tool must return an object value')
  assert.equal(value.content, undefined, `${tool} returned a content envelope`)
  const text = definition.output.render(args, value)[0].text
  return { value, text }
}

/**
 * A private copy of the reference mine, in its own workspace.
 *
 * Returns the workspace and the workspace-RELATIVE project name, because a
 * relative path is what the tools resolve against the session's directory and a
 * test that used the absolute one would not exercise that.
 */
function scratch(name = 'mine.iam') {
  const workspace = mkdtemp('iam-write-')
  copyFileSync(PROJECT, join(workspace, name))
  return { workspace, project: name, path: join(workspace, name) }
}

/** A tiny payload that is reachable only if it is attached -- see below. */
const PROBE = {
  put: { point_sets: [{ id: 'probe-1', name: 'probe', points: [{ x: 0, y: 0, z: 0 }] }] },
  attach: [{ element: OREBODY, geometry: ['probe-1'] }],
}

describe('the write door: what is decided before anything runs', () => {
  test('an edit that names nothing to change is refused, and says so about the argument', async () => {
    const tools = mount({}, 'D:/dev/MiningFlatform/workspace')
    const { value } = await call(tools, 'iam_mine_edit', { project: 'test1.iam' })
    assert.equal(value.ok, false)
    assert.match(String(value.refused), /put.*attach.*erase/)
  })

  test('a project outside the session workspace is refused by an edit and by an apply', async () => {
    // A read may name any project on the machine.  A write may not: the session's
    // workspace is the boundary its other paths resolve against, and this is the
    // check that keeps "edit my mine" from meaning "edit any file".
    const tools = mount({}, 'D:/somewhere/else')
    for (const [tool, args] of [
      ['iam_mine_edit', { project: PROJECT, ...PROBE }],
      ['iam_mine_verb', { project: PROJECT, code: 'def run(port): pass' }],
      ['iam_mine_apply', { project: PROJECT, document: 'x.iaxd' }],
    ]) {
      const { value } = await call(tools, tool, args)
      assert.equal(value.ok, false, `${tool} should have refused`)
      assert.match(String(value.refused), /outside the session workspace/, tool)
    }
  })

  test('an erase type outside the vocabulary is refused before the host is spawned', async () => {
    // The schema's enum does not offer `frame`, and a project has exactly one --
    // removing it is not a state a project can be in.  An enum is a hint to the
    // model rather than a constraint on the call, so the refusal has to exist;
    // this one arrives as a thrown tool error because the caller's DESCRIPTION
    // is wrong, which is the same class as a missing required argument.
    const tools = mount({}, 'D:/dev/MiningFlatform/workspace')
    const definition = tools.registered.get('iam_mine_edit')
    await assert.rejects(
      () => definition.execute({ project: 'test1.iam', erase: [{ type: 'frame', id: 'f-1' }] }, exec()),
      /"erase" type must be one of/)
    await assert.rejects(
      () => definition.execute({ project: 'test1.iam', erase: [{ type: 'surface' }] }, exec()),
      /needs a non-empty "id"/)
  })

  test('with no workspace at all, every write is refused rather than placed somewhere', async () => {
    // The read half answers "no such project" here, which is a fine answer about
    // a file.  A write cannot give that answer: resolving against whatever
    // directory the interpreter started in would edit a file nobody named.
    const tools = mount()
    for (const [tool, args] of [
      ['iam_mine_edit', { project: 'mine.iam', ...PROBE }],
      ['iam_mine_apply', { project: 'mine.iam', document: 'mine.iaxd' }],
    ]) {
      const { value } = await call(tools, tool, args)
      assert.equal(value.ok, false, `${tool} should have refused`)
      assert.match(String(value.refused), /no working directory/, tool)
    }
  })

  test('a verb is refused where no program runner is configured', { skip: !PLATFORM && SKIP }, async () => {
    // Running a verb means running code this session wrote, so it needs a
    // sandbox.  The refusal is the deployment fact, stated as one -- and the
    // message also says which tool needs no sandbox, because the model's next
    // move should not be to guess.
    const { workspace, project } = scratch()
    const tools = mount({}, workspace)
    const { value } = await call(tools, 'iam_mine_verb', {
      project, code: 'def run(port):\n    pass\n',
    })
    assert.equal(value.ok, false)
    assert.match(String(value.refused), /programRunner/)
  })
})

describe('the edit half publishes nothing', () => {
  test('an edit writes a document and leaves the project byte-identical',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project, path } = scratch()
      const before = statSync(path)
      const bytesBefore = readFileSync(path)

      const tools = mount({}, workspace)
      const { value, text } = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(value.ok, true, `expected a document, got: ${String(value.refused ?? '')}`)

      // THE DOCUMENT IS THE ARTIFACT, and it is read back from its own bytes --
      // so its counts are what a reviewer would see, not what this file intended.
      assert.equal(value.document, 'mine.iaxd')
      assert.ok(existsSync(join(workspace, 'mine.iaxd')), 'the review document was not written')
      // IDS, not counts: the assertion is worth having only because it names the
      // element the cascade rewrote as well as the point set that was put.
      assert.deepEqual(value.replaces, [
        { kind: 'elements', id: OREBODY },
        { kind: 'point_sets', id: 'probe-1' },
      ])
      assert.deepEqual(value.erases, [])
      assert.equal(value.container, 'iam')
      assert.match(text, /未发布/)

      // AND NOTHING WAS PUBLISHED.  Compared by content and by timestamp: a save
      // that rewrote identical bytes would still be a write, and the whole claim
      // of this half is that there was not one.
      const after_ = statSync(path)
      assert.equal(after_.size, before.size)
      assert.equal(after_.mtimeMs, before.mtimeMs)
      assert.ok(readFileSync(path).equals(bytesBefore), 'the project was modified by an edit')
    })

  test('the document names the revision it was written against, and the project is still on it',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project } = scratch()
      const tools = mount({}, workspace)
      const { value } = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(value.ok, true, String(value.refused ?? ''))
      assert.equal(typeof value.base_revision, 'number')
      assert.match(String(value.nothing_published), new RegExp(`revision ${value.base_revision}`))

      // Read back through the READ half, which is an independent path to the same
      // fact: the project still reports the revision the document was written at.
      const resolved = await call(tools, 'iam_mining_show', { project, elements: [OREBODY] })
      assert.equal(resolved.value.revision, value.base_revision)
    })
})

describe('a document can be read before it is published', () => {
  test('reading a document needs no project, and names every resource it touches',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project } = scratch()
      const tools = mount({}, workspace)
      const edited = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(edited.value.ok, true, String(edited.value.refused ?? ''))

      // NO PROJECT IN THE ARGUMENTS.  A document names the one it is for, and the
      // first question about an edit someone hands you is whether it is for the
      // mine you have -- which its header answers without opening either file.
      const read = await call(tools, 'iam_mine_document', { document: 'mine.iaxd' })
      assert.equal(read.value.ok, true, String(read.value.refused ?? ''))
      assert.equal(read.value.project_id, edited.value.project_id)
      assert.equal(read.value.base_revision, edited.value.base_revision)
      assert.deepEqual(read.value.replaces, edited.value.replaces)
      assert.deepEqual(read.value.erases, edited.value.erases)

      // And reading it changed nothing: the project is still where it was.
      const resolved = await call(tools, 'iam_mining_show', { project, elements: [OREBODY] })
      assert.equal(resolved.value.revision, edited.value.base_revision)
    })

  test('resources:true carries the new values, not just the ids',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project } = scratch()
      const tools = mount({}, workspace)
      const edited = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(edited.value.ok, true, String(edited.value.refused ?? ''))

      const plain = await call(tools, 'iam_mine_document', { document: 'mine.iaxd' })
      assert.equal(plain.value.resources, undefined, 'the JSON is not carried unless it is asked for')

      const full = await call(tools, 'iam_mine_document', { document: 'mine.iaxd', resources: true })
      assert.equal(full.value.ok, true, String(full.value.refused ?? ''))
      assert.equal(full.value.resources_omitted, undefined)
      // The point set's own coordinates, which is the thing "replaces point_sets
      // probe-1" does not say and a reviewer may actually need.
      const pointSets = full.value.resources.point_sets
      assert.equal(pointSets.length, 1)
      assert.equal(pointSets[0].id, 'probe-1')
      assert.deepEqual(pointSets[0].points, [{ x: 0, y: 0, z: 0 }])
    })

  test('a document that is not there is refused by name', async () => {
    const tools = mount({}, 'D:/dev/MiningFlatform/workspace')
    const { value } = await call(tools, 'iam_mine_document', { document: 'no-such.iaxd' })
    assert.equal(value.ok, false)
    assert.match(String(value.refused), /no such document/)
  })
})

describe('the publish half changes the project, once', () => {
  test('apply publishes the document as the next revision, in place',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project, path } = scratch()
      const tools = mount({}, workspace)

      const edited = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(edited.value.ok, true, String(edited.value.refused ?? ''))
      const documentPath = join(workspace, 'mine.iaxd')
      const documentBytes = readFileSync(documentPath)

      const applied = await call(tools, 'iam_mine_apply', { project, document: 'mine.iaxd' })
      assert.equal(applied.value.ok, true, String(applied.value.refused ?? ''))
      assert.equal(applied.value.in_place, true, 'the default is in place: no second copy appears')
      assert.equal(applied.value.out.replace(/\\/g, '/'), path.replace(/\\/g, '/'))
      assert.ok(applied.value.revision > edited.value.base_revision,
        'the revision did not advance')

      // THE CHANGE IS REALLY THERE, read through the read half rather than
      // through the write half that made it: the point set is now one of the
      // orebody's geometries, which is also the proof that `attach` ran.
      const resolved = await call(tools, 'iam_mining_show', { project, elements: [OREBODY] })
      assert.equal(resolved.value.ok, true, String(resolved.value.refused ?? ''))
      assert.ok(resolved.value.elements[0].geometry_ids.includes('probe-1'),
        `probe-1 is not attached: ${JSON.stringify(resolved.value.elements[0].geometry_ids)}`)

      // The document survives the publish: it is the record of what was applied,
      // and it is what someone reading the history afterwards will look for.
      assert.ok(readFileSync(documentPath).equals(documentBytes))

      // AND THERE IS STILL ONLY ONE MINE.  In place means the project the
      // document named is the file that changed -- a second copy beside it would
      // be the "derived document" design this plugin deliberately dropped, and it
      // would make "which one is the mine" a question with two answers.
      const siblings = readdirSync(workspace).filter((entry) => entry.endsWith('.iam') || entry.endsWith('.iamh'))
      assert.deepEqual(siblings, ['mine.iam'])
      assert.ok(statSync(path).size > 0)
    })

  test('a document addressed to another revision is refused, naming both',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project } = scratch()
      const tools = mount({}, workspace)

      const first = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(first.value.ok, true, String(first.value.refused ?? ''))
      copyFileSync(join(workspace, 'mine.iaxd'), join(workspace, 'stale.iaxd'))

      // Move the project on, so the document is now about a revision it has left.
      const applied = await call(tools, 'iam_mine_apply', { project, document: 'stale.iaxd' })
      assert.equal(applied.value.ok, true, String(applied.value.refused ?? ''))

      const stale = await call(tools, 'iam_mine_apply', { project, document: 'mine.iaxd' })
      assert.equal(stale.value.ok, false, 'a stale document must not be applied')
      assert.equal(stale.value.revision, undefined)
      assert.match(String(stale.value.refused), new RegExp(String(first.value.base_revision)),
        'the refusal must name the revision the document was written against')
    })

  test('apply touches only the file it was given, not the one the document came from',
    { skip: !PLATFORM && SKIP }, async () => {
      // The document carries a project ID, not a file name, so a byte-identical
      // copy of the same mine is the same project to it -- which is the point:
      // a document is addressed to a PROJECT, and where it is applied is decided
      // by the call.  What this pins is that answering "is this the right mine"
      // does not smuggle in "and write the one I read it beside".
      const { workspace, project, path } = scratch()
      const tools = mount({}, workspace)

      const edited = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(edited.value.ok, true, String(edited.value.refused ?? ''))
      copyFileSync(path, join(workspace, 'other.iam'))

      const applied = await call(tools, 'iam_mine_apply', { project: 'other.iam', document: 'mine.iaxd' })
      assert.equal(applied.value.ok, true, String(applied.value.refused ?? ''))
      assert.equal(applied.value.in_place, true)

      // The original is untouched -- same revision, same bytes -- while the copy
      // the call named is the one that moved.
      const original = await call(tools, 'iam_mining_show', { project, elements: [OREBODY] })
      assert.equal(original.value.revision, edited.value.base_revision)
      const copy = await call(tools, 'iam_mining_show', { project: 'other.iam', elements: [OREBODY] })
      assert.ok(copy.value.revision > edited.value.base_revision)
    })

  test('an erase cascades: the element that named the geometry is rewritten too',
    { skip: !PLATFORM && SKIP }, async () => {
      const { workspace, project } = scratch()
      const tools = mount({}, workspace)

      const added = await call(tools, 'iam_mine_edit', { project, ...PROBE })
      assert.equal(added.value.ok, true, String(added.value.refused ?? ''))
      const published = await call(tools, 'iam_mine_apply', { project, document: 'mine.iaxd' })
      assert.equal(published.value.ok, true, String(published.value.refused ?? ''))

      const removed = await call(tools, 'iam_mine_edit', {
        project, erase: [{ type: 'point_set', id: 'probe-1' }],
      })
      assert.equal(removed.value.ok, true, String(removed.value.refused ?? ''))
      assert.deepEqual(removed.value.erases, [{ type: 'point_set', id: 'probe-1' }])
      // The cascade is the PLATFORM's, and it is visible in the document: the
      // element that referenced the point set has to be rewritten without it, or
      // the project would not validate.  A document that listed only the removal
      // would be an edit that cannot be applied.
      assert.ok(removed.value.replaces.some((entry) => entry.kind === 'elements'),
        `the cascade is missing from the document: ${JSON.stringify(removed.value.replaces)}`)

      const applied = await call(tools, 'iam_mine_apply', { project, document: 'mine.iaxd' })
      assert.equal(applied.value.ok, true, String(applied.value.refused ?? ''))
      const resolved = await call(tools, 'iam_mining_show', { project, elements: [OREBODY] })
      assert.ok(!resolved.value.elements[0].geometry_ids.includes('probe-1'),
        'the erased geometry is still attached')
    })
})

describe('a columnar store is written back in its own container', () => {
  test('an edit and an apply on a .iamh leave a .iamh that reads',
    { skip: !(PLATFORM && existsSync(STORE)) && 'needs both test1.iam and test2.iamh' }, async () => {
      // The write half was portable-only until iamSnapshotSaveFileAs existed:
      // a .iamh could be opened and not written back, and the failure would have
      // been a .iam written where a store was asked for.  What this pins is that
      // the container follows the FILE NAME through the whole round trip.
      const workspace = mkdtemp('iam-write-')
      copyFileSync(STORE, join(workspace, 'store.iamh'))
      const tools = mount({}, workspace)

      const edited = await call(tools, 'iam_mine_edit', {
        project: 'store.iamh',
        put: { point_sets: [{ id: 'probe-1', name: 'probe', points: [{ x: 0, y: 0, z: 0 }] }] },
        attach: [{ element: OREBODY, geometry: ['probe-1'] }],
      })
      assert.equal(edited.value.ok, true, String(edited.value.refused ?? ''))
      assert.equal(edited.value.container, 'iamh')
      assert.equal(edited.value.document, 'store.iaxd')

      const applied = await call(tools, 'iam_mine_apply', { project: 'store.iamh', document: 'store.iaxd' })
      assert.equal(applied.value.ok, true, String(applied.value.refused ?? ''))
      assert.equal(applied.value.container, 'iamh', 'the store was written back as a .iam')
      assert.ok(applied.value.revision > edited.value.base_revision)

      // THE READ-BACK INSIDE apply IS THE PROOF, and deliberately not
      // `iam_mining_show`: that tool refuses a columnar store on the web carrier
      // for a reason that has nothing to do with the write door (the wasm view
      // links no HDF5), so asking it here would test the carrier rather than the
      // save.  apply re-opens the file it just wrote and reports the container it
      // found there -- which is only answerable if the bytes are a store this
      // platform can load.
      const second = await call(tools, 'iam_mine_edit', {
        project: 'store.iamh',
        put: { point_sets: [{ id: 'probe-2', name: 'probe 2', points: [{ x: 1, y: 0, z: 0 }] }] },
        attach: [{ element: OREBODY, geometry: ['probe-2'] }],
      })
      assert.equal(second.value.ok, true, String(second.value.refused ?? ''))
      assert.equal(second.value.base_revision, applied.value.revision,
        'the store that was written back is not the revision the apply committed')
    })
})
