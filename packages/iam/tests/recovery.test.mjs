import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const PAGES = {
  drawing: join(repoRoot, 'build', 'bin', 'wasm', 'views', 'IamDrawingView.html'),
  mining: join(repoRoot, 'build', 'bin', 'wasm', 'views', 'IamMiningView.html'),
}

/**
 * The inline scripts of a built page, in the order the document runs them.
 *
 * ALL OF THEM, and not the first one. The page's <head> now carries a small
 * theme-and-language bootstrap ahead of the shell -- it reads `?theme=`/`?lang=`,
 * what the page remembered and `prefers-color-scheme`, and writes
 * `documentElement.dataset` before the body exists. Taking the first block
 * handed back that bootstrap, so `globalThis.iamShell` was never defined and
 * every test in this file failed on an undefined `shell`. The bootstrap has to
 * RUN rather than be skipped, too: the shell reads the globals it leaves behind.
 */
function shellScript(path) {
  const html = readFileSync(path, 'utf8')
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.ok(
    blocks.some((block) => block.includes('iamShell')),
    `no inline script defining the shell in ${path}`,
  )
  return blocks.join('\n')
}

/** An `indexedDB` good enough for the shell's one object store of records. */
function fakeIndexedDb() {
  const records = new Map()
  const database = {
    createObjectStore: () => undefined,
    transaction: () => {
      const transaction = {}
      const settle = (fn) => queueMicrotask(() => fn?.())
      transaction.objectStore = () => ({
        put(record) {
          records.set(record.key, record)
          settle(() => transaction.oncomplete?.())
          return {}
        },
        get(key) {
          const request = { result: records.get(key) ?? null }
          settle(() => request.onsuccess?.())
          return request
        },
      })
      return transaction
    },
  }
  return {
    records,
    open() {
      const request = { result: database }
      queueMicrotask(() => {
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
}

/** A DOM stub: one element per id the shell looks up, plus a message bus. */
function fakePage({ search = '', indexedDB }) {
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: '',
        hidden: true,
        dataset: {},
        width: 0,
        height: 0,
        style: {},
        addEventListener: () => undefined,
        remove: () => undefined,
      })
    }
    return elements.get(id)
  }
  const listeners = []
  const window = {
    location: { search, origin: 'http://localhost:3000', href: `http://localhost:3000/${search}` },
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    removeEventListener: () => undefined,
    console,
  }
  window.parent = window
  const document = {
    getElementById: element,
    createElement: () => element(`created-${elements.size}`),
    // The shell's inline bootstrap in the page's <head> sets
    // `document.documentElement.dataset.theme` before anything else runs, so a
    // stub without a documentElement throws on the first line of the page. That
    // is the whole of what the shell asks of it -- `document.*` in the built
    // page is exactly documentElement, getElementById and title.
    documentElement: { dataset: {} },
    title: '',
  }
  return { window, document, element, indexedDB }
}

/**
 * Evaluate the built shell the way a page load does.
 *
 * `globalThis.Module.iamEditable` is what the shell reads when there is no
 * `?editable=` in the URL -- so it is set from the same mode, which is how the
 * embedded view (where `?editable=` is not used) decides.
 */
function loadPage(page, { search = '', indexedDB }) {
  const stubs = fakePage({ search, indexedDB })
  const sandbox = {
    window: stubs.window,
    document: stubs.document,
    // The shell picks its language from `navigator.language` when the URL and
    // the page's own memory are both silent -- `currentLanguage()` above it. A
    // stub without the global throws before the shell is ever assembled; pinned
    // to 'en' so which sentences the shell builds does not depend on the host.
    navigator: { language: 'en' },
    indexedDB,
    console,
    URLSearchParams,
    TextEncoder,
    Blob,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Math,
  }
  sandbox.globalThis = sandbox
  sandbox.window.Module = { iamEditable: search.includes('editable=1') }
  vm.createContext(sandbox)
  vm.runInContext(shellScript(page), sandbox, { filename: 'IamWebShell.html' })
  return { ...stubs, shell: sandbox.iamShell }
}

/** Let the microtasks behind the store settle. */
const settle = () => new Promise((done) => setTimeout(done, 0))

const drawingPage = PAGES.drawing
const havePages = existsSync(drawingPage)
const skip = havePages ? false : `run \`./build.sh build web\` first: ${drawingPage} does not exist`

test('the built page exposes the recovery entry points', { skip }, () => {
  const { shell } = loadPage(drawingPage, { indexedDB: fakeIndexedDb() })
  assert.equal(typeof shell.setDocument, 'function', 'the shell has no setDocument')
  assert.equal(typeof shell.setEditable, 'function')
  assert.equal(typeof shell.storeDocument, 'function')
  assert.equal(shell.isEditable(), false)
})

test('an autosave made after Browse→Edit is found by a reload in Edit', { skip }, async () => {
  // One store across two page loads, which is what a browser has.
  const indexedDB = fakeIndexedDb()

  // ---- the session: opened in Browse, switched to Edit, worked in ----
  const first = loadPage(drawingPage, { search: '?editable=0', indexedDB })
  first.shell.setDocument('sheet.iamp')
  first.shell.setEditable(true)
  assert.equal(first.shell.isEditable(), true)
  await first.shell.storeDocument(new Uint8Array([1, 2, 3]), 'sheet.iamp', 1)
  await settle()

  const keys = [...indexedDB.records.keys()]
  assert.equal(keys.length, 1, `expected exactly one recovery record, got ${JSON.stringify(keys)}`)
  assert.ok(
    keys[0].endsWith(':edit'),
    `the autosave was filed under ${JSON.stringify(keys[0])}, so a reload in Edit would not find it`,
  )
  assert.ok(keys[0].includes('sheet.iamp'), 'the record is not bound to the document')

  // ---- the reload: a fresh page, in Edit, on the same document ----
  const second = loadPage(drawingPage, { search: '?editable=1', indexedDB })
  assert.equal(second.shell.isEditable(), true)
  // What the embedder does when it opens the document, and what re-checks the
  // store for this document and mode.
  second.shell.setDocument('sheet.iamp')
  await settle()

  assert.equal(second.element('recovery').hidden, false, 'the reload in Edit did not offer the recovery')
  assert.match(second.element('recovery-text').textContent, /sheet\.iamp/)
})

test('two documents in one mode do not share a recovery slot', { skip }, async () => {
  const indexedDB = fakeIndexedDb()
  const page = loadPage(drawingPage, { search: '?editable=1', indexedDB })

  page.shell.setDocument('first.iamp')
  await page.shell.storeDocument(new Uint8Array([1]), 'first.iamp', 1)
  await settle()
  page.shell.setDocument('second.iamp')
  await page.shell.storeDocument(new Uint8Array([2]), 'second.iamp', 1)
  await settle()

  const keys = [...indexedDB.records.keys()].sort()
  assert.equal(keys.length, 2, 'the second document overwrote the first one\'s recovery copy')
  assert.ok(keys.some((key) => key.includes('first.iamp')))
  assert.ok(keys.some((key) => key.includes('second.iamp')))

  // And the prompt follows the document the page is showing.
  const reload = loadPage(drawingPage, { search: '?editable=1', indexedDB })
  reload.shell.setDocument('first.iamp')
  await settle()
  assert.equal(reload.element('recovery').hidden, false)
  assert.match(reload.element('recovery-text').textContent, /first\.iamp/)
})

test('a mode switch with nothing to recover leaves the prompt down', { skip }, async () => {
  const indexedDB = fakeIndexedDb()
  const page = loadPage(drawingPage, { search: '?editable=0', indexedDB })
  page.shell.setDocument('sheet.iamp')
  await settle()
  page.shell.setEditable(true)
  await settle()
  // Nothing was ever stored, so there is nothing to offer -- and the prompt must
  // not be left standing from the previous key.
  assert.equal(page.element('recovery').hidden, true)
})

test('the Mining page keys its recovery the same way', { skip: existsSync(PAGES.mining) ? false : 'the Mining view is not built' }, async () => {
  const indexedDB = fakeIndexedDb()
  const first = loadPage(PAGES.mining, { search: '?editable=0', indexedDB })
  first.shell.setDocument('project.iam')
  first.shell.setEditable(true)
  await first.shell.storeDocument(new Uint8Array([9]), 'project.iam', 1)
  await settle()
  const keys = [...indexedDB.records.keys()]
  assert.equal(keys.length, 1)
  assert.ok(keys[0].endsWith(':edit'), `the Mining page filed its autosave under ${JSON.stringify(keys[0])}`)

  const second = loadPage(PAGES.mining, { search: '?editable=1', indexedDB })
  second.shell.setDocument('project.iam')
  await settle()
  assert.equal(second.element('recovery').hidden, false)
})
