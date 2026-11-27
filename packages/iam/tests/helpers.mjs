import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const pluginRoot = resolve(here, '..')
export const require = createRequire(import.meta.url)

/** The packages whose host half the suite builds before running. */
export const VIEW_PACKAGES = ['views']

/**
 * The host-only tool packages the suite builds before running.
 *
 * Separate from VIEW_PACKAGES because they are a different SHAPE, not a
 * different kind of thing: a tool package has no `lib/events.js` and no
 * `lib/address.js`, so `loadHost` below -- which imports those four by name --
 * cannot load one. `Import` is deliberately absent: it needs a build's native
 * executables, and the suite does not have them.
 */
export const TOOL_PACKAGES = ['algorithm-bridge', 'capability-forge', 'app-publisher', 'mining-repository', 'render']

/**
 * Locate the TypeScript compiler, the same way `scripts/build.mjs` does.
 *
 * The candidates are duplicated rather than imported because `build.mjs` is a
 * script that runs its own mode on load; a test importing it would build
 * things as a side effect of asking where the compiler is.
 *
 * `harnessRoots` is a copy of the same function in those scripts, for the
 * reason above, and the two must be changed together.
 */
function harnessRoots(from) {
  const roots = process.env.DSH_HARNESS_ROOT ? [process.env.DSH_HARNESS_ROOT] : []
  let dir = from
  for (;;) {
    const parent = dirname(dir)
    if (parent === dir) break
    for (const name of ['iam-harness', 'deepseek-harness']) roots.push(join(parent, name))
    dir = parent
  }
  return roots
}

function loadTypeScript() {
  const candidates = [
    process.env.DSH_TYPESCRIPT,
    ...harnessRoots(here).map((dir) => join(dir, 'node_modules', 'typescript')),
    'typescript',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // Try the next root.
    }
  }
  throw new Error(
    'TypeScript not found; set DSH_TYPESCRIPT to a typescript package directory, ' +
      'or DSH_HARNESS_ROOT to the Harness checkout that has one.',
  )
}

const ts = loadTypeScript()

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  sourceMap: false,
}

/**
 * The built host half of one package, imported.
 *
 * From `lib/`, and built on demand: `lib/` is gitignored and produced by
 * `scripts/build.mjs host`, so a test that ran before a build would otherwise
 * fail on a missing file rather than on the thing it is testing. The build is
 * only run when the output is absent, so a repeated `node --test` is cheap.
 */
export async function loadHost(packageName) {
  const root = join(pluginRoot, packageName)
  if (!existsSync(join(root, 'lib', 'index.js'))) buildHost(packageName)
  return {
    index: await import(pathToFileURL(join(root, 'lib', 'index.js')).href),
    events: await import(pathToFileURL(join(root, 'lib', 'events.js')).href),
    tools: await import(pathToFileURL(join(root, 'lib', 'tools.js')).href),
    address: await import(pathToFileURL(join(root, 'lib', 'address.js')).href),
  }
}

/**
 * The host half of a TOOL package: `index.js` and whatever else it names.
 *
 * A test drives it the way `selectientest`/`events.test.mjs` drive a view: mount
 * the registered definitions on a `fakeTools()` and call them. What a tool
 * package has instead of a route table is a set of definitions, so the assertion
 * is about names, schemas and execute(), not about requests.
 */
export async function loadToolHost(packageName, modules) {
  const root = join(pluginRoot, packageName)
  if (!existsSync(join(root, 'lib', 'index.js'))) buildHost(packageName)
  const loaded = { index: await import(pathToFileURL(join(root, 'lib', 'index.js')).href) }
  for (const name of modules ?? []) {
    loaded[name] = await import(pathToFileURL(join(root, 'lib', `${name}.js`)).href)
  }
  return loaded
}

/** Run `scripts/build.mjs host` for one package. Throws on a non-zero exit. */
export function buildHost(packageName) {
  const root = join(pluginRoot, packageName)
  const result = spawnSync(process.execPath, ['scripts/build.mjs', 'host'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_TYPESCRIPT: process.env.DSH_TYPESCRIPT },
  })
  if (result.status !== 0) {
    throw new Error(`build.mjs host failed for ${packageName}:\n${result.stdout}\n${result.stderr}`)
  }
}

/** The source a relative specifier names, or null when it names something else. */
function resolveClientSource(from, specifier) {
  const base = resolve(dirname(from), specifier)
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + suffix)) return base + suffix
  }
  return null
}

/**
 * Emit one client source, and everything it imports, into `scratch`.
 *
 * THE GRAPH IS WALKED BECAUSE IT GREW ONE. This helper used to transpile
 * `view-events.ts` on its own and say in this comment that the file "has no
 * imports at all". That stopped being true when the module acquired
 * `import { readAppearance } from './appearance'`, and an extensionless
 * specifier is not something Node's ESM resolver will guess at -- the file
 * failed to load outright with ERR_MODULE_NOT_FOUND. So a specifier that names
 * a source is rewritten to `.mjs` and that source is emitted too. The layout
 * under `root` is mirrored, which is what keeps a specifier valid at any depth.
 *
 * A `import type` contributes no edge: the transpile erases it, and what is
 * walked is the emit, not the source. That is what keeps `./embedded-view` --
 * and the `../../shared/reasons` above it -- out of the scratch directory.
 */
function emitClientGraph(source, root, scratch, emitted) {
  const name = relative(root, source).replace(/\.tsx?$/, '') + '.mjs'
  if (emitted.has(name)) return name
  emitted.add(name)

  const target = join(scratch, name)
  mkdirSync(dirname(target), { recursive: true })
  const output = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: COMPILER_OPTIONS,
    fileName: source,
  }).outputText
  const rewritten = output.replace(
    /(\bfrom\s*|\bimport\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (whole, head, quote, specifier) => {
      const dependency = resolveClientSource(source, specifier)
      if (dependency === null) return whole
      emitClientGraph(dependency, root, scratch, emitted)
      return `${head}${quote}${specifier}.mjs${quote}`
    },
  )
  writeFileSync(target, rewritten)
  return name
}

/**
 * One of a package's browser-half sources, transpiled on demand.
 *
 * `entry` is relative to the package root. Each call gets its own scratch
 * directory, so two modules loaded separately are two module instances -- which
 * is what a caller wanting the pane's dictionary beside the bridge wants.
 */
export function loadClientModule(packageName, entry) {
  const root = join(pluginRoot, packageName)
  const scratch = mkdtemp('iam-client-')
  const name = emitClientGraph(join(root, entry), root, scratch, new Set())
  return import(pathToFileURL(join(scratch, name)).href)
}

/**
 * The browser half's event bridge, transpiled on demand.
 *
 * `client/core/view-events.ts` is authored for the module-loader closure the
 * harness serves and touches only `window` and `fetch`, so transpiling it for
 * Node is enough to drive its retry behaviour from a test, with both globals
 * stubbed by the caller.
 */
export function loadViewEvents(packageName) {
  return loadClientModule(packageName, join('client', 'core', 'view-events.ts'))
}

/**
 * The pane's translator, standing in for the one the slot machinery hands the
 * pane at runtime.
 *
 * THE BRIDGE'S SENTENCES ARE TRANSLATED NOW. The host half used to write its
 * refusals as sentences; it now names them (`channelNotEstablished`,
 * `deliveryFailed`, ...) and the copy lives in `client/locales.ts`, which is why
 * `ViewEventBridge` takes a `t`. A bridge built without one throws on the first
 * thing it has to say -- which is how these tests were found to be stale. Built
 * from the pane's own dictionary rather than from a literal, so what a test
 * asserts on is the copy that ships.
 */
export function translator(words) {
  return (key, values) => {
    let text = words[key] ?? key
    for (const [name, value] of Object.entries(values ?? {})) {
      text = text.replace(`{${name}}`, String(value))
    }
    return text
  }
}

/** A fresh temporary directory, removed by `cleanup()`. */
const scratchDirs = []
export function mkdtemp(prefix) {
  const dir = join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  scratchDirs.push(dir)
  return dir
}
export function cleanup() {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * A workspace directory, and the `dsh-resource://` address of a file in it.
 *
 * The returned `addressOf` is the only way a test should build an address, so
 * that percent-encoding is applied in one place -- a name with a space in it is
 * the ordinary case for these documents.
 */
export function workspace(sessionId = 'session-test') {
  const root = mkdtemp('iam-workspace-')
  return {
    root,
    sessionId,
    write(relative, contents) {
      const target = join(root, relative)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents)
      return target
    },
    addressOf(relative) {
      return `dsh-resource://file/session/${sessionId}/${relative.split('/').map(encodeURIComponent).join('/')}`
    },
    /** The lookup the resolver takes: one session, rooted here. */
    roots: (id) => (id === sessionId ? root : undefined),
  }
}

/**
 * The Cordis slice `apply()` is written against.
 *
 * `inject` activates immediately for whatever the test says is mounted and
 * returns the disposer Cordis would; `effect` runs its function and records the
 * teardown so a test can unload the plugin the way the loader does.
 */
export function fakeContext({ sessions, agents, tools, profileContext } = {}) {
  const context = {
    cleanups: [],
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') context.cleanups.push(dispose)
      return dispose
    },
    webServer: {
      register(route) {
        context.route = route
        return () => {
          context.route = undefined
        }
      },
    },
    inject(deps, fn) {
      const scope = {}
      for (const dep of deps) {
        if (dep === 'sessions') scope.sessions = sessions
        else if (dep === 'agents') scope.agents = agents
        else if (dep === 'tools') scope.tools = tools
        else if (dep === 'profileContext') scope.profileContext = profileContext
      }
      const dispose = fn(scope)
      if (typeof dispose === 'function') context.cleanups.push(dispose)
      return dispose
    },
  }
  context.unload = () => {
    for (const dispose of context.cleanups.splice(0)) dispose()
  }
  return context
}

/** A `tools` registry that records what was registered and forgets on dispose. */
export function fakeTools() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      if (registered.has(definition.name)) {
        // The harness's own behaviour, and the reason the two view plugins
        // cannot share a tool name: `NamedEntries.insert` throws.
        throw new Error(`tool "${definition.name}" is already registered`)
      }
      registered.set(definition.name, definition)
      return () => {
        registered.delete(definition.name)
      }
    },
  }
}

/** A `sessions` service holding one session per id, rooted at `cwd`. */
export function fakeSessions(entries) {
  const store = new Map(Object.entries(entries).map(([id, cwd]) => [id, { header: { cwd } }]))
  return { get: (id) => store.get(id), store }
}

/** A fake agent that records `inject`/`followup` calls. */
export function fakeAgent(id) {
  return {
    id,
    injected: [],
    followed: [],
    inject(message) {
      this.injected.push(message)
    },
    followup(message) {
      this.followed.push(message)
    },
  }
}

/** An `agents` service over a fixed set. */
export function fakeAgents(list) {
  const byId = new Map(list.map((agent) => [agent.id, agent]))
  return { get: (id) => byId.get(id) }
}

/**
 * One request against a registered route table.
 *
 * `readJson` iterates the request body, so the fake request is an async
 * iterable of Buffers -- the same shape `node:http` hands over -- and the fake
 * response is a sink that records the status, the headers and the bytes.
 */
export async function request(route, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  const req = {
    method,
    // The prefix is registered with the router and the handler sees the whole
    // path, so a caller writes the route-relative part and this puts it back.
    url: `${route.path ?? ''}${url}`,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    finished: false,
    writeHead(status, extra) {
      this.statusCode = status
      Object.assign(this.headers, extra ?? {})
    },
    write(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk))
      this.finished = true
    },
    // A `Readable.pipe()` wants these, and the vendored-view route uses one.
    on() {
      return this
    },
    once() {
      return this
    },
    emit() {
      return true
    },
    removeListener() {
      return this
    },
    /** The whole body, decoded. */
    text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    json() {
      return JSON.parse(this.text())
    },
  }
  await route.handler(req, res)
  // The registered handler is `void serve(req, res)` -- it returns as soon as the
  // work is started, exactly as a `node:http` listener would -- so waiting for
  // the response to end is what makes this a request rather than a nudge.
  if (!res.finished) {
    await until(() => res.finished, { timeoutMs: 4000 })
  }
  return res
}

/**
 * A `fetch` that answers from a queue of scripted responses.
 *
 * The bridge's retry policy is the thing under test, and what it needs from the
 * network is only "this attempt failed that way". `calls` is the record of what
 * it tried, which is what the assertions read.
 */
export function scriptedFetch(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const next = script.length > 0 ? script.shift() : { status: 200, body: { accepted: 1, duplicates: 0, rejected: 0 } }
    if (next.throws !== undefined) throw new Error(next.throws)
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async json() {
        return next.body ?? {}
      },
      async text() {
        return next.body === undefined ? '' : JSON.stringify(next.body)
      },
    }
  }
  return { fetchImpl, calls }
}

/** A `window` good enough for the bridge: a message bus and an origin. */
export function fakeWindow(origin = 'http://localhost:3000') {
  const listeners = []
  return {
    location: { origin },
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener)
    },
    removeEventListener(type, listener) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    /** Deliver a `postMessage` the way the browser would. */
    post(data, source) {
      for (const listener of listeners) listener({ origin, source, data })
    },
    get listenerCount() {
      return listeners.length
    },
  }
}

/** Install `window`/`fetch` for the duration of `fn`, then put them back. */
export async function withGlobals({ window, fetch }, fn) {
  const savedWindow = globalThis.window
  const savedFetch = globalThis.fetch
  if (window !== undefined) globalThis.window = window
  if (fetch !== undefined) globalThis.fetch = fetch
  try {
    return await fn()
  } finally {
    if (savedWindow === undefined) delete globalThis.window
    else globalThis.window = savedWindow
    if (savedFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = savedFetch
  }
}

/** Wait for a condition, so a test does not have to guess a timer length. */
export async function until(predicate, { timeoutMs = 4000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('condition was still false at the deadline')
    await new Promise((done) => setTimeout(done, stepMs))
  }
}
