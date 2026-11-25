import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { cleanup, loadHost } from './helpers.mjs'

after(cleanup)

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

/**
 * Where this platform's native build puts the C++ dump program.
 *
 * No guess beyond the one `Import/host/native-tool-paths.ts` already makes, for the same
 * reason. The tree picks its output ROOT by compiler family -- `build/bin/<p>`
 * from GCC and Clang, `build/exe/<p>` when `WINDOWS_GCC` is defined, which is
 * what build.ps1 sets -- and `win-native` / `linux-native` are the native
 * target's platform token on the two desktops. The extension follows the same
 * split.
 */
const WINDOWS = process.platform === 'win32'
const BINARY = join(
  repoRoot,
  'build',
  WINDOWS ? 'exe' : 'bin',
  WINDOWS ? 'win-native' : 'linux-native',
  WINDOWS ? 'IamSelectionPagingTest.exe' : 'IamSelectionPagingTest',
)

const drawing = await loadHost('views')
const { ViewEventStore, validateViewEvent } = drawing.events
const { viewSelectionTool } = drawing.tools

const ADDRESS = 'dsh-resource://file/session/s/sheet.iamp'

/** The `exec` a tool call receives, whose agent id IS the session id. */
const EXEC = { agent: { id: 's' } }

/** The `exec` a tool call receives, whose agent id IS the session id. */
/** What the C++ test produced, or null when it has not been built. */
function producedEvents() {
  if (!existsSync(BINARY)) return null
  const scratch = mkdtempSync(join(tmpdir(), 'iam-wire-'))
  const dump = join(scratch, 'events.json')
  try {
    const run = spawnSync(BINARY, ['--dump', dump], { encoding: 'utf8' })
    if (run.status !== 0) {
      throw new Error(`IamSelectionPagingTest exited ${run.status}:\n${run.stdout}\n${run.stderr}`)
    }
    return JSON.parse(readFileSync(dump, 'utf8'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const events = producedEvents()

test('the wire: a real selection of 531 arrives as pages the host assembles', { skip: events === null ? `${BINARY} is not built` : false }, () => {
  assert.equal(events.length, 3)

  const store = new ViewEventStore(() => undefined)
  const instance = store.openInstance({ kind: 'page', sessionId: 's', address: ADDRESS, documentName: 'sheet.iamp' })
  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: ADDRESS, documentName: 'sheet.iamp',
    instanceId: instance.instanceId, purposes: ['events'], expiresAt: Date.now() + 60_000, singleUse: false, spent: false,
  }

  for (const raw of events) {
    const validation = validateViewEvent(raw, 'wasm')
    // The validator's own refusal is the failure message: a renamed field, a
    // missing `more` or an empty view id all land here.
    assert.ok(!('error' in validation), `the host refused a page the view produced: ${validation.error}`)
    assert.equal(store.ingest(binding, validation.event, 'wasm').status, 'stored')
  }

  const selection = store.activeFor('s').selection
  assert.equal(selection.version, 7)
  assert.equal(selection.count, 531)
  assert.equal(selection.refs.length, 531, 'the pages did not assemble into the whole selection')
  assert.equal(selection.complete, true, 'the host did not see the last page')
  assert.equal(selection.truncated, false)
  // Identity, not just length: the references carry the persistent spelling the
  // schema promises, which is what an agent looks an object up by.
  assert.equal(selection.refs[0].kind, 'handle')
  assert.equal(selection.refs[0].value, 'CE0')
  assert.equal(selection.refs[530].value, 'CE212')
})

test('the wire: the tool pages over what the view actually sent', { skip: events === null ? `${BINARY} is not built` : false }, async () => {
  const store = new ViewEventStore(() => undefined)
  const instance = store.openInstance({ kind: 'page', sessionId: 's', address: ADDRESS, documentName: 'sheet.iamp' })
  const binding = {
    token: 't', kind: 'page', sessionId: 's', resourceAddress: ADDRESS, documentName: 'sheet.iamp',
    instanceId: instance.instanceId, purposes: ['events'], expiresAt: Date.now() + 60_000, singleUse: false, spent: false,
  }
  for (const raw of events) {
    const validation = validateViewEvent(raw, 'wasm')
    assert.ok(!('error' in validation), validation.error)
    store.ingest(binding, validation.event, 'wasm')
  }

  const lookup = () => ({ state: store.activeFor('s') })
  const tool = viewSelectionTool(lookup, 'iam_drawing')
  const collected = []
  let offset = 0
  for (;;) {
    const answer = await tool.execute({ offset, limit: 256, version: 7 }, EXEC)
    assert.equal(answer.stale, undefined, 'the version the first page carried was reported as moved on')
    collected.push(...answer.selection.refs.map((ref) => ref.value))
    if (answer.page.exhausted) break
    offset += answer.page.returned
  }
  assert.equal(collected.length, 531)
  assert.equal(collected[0], 'CE0')
  assert.equal(collected[530], 'CE212')
})
