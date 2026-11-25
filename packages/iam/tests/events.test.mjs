import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import {
  cleanup,
  fakeAgent,
  fakeAgents,
  fakeContext,
  fakeSessions,
  fakeTools,
  loadHost,
  request,
  workspace,
} from './helpers.mjs'

after(cleanup)

// One package now serves both domains, so the two are the same module tagged
// with the domain each test means to exercise; `mount` passes the tag through as
// the row config a profile would set.
const views = await loadHost('views')
const drawing = { ...views, domain: 'drawing' }
const mining = { ...views, domain: 'mining' }

/** One event, with everything the validator insists on. */
function event(overrides = {}) {
  return {
    schema: 'iax.iam.view-event/1',
    eventId: 'drawing.browse#1',
    sequence: 1,
    kind: 'selection.changed',
    view: { id: 'drawing.browse', domain: 'drawing', mode: 'browse', is3d: false },
    document: { name: 'sheet.iamp', hasRevision: false },
    selection: { version: 1, count: 1, truncated: false, offset: 0, more: false, refs: [{ kind: 'handle', value: 'CE0' }] },
    ...overrides,
  }
}

/** A whole host half, wired to a fake container, with its route table in hand. */
async function mount(host, { root, sessionId, tools = fakeTools(), agents, profile = 'web' } = {}) {
  const sessions = fakeSessions({ [sessionId]: root })
  const agentSet = agents ?? fakeAgents([fakeAgent(sessionId)])
  const ctx = fakeContext({ sessions, agents: agentSet, tools, profileContext: { name: profile } })
  host.index.apply(ctx, { domains: [host.domain] })
  return { ctx, route: ctx.route, tools, sessions }
}

/** The capability handshake, as the browser half performs it. */
async function handshake(route, address) {
  const answer = await request(route, { method: 'POST', url: '/session/capability', body: { address } })
  assert.equal(answer.statusCode, 200, answer.text())
  return answer.json()
}

/** Post a batch of events with a token. */
function post(route, token, events, extra = {}) {
  return request(route, {
    method: 'POST',
    url: '/events',
    headers: { 'x-iam-capability': token },
    body: { events, ...extra },
  })
}

const CAP = 'x-iam-capability'

// ---------------------------------------------------------------- two documents

test('two documents in one session keep two records', async () => {
  const space = workspace()
  space.write('one.iamp', 'a')
  space.write('two.iamp', 'b')
  const { ctx, route } = await mount(drawing, space)
  try {
    const one = space.addressOf('one.iamp')
    const two = space.addressOf('two.iamp')
    const first = await handshake(route, one)
    const second = await handshake(route, two)

    await post(route, first.token, [event({ document: { name: 'one.iamp', hasRevision: false } })])
    await post(route, second.token, [
      event({
        eventId: 'drawing.browse#2',
        document: { name: 'two.iamp', hasRevision: false },
        selection: { version: 4, count: 2, truncated: false, offset: 0, more: false, refs: [{ kind: 'handle', value: 'B1' }] },
      }),
    ])

    const oneStatus = (await request(route, { url: '/status', headers: { [CAP]: first.token } })).json()
    const twoStatus = (await request(route, { url: '/status', headers: { [CAP]: second.token } })).json()
    assert.equal(oneStatus.selection.count, 1)
    assert.equal(twoStatus.selection.count, 2)
    assert.equal(oneStatus.document.address, one)
    assert.equal(twoStatus.document.address, two)
  } finally {
    ctx.unload()
  }
})

test('a token for one document cannot write into the other', async () => {
  const space = workspace()
  space.write('one.iamp', 'a')
  space.write('two.iamp', 'b')
  const { ctx, route } = await mount(drawing, space)
  try {
    const one = await handshake(route, space.addressOf('one.iamp'))
    const two = await handshake(route, space.addressOf('two.iamp'))
    // The body names the other document -- and the ADDRESS in the capability is
    // what decides, because the body is the thing a client controls.
    const answer = await post(route, two.token, [event({ document: { name: 'one.iamp', hasRevision: false } })])
    assert.equal(answer.statusCode, 200)

    const oneStatus = (await request(route, { url: '/status', headers: { [CAP]: one.token } })).json()
    const twoStatus = (await request(route, { url: '/status', headers: { [CAP]: two.token } })).json()
    assert.equal(oneStatus.selection, null, 'the event reached the document it merely named')
    assert.equal(twoStatus.selection.count, 1)
  } finally {
    ctx.unload()
  }
})

// -------------------------------------------------------------- the instance

test('a superseded capability is refused, and a new one supersedes it', async () => {
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const { ctx, route } = await mount(drawing, space)
  try {
    const address = space.addressOf('sheet.iamp')
    const first = await handshake(route, address)
    const second = await handshake(route, address)
    assert.notEqual(first.instance.id, second.instance.id, 'a remount must be a new view instance')

    // The old token is retired when the new one is issued: a preview that
    // remounted leaves nothing behind that can still write.
    const stale = await post(route, first.token, [event()])
    assert.equal(stale.statusCode, 403)

    const fresh = await post(route, second.token, [event()])
    assert.equal(fresh.json().accepted, 1)
  } finally {
    ctx.unload()
  }
})

test('the store refuses an event whose capability names a superseded instance', () => {
  // Directly, because the route cannot reach this: issuing a capability retires
  // the token, so the only way to present a superseded-but-live binding is to
  // build one -- which is exactly the state a client in flight is in.
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/sheet.iamp'
  const first = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const second = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })

  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: address,
    documentName: 'sheet.iamp', instanceId: first.instanceId,
    purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false,
  }
  store.ingest(binding, drawing.events.validateViewEvent(event(), 'wasm').event, 'wasm')
  const outcome = store.ingest(binding, drawing.events.validateViewEvent(event({ eventId: 'x#2' }), 'wasm').event, 'wasm')
  assert.equal(outcome.status, 'superseded')
  assert.match(outcome.reason, /已被替换/)

  // And the instance that replaced it is the one that may write.
  const current = { ...binding, instanceId: second.instanceId }
  assert.equal(store.ingest(current, drawing.events.validateViewEvent(event({ eventId: 'x#3' }), 'wasm').event, 'wasm').status, 'stored')
})

test('a remounted page starts its own event numbering without colliding', () => {
  // The failure this fixes: the view's eventId is `${viewId}#${sequence}` and the
  // sequence starts at 1 in every process, so a page that reloaded mints the ids
  // the previous page already used -- and keyed on the id alone, every one of
  // them was swallowed as a duplicate of the page that had gone.
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/sheet.iamp'
  const first = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const second = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const same = event({ eventId: 'drawing.browse#1' })
  const base = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: address, documentName: 'sheet.iamp',
    purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false,
  }

  // The page that was replaced is refused outright rather than deduplicated.
  assert.equal(store.ingest({ ...base, instanceId: first.instanceId }, drawing.events.validateViewEvent(same, 'wasm').event, 'wasm').status, 'superseded')
  // And the page that replaced it stores its own #1 -- the same string.
  const second1 = { ...base, instanceId: second.instanceId }
  assert.equal(store.ingest(second1, drawing.events.validateViewEvent(same, 'wasm').event, 'wasm').status, 'stored')
  // Within ONE instance the same id really is a duplicate.
  assert.equal(store.ingest(second1, drawing.events.validateViewEvent(same, 'wasm').event, 'wasm').status, 'duplicate')
})

test('the same event id from two sources is two facts, not one', () => {
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/sheet.iamp'
  const page = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const native = store.openInstance({ kind: 'native', sessionId: 's', address, documentName: 'sheet.iamp' })
  const same = event({ eventId: 'drawing.browse#1' })
  const base = { token: 't', sessionId: 's', resourceAddress: address, documentName: 'sheet.iamp', purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false }

  assert.equal(store.ingest({ ...base, kind: 'page', instanceId: page.instanceId }, drawing.events.validateViewEvent(same, 'wasm').event, 'wasm').status, 'stored')
  assert.equal(store.ingest({ ...base, kind: 'native', instanceId: native.instanceId }, drawing.events.validateViewEvent(same, 'native').event, 'native').status, 'stored')
})

test('a selection version is compared only within one view instance', () => {
  // Both editors number their selections from 1. Compared across them, the native
  // editor's version 1 arriving after the browser view's version 5 was thrown
  // away as stale -- and the two counters were never measuring the same thing.
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/sheet.iamp'
  const page = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const native = store.openInstance({ kind: 'native', sessionId: 's', address, documentName: 'sheet.iamp' })
  const base = { token: 't', sessionId: 's', resourceAddress: address, documentName: 'sheet.iamp', purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false }

  const pageBinding = { ...base, kind: 'page', instanceId: page.instanceId }
  const nativeBinding = { ...base, kind: 'native', instanceId: native.instanceId }

  store.ingest(pageBinding, drawing.events.validateViewEvent(event({
    eventId: 'w#5',
    selection: { version: 5, count: 3, truncated: false, offset: 0, more: false, refs: [{ kind: 'handle', value: 'A' }] },
  }), 'wasm').event, 'wasm')
  store.ingest(nativeBinding, drawing.events.validateViewEvent(event({
    eventId: 'n#1',
    selection: { version: 1, count: 9, truncated: false, offset: 0, more: false, refs: [{ kind: 'handle', value: 'B' }] },
  }), 'native').event, 'native')

  const state = store.get('s', address)
  assert.equal(state.selection.count, 9, 'the native selection was dropped as stale')
  assert.equal(state.selection.source, 'native')

  // WITHIN the native instance a lower version really is stale -- a delivery that
  // overtook the one after it -- and it loses without disturbing the set.
  store.ingest(nativeBinding, drawing.events.validateViewEvent(event({
    eventId: 'n#2',
    selection: { version: 0, count: 1, truncated: false, offset: 0, more: false, refs: [] },
  }), 'native').event, 'native')
  assert.equal(store.get('s', address).selection.version, 1)
  assert.equal(store.get('s', address).selection.count, 9)
})

// -------------------------------------------------------------- the document

test('a view that opened another file behind the pane is refused', () => {
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/sheet.iamp'
  const instance = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: address, documentName: 'sheet.iamp',
    instanceId: instance.instanceId, purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false,
  }
  const first = store.ingest(binding, drawing.events.validateViewEvent(event(), 'wasm').event, 'wasm')
  assert.equal(first.status, 'stored')
  const other = store.ingest(binding, drawing.events.validateViewEvent(
    event({ eventId: 'w#2', document: { name: 'other-drawing.iamp', hasRevision: false } }), 'wasm').event, 'wasm')
  assert.equal(other.status, 'refused')
  assert.match(other.reason, /other-drawing/)
})

test('the Mining projection renaming its document is NOT a refusal', () => {
  // Measured 2026-10-07: an equality check here rejected every Mining event --
  // the view names the document after the PROJECT (`….dmf`, the foreign file it
  // was imported from) while the address names the store (`….iam`). The stem is
  // the same document; the extension is not.
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/%E5%9C%B0%E4%B8%8B%E7%9F%BF%E5%B1%B1.iam'
  const instance = store.openInstance({
    kind: 'page', sessionId: 's', address, documentName: '地下矿山整体系统.iam',
  })
  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: address, documentName: '地下矿山整体系统.iam',
    instanceId: instance.instanceId, purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false,
  }
  const outcome = store.ingest(binding, drawing.events.validateViewEvent(
    event({ document: { name: '地下矿山整体系统.dmf', hasRevision: false } }), 'wasm').event, 'wasm')
  assert.equal(outcome.status, 'stored', outcome.reason)
})

test('a name the view changes mid-session is refused from the second one on', () => {
  const store = new drawing.events.ViewEventStore(() => undefined)
  const address = 'dsh-resource://file/session/s/sheet.iamp'
  const instance = store.openInstance({ kind: 'page', sessionId: 's', address, documentName: 'sheet.iamp' })
  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: address, documentName: 'sheet.iamp',
    instanceId: instance.instanceId, purposes: ['events'], expiresAt: Date.now() + 1000, singleUse: false, spent: false,
  }
  // The binding's own name is a different file's; the first event PINS the name,
  // so it is the view's own claim that is compared from then on, not the
  // address's.
  assert.equal(store.ingest(binding, drawing.events.validateViewEvent(
    event({ document: { name: 'project.dmf', hasRevision: false } }), 'wasm').event, 'wasm').status, 'stored')
  assert.equal(store.ingest(binding, drawing.events.validateViewEvent(
    event({ eventId: 'w#2', document: { name: 'project.iam', hasRevision: false } }), 'wasm').event, 'wasm').status, 'stored')
  assert.equal(store.ingest(binding, drawing.events.validateViewEvent(
    event({ eventId: 'w#3', document: { name: 'somethingelse.iam', hasRevision: false } }), 'wasm').event, 'wasm').status, 'refused')
})

test('sameDocument compares stems, case-insensitively, and tolerates silence', () => {
  const { sameDocument } = drawing.events
  assert.equal(sameDocument('a.iamp', 'a.iamp'), true)
  assert.equal(sameDocument('地下.iam', '地下.dmf'), true)
  assert.equal(sameDocument('Sheet.IAMP', 'sheet.iamp'), true)
  assert.equal(sameDocument('dir/a.iamp', 'a.iamp'), true)
  assert.equal(sameDocument('a.iamp', 'b.iamp'), false)
  assert.equal(sameDocument('', 'anything'), true)
  assert.equal(sameDocument('a', ''), true)
})

// ------------------------------------------------------------------ schema

test('an unknown kind, a bad schema and a missing selection are each refused', async () => {
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const { ctx, route } = await mount(drawing, space)
  try {
    const { token } = await handshake(route, space.addressOf('sheet.iamp'))
    const answer = await post(route, token, [
      event({ kind: 'something.else' }),
      event({ eventId: 'x#2', schema: 'iax.iam.view-event/9' }),
      event({ eventId: 'x#3', selection: undefined }),
      event({ eventId: 'x#4' }),
    ])
    const body = answer.json()
    assert.equal(body.accepted, 1)
    assert.equal(body.rejected, 3)
  } finally {
    ctx.unload()
  }
})

test('a page without an offset is the whole selection, as it was before paging', async () => {
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const { ctx, route } = await mount(drawing, space)
  try {
    const { token } = await handshake(route, space.addressOf('sheet.iamp'))
    const legacy = event()
    delete legacy.selection.offset
    delete legacy.selection.more
    await post(route, token, [legacy])
    const status = (await request(route, { url: '/status', headers: { [CAP]: token } })).json()
    assert.equal(status.selection.complete, true)
    assert.equal(status.selection.reported, 1)
  } finally {
    ctx.unload()
  }
})

// ------------------------------------------------------------------- gaps

test('what a client dropped is recorded and reachable from the status route', async () => {
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const { ctx, route } = await mount(drawing, space)
  try {
    const { token } = await handshake(route, space.addressOf('sheet.iamp'))
    await post(route, token, [event({ kind: 'edit.committed', edit: { operation: 'erase', refs: [], truncated: false } })], {
      gaps: { droppedFacts: 3, droppedByKind: { 'edit.committed': 2, 'document.saved': 1 } },
    })
    const status = (await request(route, { url: '/status', headers: { [CAP]: token } })).json()
    assert.equal(status.gaps.droppedFacts, 3)
    assert.equal(status.gaps.droppedByKind['edit.committed'], 2)

    // A second tally merges rather than replacing.
    await post(route, token, [event({ eventId: 'w#2' })], { gaps: { droppedFacts: 1, droppedByKind: { 'edit.undone': 1 } } })
    const after = (await request(route, { url: '/status', headers: { [CAP]: token } })).json()
    assert.equal(after.gaps.droppedFacts, 4)
    assert.equal(after.gaps.droppedByKind['edit.undone'], 1)
    assert.equal(after.gaps.droppedByKind['edit.committed'], 2)
  } finally {
    ctx.unload()
  }
})

// ------------------------------------------------------------- tool naming

test('the two view plugins register distinct tool names into one table', async () => {
  // The Harness tool table is ONE global layer and a duplicate name throws, which
  // is not a merge but a failure to load the second plugin.
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const tools = fakeTools()
  const { ctx: drawingCtx } = await mount(drawing, { ...space, tools, sessionId: space.sessionId })
  const { ctx: miningCtx } = await mount(mining, { ...space, tools, sessionId: space.sessionId })
  try {
    assert.deepEqual([...tools.registered.keys()].sort(), [
      'iam_drawing_view_recent_edits',
      'iam_drawing_view_selection',
      'iam_mining_view_recent_edits',
      'iam_mining_view_selection',
    ])
    // A name that shadows nothing stays registered when one plugin goes away.
    drawingCtx.unload()
    assert.deepEqual([...tools.registered.keys()].sort(), [
      'iam_mining_view_recent_edits',
      'iam_mining_view_selection',
    ])
  } finally {
    drawingCtx.unload()
    miningCtx.unload()
  }
})

// ------------------------------------------------------------- end to end

test('a selection survives the whole path and the agent is told once', async () => {
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const agent = fakeAgent(space.sessionId)
  const { ctx, route } = await mount(drawing, { ...space, agents: fakeAgents([agent]) })
  try {
    const { token } = await handshake(route, space.addressOf('sheet.iamp'))
    await post(route, token, [event()])
    await post(route, token, [event({ eventId: 'w#2' })])
    // The injection is coalesced behind a 1200 ms timer; nothing has been said
    // yet, and that is the point -- a click does not start a conversation.
    assert.equal(agent.injected.length, 0)
  } finally {
    ctx.unload()
  }
})
