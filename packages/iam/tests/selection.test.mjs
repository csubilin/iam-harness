import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { cleanup, loadHost } from './helpers.mjs'

after(cleanup)

const drawing = await loadHost('views')
const { ViewEventStore, validateViewEvent, VIEW_EVENT_SCHEMA } = drawing.events
const { viewSelectionTool, viewRecentEditsTool } = drawing.tools

const ADDRESS = 'dsh-resource://file/session/s/sheet.iamp'

/** A store with one live page instance, and the binding that may write to it. */
function harness(documentName = 'sheet.iamp') {
  const store = new ViewEventStore(() => undefined)
  const instance = store.openInstance({ kind: 'page', sessionId: 's', address: ADDRESS, documentName })
  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: ADDRESS, documentName,
    instanceId: instance.instanceId, purposes: ['events'], expiresAt: Date.now() + 60_000, singleUse: false, spent: false,
  }
  return { store, binding, instance }
}

/** One page of a selection, as the C++ channel now emits it. */
function page(version, offset, refs, options = {}) {
  return {
    schema: VIEW_EVENT_SCHEMA,
    eventId: `page#${version}.${offset}`,
    sequence: offset + 1,
    kind: 'selection.changed',
    view: { id: 'drawing.browse', domain: 'drawing', mode: 'browse', is3d: false },
    document: { name: 'sheet.iamp', hasRevision: false },
    selection: {
      version,
      count: options.count ?? refs.length,
      truncated: options.truncated === true,
      offset,
      more: options.more === true,
      refs: refs.map((value) => ({ kind: 'handle', value })),
    },
  }
}

/** Feed one page through the validator and the store, as the route does. */
function feed(store, binding, raw, source = 'wasm') {
  const validation = validateViewEvent(raw, source)
  assert.ok(!('error' in validation), validation.error)
  return store.ingest(binding, validation.event, source)
}

/** The tool, wired to the store the way `host/index.ts` wires it. */
function toolFor(store, prefix = 'iam_drawing', tools = undefined) {
  const lookup = () => {
    const state = store.activeFor('s')
    if (state === undefined) return { error: 'no state' }
    return { state }
  }
  return {
    selection: viewSelectionTool(lookup, prefix, tools),
    edits: viewRecentEditsTool(lookup, prefix, tools),
  }
}

/** The two rows of `host/domains.ts`, as the text sees them. */
const DRAWING_TOOLS = { describeTool: 'describe_drawing' }
const MINING_TOOLS = { describeTool: 'iam_mine_describe', openTool: 'iam_mining_show' }

const EXEC = { agent: { id: 's' } }

/** 531 references, in three pages -- the size the README measured by hand. */
function feedLargeSelection(store, binding, { truncated = false } = {}) {
  const total = 531
  const refs = Array.from({ length: total }, (_, index) => `CE${index.toString(16).toUpperCase()}`)
  feed(store, binding, page(7, 0, refs.slice(0, 256), { count: total, more: true, truncated }))
  feed(store, binding, page(7, 256, refs.slice(256, 512), { count: total, more: true, truncated }))
  feed(store, binding, page(7, 512, refs.slice(512), { count: total, more: false, truncated }))
  return refs
}

test('three pages assemble into the whole selection', () => {
  const { store, binding } = harness()
  const refs = feedLargeSelection(store, binding)
  const selection = store.activeFor('s').selection
  assert.equal(selection.count, 531)
  assert.equal(selection.refs.length, 531)
  assert.equal(selection.reported, 531)
  assert.equal(selection.complete, true)
  assert.equal(selection.truncated, false, 'a complete set was reported as withheld')
  assert.deepEqual(selection.refs.map((ref) => ref.value), refs)
})

test('a half-arrived selection is not complete, and says so', () => {
  const { store, binding } = harness()
  const refs = Array.from({ length: 531 }, (_, index) => `CE${index}`)
  feed(store, binding, page(7, 0, refs.slice(0, 256), { count: 531, more: true }))
  const selection = store.activeFor('s').selection
  assert.equal(selection.complete, false, 'two thirds of a selection was reported as the whole thing')
  assert.equal(selection.count, 531, 'the count is the view\'s own and is final whatever has arrived')
  assert.equal(selection.reported, 256)
})

test('pages that arrive out of order are assembled in order, not appended', () => {
  // A cursor into this list means an INDEX, so appending out of order would put
  // references where the caller is not looking.
  const { store, binding } = harness()
  const refs = Array.from({ length: 531 }, (_, index) => `CE${index}`)
  feed(store, binding, page(7, 512, refs.slice(512), { count: 531, more: false }))
  assert.equal(store.activeFor('s').selection.complete, false, 'a gap was closed by the last page arriving first')
  feed(store, binding, page(7, 256, refs.slice(256, 512), { count: 531, more: true }))
  feed(store, binding, page(7, 0, refs.slice(0, 256), { count: 531, more: true }))
  const selection = store.activeFor('s').selection
  assert.equal(selection.complete, true)
  assert.deepEqual(selection.refs.map((ref) => ref.value), refs)
})

test('a page resent after a reconnect is not appended twice', () => {
  const { store, binding } = harness()
  const refs = Array.from({ length: 300 }, (_, index) => `CE${index}`)
  feed(store, binding, page(7, 0, refs.slice(0, 256), { count: 300, more: true }))
  // The same page again, with a different event id: the host has to notice by
  // OFFSET, because a retry is a new event id by construction.
  feed(store, binding, page(7, 0, refs.slice(0, 256), { count: 300, more: true }))
  feed(store, binding, page(7, 256, refs.slice(256), { count: 300, more: false }))
  assert.equal(store.activeFor('s').selection.refs.length, 300)
})

test('a view that withheld references is truncated even when the pages are whole', () => {
  const { store, binding } = harness()
  feedLargeSelection(store, binding, { truncated: true })
  const selection = store.activeFor('s').selection
  assert.equal(selection.complete, true, 'the pages that were sent all arrived')
  assert.equal(selection.truncated, true, 'the view capped the set and the cap was reported as complete')
})

test('a newer version starts over rather than mixing two selections', () => {
  const { store, binding } = harness()
  feed(store, binding, page(7, 0, ['A', 'B'], { count: 2, more: false }))
  feed(store, binding, page(8, 0, ['C'], { count: 1, more: false }))
  const selection = store.activeFor('s').selection
  assert.equal(selection.version, 8)
  assert.deepEqual(selection.refs.map((ref) => ref.value), ['C'])
})

test('a cursor reads the whole set, and the three flags keep their meanings', async () => {
  const { store, binding } = harness()
  const refs = feedLargeSelection(store, binding)
  const tool = toolFor(store)

  const collected = []
  let offset = 0
  for (;;) {
    const answer = await tool.selection.execute({ offset, limit: 200 }, EXEC)
    collected.push(...answer.selection.refs.map((ref) => ref.value))
    if (answer.page.exhausted) {
      assert.equal(answer.page.returned, 131)
      // The last answer reached the end of the host's list AND that list is the
      // whole selection. The two are separate facts and both are reported.
      assert.equal(answer.selection.complete, true)
      assert.equal(answer.selection.truncated, false)
      break
    }
    assert.equal(answer.selection.complete, true)
    offset += answer.page.returned
  }
  assert.deepEqual(collected, refs)
})

test('the last page of a half-arrived selection is exhausted but not complete', async () => {
  const { store, binding } = harness()
  const refs = Array.from({ length: 531 }, (_, index) => `CE${index}`)
  feed(store, binding, page(7, 0, refs.slice(0, 256), { count: 531, more: true }))
  const answer = await toolFor(store).selection.execute({ limit: 200, offset: 56 }, EXEC)
  assert.equal(answer.page.exhausted, true, 'this answer reached the end of what the host holds')
  assert.equal(answer.selection.complete, false, 'and what the host holds is not the whole selection')
  assert.equal(answer.selection.reported, 256)
  assert.match(answer.pending, /分页传输中/)
})

test('a version that has moved on is reported rather than paged through', async () => {
  const { store, binding } = harness()
  feed(store, binding, page(7, 0, ['A', 'B'], { count: 2, more: false }))
  const tool = toolFor(store)
  const fresh = await tool.selection.execute({ version: 7 }, EXEC)
  assert.equal(fresh.stale, undefined, 'the version in hand was reported as moved on')

  feed(store, binding, page(8, 0, ['C', 'D', 'E'], { count: 3, more: false }))
  const stale = await tool.selection.execute({ version: 7, offset: 0 }, EXEC)
  assert.deepEqual(stale.stale, { requested: 7, current: 8 })
  // The current page still comes back, so a caller can carry on in one round
  // trip instead of having to rediscover the version.
  assert.equal(stale.selection.version, 8)
  assert.deepEqual(stale.selection.refs.map((ref) => ref.value), ['C', 'D', 'E'])
})

test('a version asked for when there is no selection at all is stale with nothing current', async () => {
  const { store } = harness()
  const answer = await toolFor(store).selection.execute({ version: 4 }, EXEC)
  assert.equal(answer.selection, null)
  assert.deepEqual(answer.stale, { requested: 4, current: null })
})

test('a bounded set does not go through the paging machinery at all', async () => {
  const { store, binding } = harness()
  feed(store, binding, page(1, 0, ['A'], { count: 1, more: false }))
  const answer = await toolFor(store).selection.execute({}, EXEC)
  assert.equal(answer.selection.complete, true)
  assert.equal(answer.selection.truncated, false)
  assert.equal(answer.page.exhausted, true)
  assert.equal(answer.pending, undefined)
})

test('both tools are named for their domain, and neither name is the other\'s', () => {
  const drawingTools = toolFor(harness().store, 'iam_drawing')
  const miningTools = toolFor(harness().store, 'iam_mining')
  assert.equal(drawingTools.selection.name, 'iam_drawing_view_selection')
  assert.equal(drawingTools.edits.name, 'iam_drawing_view_recent_edits')
  assert.equal(miningTools.selection.name, 'iam_mining_view_selection')
  assert.equal(miningTools.edits.name, 'iam_mining_view_recent_edits')
})

test('the text says how a preview is mounted, and the two domains differ', () => {
  // The sentence this replaces said a preview happens when the USER opens the
  // file and that no tool call can mount one. A tool call can -- Mining's
  // `iam_mining_show` opens the project in the panel -- so a model that believed
  // it told the user to do something it had a tool for.
  const mining = toolFor(harness().store, 'iam_mining', MINING_TOOLS)
  for (const tool of [mining.selection, mining.edits]) {
    assert.match(tool.description, /MOUNTED/, `${tool.name} does not say a preview must be mounted`)
    assert.match(tool.description, /`iam_mining_show` opens it in the PANEL/)
    assert.match(tool.description, /NATIVE editor/)
  }
  // And the other domain is not told about a tool it does not have: Drawing
  // publishes nothing that mounts a pane, so its text must not offer one.
  const drawing = toolFor(harness().store, 'iam_drawing', DRAWING_TOOLS)
  for (const tool of [drawing.selection, drawing.edits]) {
    assert.doesNotMatch(tool.description, /iam_mining_show/)
    assert.match(tool.description, /the user opens it in the page/)
  }
  // Each names its OWN document reader, which is what the domain table is for.
  assert.match(drawing.selection.description, /`describe_drawing` reads it/)
  assert.match(mining.selection.description, /`iam_mine_describe` reads it/)
})

test('the edits tool carries the gap a client had to report', async () => {
  const { store, binding } = harness()
  store.recordGaps(store.activeFor('s'), { droppedFacts: 2, droppedByKind: { 'edit.committed': 2 } }, 'wasm')
  feed(store, binding, {
    schema: VIEW_EVENT_SCHEMA,
    eventId: 'e#1',
    kind: 'edit.committed',
    view: { id: 'drawing.browse', domain: 'drawing', mode: 'browse', is3d: false },
    document: { name: 'sheet.iamp', hasRevision: false },
    edit: { operation: 'erase', before: '1 object(s) affected', after: 'erase of 1 object', refs: [{ kind: 'handle', value: 'CE5' }], truncated: false },
  })
  const answer = await toolFor(store).edits.execute({}, EXEC)
  assert.equal(answer.gaps.droppedFacts, 2)
  assert.equal(answer.gaps.droppedByKind['edit.committed'], 2)
  assert.equal(answer.total, 1)
  assert.equal(answer.unsaved, 1)
})

test('an edit is never superseded by a newer selection', () => {
  const { store, binding } = harness()
  feed(store, binding, {
    schema: VIEW_EVENT_SCHEMA,
    eventId: 'e#1',
    kind: 'edit.committed',
    view: { id: 'drawing.browse', domain: 'drawing', mode: 'browse', is3d: false },
    document: { name: 'sheet.iamp', hasRevision: false },
    edit: { operation: 'erase', refs: [], truncated: false },
  })
  feed(store, binding, page(9, 0, ['A'], { count: 1, more: false }))
  const state = store.activeFor('s')
  assert.equal(state.edits.length, 1)
  assert.equal(state.selection.version, 9)
})
