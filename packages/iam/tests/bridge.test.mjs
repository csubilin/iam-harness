import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import {
  cleanup,
  fakeWindow,
  loadClientModule,
  loadViewEvents,
  scriptedFetch,
  translator,
  withGlobals,
} from './helpers.mjs'

after(cleanup)

const { ViewEventBridge } = await loadViewEvents('views')

// The bridge names its refusals and the pane's dictionary writes them, so the
// sentences `report` is handed below are translated copy, not literals.
const { zh } = await loadClientModule('views', 'client/locales.ts')
const t = translator(zh)

const ROUTE = '/iam-drawingview'
const ADDRESS = 'dsh-resource://file/session/s/sheet.iamp'

/** A view event in the schema the bridge admits. */
function event(eventId, overrides = {}) {
  return {
    schema: 'iax.iam.view-event/1',
    eventId,
    sequence: 1,
    kind: 'edit.committed',
    view: { id: 'drawing.browse', domain: 'drawing', mode: 'browse', is3d: false },
    document: { name: 'sheet.iamp', hasRevision: false },
    edit: { operation: 'erase', refs: [], truncated: false },
    ...overrides,
  }
}

/** A selection page, which the queue is allowed to supersede by version. */
function selectionPage(version, offset) {
  return event(`page#${version}.${offset}`, {
    kind: 'selection.changed',
    selection: { version, count: 4, truncated: false, offset, more: offset < 3, refs: [{ kind: 'handle', value: `CE${offset}` }] },
  })
}

/**
 * Run one case against a bridge wired to a scripted network.
 *
 * The bridge is CONSTRUCTED inside the globals, and not merely used there: its
 * constructor subscribes to `window`'s message bus, so there has to be a window
 * by the time it exists -- which is also the one thing about this class that a
 * browser supplies and a test has to stand in for.
 */
async function bridgeOn(script, { report = () => undefined } = {}, body) {
  const bus = fakeWindow()
  const frame = { contentWindow: {} }
  const { fetchImpl, calls } = scriptedFetch(script)
  return withGlobals({ window: bus, fetch: fetchImpl }, async () => {
    const bridge = new ViewEventBridge({ route: ROUTE, address: ADDRESS, frame: () => frame, report, t })
    try {
      return await body({ bridge, bus, frame, calls })
    } finally {
      // `start()` leaves a flush interval running, which is right in a page and a
      // hang in a test runner.
      bridge.dispose()
    }
  })
}

/** Deliver one event through the page's own bus, as the shell would. */
function deliver(bus, frame, payload) {
  bus.post({ channel: 'iam-view-event', payload }, frame.contentWindow)
}

/** A capability answer, so `start()` succeeds before the scripted failures. */
const CAPABILITY = { status: 200, body: { token: 'cap-1', expiresAt: Date.now() + 60000, sessionId: 's', document: { name: 'sheet.iamp' }, schema: 'iax.iam.view-event/1' } }

test('a batch the host cannot be reached with is kept and retried', async () => {
  const failures = []
  await bridgeOn(
    [CAPABILITY, { throws: 'connect ECONNREFUSED' }],
    { report: (message, kind) => failures.push({ message, kind }) },
    async ({ bridge, bus, frame, calls }) => {
    await bridge.start()
    deliver(bus, frame, event('e#1'))
    await bridge.flushNow()
    assert.equal(calls.filter((call) => call.url.endsWith('/events')).length, 1)
    // The attempt failed. The event is still the bridge's.
    assert.equal(bridge.queue.length, 1, 'the batch of a failed POST was thrown away')
    assert.ok(failures.some((entry) => /未能送达/.test(entry.message)))

    await bridge.flushNow()
    const posted = calls.filter((call) => call.url.endsWith('/events'))
    assert.equal(posted.length, 2)
    assert.equal(posted[1].body.events[0].eventId, 'e#1', 'the retry carried something else')
    assert.equal(bridge.queue.length, 0)
  })
})

test('a 403 whose renewal FAILS keeps the batch', async () => {
  // The loss this fixes: `this.capability = await this.requestCapability()`
  // threw inside the try, the catch swallowed it, and the batch -- already
  // spliced out of the queue -- went with it.
  await bridgeOn([
    CAPABILITY,
    { status: 403, body: { error: 'a valid capability is required' } },
    { status: 500, body: { error: 'the host is restarting' } },
  ], {}, async ({ bridge, bus, frame, fetchImpl, calls }) => {
    await bridge.start()
    deliver(bus, frame, event('e#1'))
    await bridge.flushNow()
    assert.equal(bridge.queue.length, 1, 'a failed capability renewal lost the batch')

    // A retry now renews successfully and the batch goes through.
    await bridge.flushNow()
    const renewals = calls.filter((call) => call.url.endsWith('/session/capability'))
    assert.equal(renewals.length, 2, 'the renewal was not retried')
    assert.equal(bridge.queue.length, 0)
  })
})

test('a 5xx is retried rather than accepted as an answer', async () => {
  await bridgeOn([CAPABILITY, { status: 503, body: {} }], {}, async ({ bridge, bus, frame, fetchImpl, calls }) => {
    await bridge.start()
    deliver(bus, frame, event('e#1'))
    await bridge.flushNow()
    assert.equal(bridge.queue.length, 1)
    await bridge.flushNow()
    assert.equal(bridge.queue.length, 0)
    assert.equal(calls.filter((call) => call.url.endsWith('/events')).length, 2)
  })
})

test('the queue supersedes a selection by version and keeps every page of one', async () => {
  await bridgeOn([CAPABILITY], {}, async ({ bridge, bus, frame, fetchImpl }) => {
    await bridge.start()
    // Three pages of ONE selection: dropping any of them would leave the host to
    // assemble a selection out of the middle.
    deliver(bus, frame, selectionPage(4, 0))
    deliver(bus, frame, selectionPage(4, 1))
    deliver(bus, frame, selectionPage(4, 2))
    assert.equal(bridge.queue.length, 3)
    // A newer selection supersedes all of them; an older one changes nothing.
    deliver(bus, frame, selectionPage(5, 0))
    assert.equal(bridge.queue.length, 1)
    assert.equal(bridge.queue[0].selection.version, 5)
  })
})

test('a full queue drops the oldest FACT and counts it, and the count travels', async () => {
  await bridgeOn([CAPABILITY], {}, async ({ bridge, bus, frame, fetchImpl, calls }) => {
    await bridge.start()
    // Queue the maximum, with nothing supersedable in it: these are all edits.
    for (let index = 0; index < 128; index += 1) deliver(bus, frame, event(`e#${index}`))
    assert.equal(bridge.queue.length, 128)
    deliver(bus, frame, event('e#128'))
    assert.equal(bridge.queue.length, 128, 'the queue grew past its bound')
    assert.equal(bridge.queue[0].eventId, 'e#1', 'the wrong event was dropped')

    await bridge.flushNow()
    const posted = calls.filter((call) => call.url.endsWith('/events')).pop()
    assert.equal(posted.body.gaps.droppedFacts, 1, 'what was dropped did not travel with the batch')
    assert.equal(posted.body.gaps.droppedByKind['edit.committed'], 1)
  })
})

test('a supersedable selection is dropped before a fact is', async () => {
  await bridgeOn([CAPABILITY], {}, async ({ bridge, bus, frame, fetchImpl }) => {
    await bridge.start()
    deliver(bus, frame, selectionPage(1, 0))
    for (let index = 0; index < 127; index += 1) deliver(bus, frame, event(`e#${index}`))
    assert.equal(bridge.queue.length, 128)
    deliver(bus, frame, event('e#127'))
    assert.equal(bridge.queue.length, 128)
    // The stale selection went; every edit stayed, and nothing had to be counted.
    assert.ok(bridge.queue.every((queued) => queued.kind === 'edit.committed'))
    assert.equal(bridge.dropped, null, 'a supersedable event was counted as a lost fact')
  })
})

test('a delivered gap is cleared, so it is reported once', async () => {
  const first = []
  await bridgeOn([CAPABILITY], { report: (message) => first.push(message), }, async ({ bridge, bus, frame, fetchImpl, calls }) => {
    await bridge.start()
    for (let index = 0; index < 129; index += 1) deliver(bus, frame, event(`e#${index}`))
    await bridge.flushNow()
    assert.equal(bridge.dropped, null)
    const posted = calls.filter((call) => call.url.endsWith('/events')).pop()
    assert.equal(posted.body.gaps.droppedFacts, 1)
    assert.ok(first.some((message) => /队列已满/.test(message)), 'the drop was never mentioned to the user')
  })
})

test('an event from another frame, or another origin, never reaches the queue', async () => {
  await bridgeOn([CAPABILITY], {}, async ({ bridge, bus, frame, fetchImpl }) => {
    await bridge.start()
    // The right envelope from the wrong source.
    bus.post({ channel: 'iam-view-event', payload: event('e#1') }, {})
    assert.equal(bridge.queue.length, 0)
    // The right source with the wrong envelope.
    bus.post({ channel: 'something-else', payload: event('e#2') }, frame.contentWindow)
    assert.equal(bridge.queue.length, 0)
    // The right source and envelope with a schema this build does not know.
    bus.post({ channel: 'iam-view-event', payload: { ...event('e#3'), schema: 'iax.iam.view-event/2' } }, frame.contentWindow)
    assert.equal(bridge.queue.length, 0)
    // And the real thing gets through.
    deliver(bus, frame, event('e#4'))
    assert.equal(bridge.queue.length, 1)
    assert.equal(bridge.receivedCount(), 1)
  })
})

test('a rehandshake asks for a new instance and keeps what is queued', async () => {
  await bridgeOn([
    CAPABILITY,
    { status: 200, body: { token: 'cap-2', expiresAt: Date.now() + 60000, sessionId: 's', document: { name: 'sheet.iamp' }, instance: { id: 'instance-2' }, schema: 'iax.iam.view-event/1' } },
  ], {}, async ({ bridge, bus, frame, fetchImpl, calls }) => {
    await bridge.start()
    deliver(bus, frame, event('e#1'))
    await bridge.rehandshake()
    assert.equal(bridge.capability.token, 'cap-2')
    assert.equal(bridge.queue.length, 1, 'the rehandshake dropped what had not been sent yet')
    assert.equal(calls.filter((call) => call.url.endsWith('/session/capability')).length, 2)
  })
})

test('a 4xx that is not 403 halves the batch instead of losing it', async () => {
  await bridgeOn([
    CAPABILITY,
    { status: 413, body: { error: 'too large' } },
  ], {}, async ({ bridge, bus, frame, fetchImpl, calls }) => {
    await bridge.start()
    for (let index = 0; index < 8; index += 1) deliver(bus, frame, event(`e#${index}`))
    await bridge.flushNow()
    assert.equal(bridge.queue.length, 8, 'a refused batch was dropped')
    await bridge.flushNow()
    const posted = calls.filter((call) => call.url.endsWith('/events'))
    assert.equal(posted[1].body.events.length, 4, 'the retry was not smaller')
    assert.equal(posted[1].body.events[0].eventId, 'e#0', 'the retry lost the front of the batch')
  })
})
