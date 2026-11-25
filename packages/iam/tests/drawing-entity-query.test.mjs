import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { cleanup, fakeContext, fakeSessions, fakeTools, loadClientModule, loadHost,
  loadToolHost, pluginRoot, request, workspace } from './helpers.mjs'

after(cleanup)
const views = await loadHost('views')
const importPlugin = await loadToolHost('import')
const { queryWasmDrawingEntities } = await loadClientModule('views', 'client/core/wasm-drawing-entity-query.ts')
const importTools = fakeTools()
importPlugin.index.apply({ tools: importTools })
const drawingDescriptionTool = importTools.registered.get('describe_drawing')
const exec = id => ({ signal: new AbortController().signal, agent: { id } })
const payload = { source: 'selection', document: 'sheet.iamp', document_digest: 'digest', selection_version: 7,
  counts: { entities: 1 }, entities: [{ handle: 'A1', class: 'AcDbText', text: { plain: 'collar', insertion: [1, 2, 0] } }] }
const viewModules = await loadToolHost('views', ['native', 'events'])
const nativeExecutable = [
  '../../build/exe/win-native/IamNativeDrawingEntityQueryTest.exe',
  '../../build/bin/linux-native/IamNativeDrawingEntityQueryTest',
  '../../build/exe/linux-native/IamNativeDrawingEntityQueryTest',
].map(path => resolve(pluginRoot, path)).find(path => existsSync(path))
const queryExecutable = nativeExecutable && resolve(nativeExecutable, '..',
  process.platform === 'win32' ? 'IaxDrawingQuery.exe' : 'IaxDrawingQuery')

async function run(program, args) {
  const child = spawn(program, args, { windowsHide: true })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  const [code] = await once(child, 'close')
  return { code, stderr }
}

test('the read-only CLI rejects foreign inputs and resumes handle pages without changing the drawing',
  { skip: !queryExecutable || !existsSync(queryExecutable), timeout: 20_000 }, async () => {
    const space = workspace()
    const output = resolve(space.root, 'entities.json'), input = resolve(space.root, 'drawing-query.iamp')
    assert.equal((await run(nativeExecutable, [space.root])).code, 0)
    const original = readFileSync(input)
    const all = await run(queryExecutable, [input, '--out', output, '--limit', '5000'])
    assert.equal(all.code, 0, all.stderr)
    const document = JSON.parse(readFileSync(output, 'utf8')), collected = []
    // Windows receives Unicode argv from CreateProcessW. Exercise characters
    // outside the active code page as well as Chinese and spaces in both paths.
    const unicodeDir = resolve(space.root, '中文 目录🙂')
    mkdirSync(unicodeDir)
    const unicodeInput = resolve(unicodeDir, '钻孔🙂.iamp')
    const unicodeOutput = resolve(unicodeDir, '实体 结果🙂.json')
    writeFileSync(unicodeInput, original)
    writeFileSync(unicodeInput + '.report', 'source=fixture\nlost=0\n')
    const unicode = await run(queryExecutable, [unicodeInput, '--out', unicodeOutput, '--limit', '5000'])
    assert.equal(unicode.code, 0, unicode.stderr)
    const unicodeDocument = JSON.parse(readFileSync(unicodeOutput, 'utf8'))
    assert.equal(unicodeDocument.document, unicodeInput)
    assert.equal(unicodeDocument.conversion_report.sidecar, 'source=fixture\nlost=0\n')
    assert.deepEqual(unicodeDocument.entities, document.entities)
    const filtered = await run(queryExecutable, [unicodeInput, '--out', unicodeOutput, '--layer', '不存在的图层🙂'])
    assert.equal(filtered.code, 0, filtered.stderr)
    assert.deepEqual(JSON.parse(readFileSync(unicodeOutput, 'utf8')).entities, [])
    assert.match((await run(queryExecutable, [unicodeInput, '--out', unicodeInput])).stderr, /Output must differ/)
    assert.match((await run(queryExecutable, [resolve(unicodeDir, '不存在🙂.iamp'), '--out', unicodeOutput])).stderr, /does not exist/)
    assert.match((await run(queryExecutable, [resolve(unicodeDir, '外部图纸🙂.dwg')])).stderr, /Convert first/)
    let after
    do {
      const args = [input, '--out', output, '--limit', '2', '--max-bytes', '4096']
      if (after) args.push('--after', after, '--document-digest', document.document_digest)
      const pageResult = await run(queryExecutable, args)
      assert.equal(pageResult.code, 0, pageResult.stderr)
      assert.ok(readFileSync(output).length <= 4096)
      const page = JSON.parse(readFileSync(output, 'utf8'))
      collected.push(...page.entities)
      after = page.page.next_after_handle
    } while (after && collected.length < 100)
    assert.deepEqual(collected, document.entities)
    assert.deepEqual(readFileSync(input), original)
    for (const extension of ['dwg', 'dxf']) {
      const rejected = await run(queryExecutable, [resolve(space.root, `source.${extension}`)])
      assert.equal(rejected.code, 2); assert.match(rejected.stderr, /Convert first: IaxDrawingImportTool --import/)
    }
    for (const extension of ['iam', 'iamh']) {
      const rejected = await run(queryExecutable, [resolve(space.root, `source.${extension}`)])
      assert.equal(rejected.code, 2)
      assert.match(rejected.stderr, /Mining project, not a drawing/)
    }
    assert.match((await run(queryExecutable, [resolve(space.root, 'missing.iamp'), '--out', output])).stderr, /does not exist/)
    assert.match((await run(queryExecutable, [input, '--out', input])).stderr, /Output must differ/)
    assert.match((await run(queryExecutable, [input, '--out', output, '--after', document.entities[0].cursor])).stderr, /pagination requires document_digest/)
    const damaged = resolve(space.root, 'damaged.iamp')
    writeFileSync(damaged, 'invalid native drawing')
    assert.notEqual((await run(queryExecutable, [damaged, '--out', output])).code, 0)
    const alias = resolve(space.root, 'drawing.iaxp')
    writeFileSync(alias, original)
    assert.equal((await run(queryExecutable, [alias, '--out', output])).code, 0)
  })

async function mounted() {
  const space = workspace()
  space.write('sheet.iamp', 'fixture')
  const ctx = fakeContext({ sessions: fakeSessions({ [space.sessionId]: space.root }), tools: fakeTools() })
  views.index.apply(ctx, { domains: ['drawing'] })
  const capability = (await request(ctx.route, { method: 'POST', url: '/session/capability',
    body: { address: space.addressOf('sheet.iamp') } })).json()
  const headers = { 'x-iam-capability': capability.token }
  await request(ctx.route, { url: '/drawing/query', headers })
  return { ctx, space, headers }
}

test('describe_drawing distinguishes no mounted view from an empty selection', async () => {
  delete globalThis.__iamDrawingEntityQuery
  const result = await drawingDescriptionTool.execute({ source: 'selection', scope: 'entities' }, exec('missing'))
  assert.equal(result.error.code, 'no_view')
  assert.match(result.error.message, /视图/)
})

test('describe_drawing sends a live selection request and returns the view JSON verbatim', async () => {
  const { ctx, space, headers } = await mounted()
  try {
    const pending = drawingDescriptionTool.execute({ source: 'selection', scope: 'entities', class: 'AcDbText',
      selection_version: 7, after_handle: 'A0', document_digest: 'digest', expand_blocks: false }, exec(space.sessionId))
    const query = (await request(ctx.route, { url: '/drawing/query', headers })).json().request
    assert.ok(query.id)
    assert.equal(query.args.source, 'selection')
    assert.equal(query.args.class, 'AcDbText')
    assert.equal(query.args.selection_version, 7)
    assert.equal(query.args.expand_blocks, false)
    assert.equal(query.args.after_handle, 'A0')
    const answer = await request(ctx.route, { method: 'POST', url: '/drawing/query', headers,
      body: { id: query.id, result: payload } })
    assert.equal(answer.statusCode, 200)
    assert.deepEqual(await pending, payload)
  } finally { ctx.unload() }
})

test('another page capability cannot supply the pending selection result', async () => {
  const { ctx, space, headers } = await mounted()
  try {
    const pending = drawingDescriptionTool.execute({ source: 'document' }, exec(space.sessionId))
    const query = (await request(ctx.route, { url: '/drawing/query', headers })).json().request
    space.write('other.iamp', 'other')
    const other = (await request(ctx.route, { method: 'POST', url: '/session/capability',
      body: { address: space.addressOf('other.iamp') } })).json()
    const wrong = await request(ctx.route, { method: 'POST', url: '/drawing/query',
      headers: { 'x-iam-capability': other.token }, body: { id: query.id, result: payload } })
    assert.equal(wrong.statusCode, 409)
    await request(ctx.route, { method: 'POST', url: '/drawing/query', headers,
      body: { id: query.id, result: payload } })
    assert.deepEqual(await pending, payload)
  } finally { ctx.unload() }
})

test('cancelled and oversized results are actionable answers, never empty entity arrays', async () => {
  const { ctx, space, headers } = await mounted()
  try {
    const controller = new AbortController()
    const cancelled = drawingDescriptionTool.execute({ source: 'selection' }, { signal: controller.signal, agent: { id: space.sessionId } })
    controller.abort()
    assert.equal((await cancelled).error.code, 'cancelled')
    const pending = drawingDescriptionTool.execute({ source: 'selection', max_bytes: 4096 }, exec(space.sessionId))
    const query = (await request(ctx.route, { url: '/drawing/query', headers })).json().request
    await request(ctx.route, { method: 'POST', url: '/drawing/query', headers,
      body: { id: query.id, result: { ...payload, extra: 'x'.repeat(5000) } } })
    assert.equal((await pending).error.code, 'result_too_large')
    await assert.rejects(drawingDescriptionTool.execute({ source: 'selection', bbox: [1, 0, 0, 0, 1, 1] }, exec(space.sessionId)), /bbox/)
  } finally { ctx.unload() }
})

test('a missing Wasm entry point explicitly asks for an updated view', async () => {
  const result = await queryWasmDrawingEntities(null, { source: 'selection' })
  assert.equal(result.error.code, 'view_query_unavailable')
})

test('the browser bridge copies ABI strings and bounds and decodes the C++ envelope', async () => {
  let heap = new Uint8Array(32 * 1024), next = 64, call, released
  const bytes = new TextEncoder().encode(JSON.stringify(payload) + '\0')
  const module = {
    get HEAPU8() { return heap },
    _malloc(size) {
      const pointer = next; next = (next + size + 7) & ~7
      // Exercise memory growth: each allocation detaches the client's old view.
      heap = new Uint8Array([...heap])
      return pointer
    },
    _free() {},
    _iamViewAgentDrawingQuery(...args) { call = args; return 42 },
    _iamViewAgentDrawingPoll(id, state, output, capacity, required) {
      assert.equal(id, 42)
      const view = new DataView(heap.buffer)
      view.setInt32(state, 6, true); view.setUint32(required, bytes.length, true)
      if (output) { assert.ok(capacity >= bytes.length); heap.set(bytes, output) }
      return 0
    },
    _iamViewAgentDrawingRelease(id) { released = id; return 0 },
  }
  const result = await queryWasmDrawingEntities({ contentWindow: { Module: module } }, {
    source: 'selection', class: 'AcDbText', layer: 'ore', bbox: [0, 1, 2, 3, 4, 5], limit: 5,
    expand_blocks: true, max_bytes: 4096, selection_version: 7,
  })
  assert.deepEqual(result, payload)
  assert.equal(call[0], 2)
  const read = pointer => new TextDecoder().decode(heap.subarray(pointer, heap.indexOf(0, pointer)))
  assert.equal(read(call[1]), 'AcDbText')
  assert.equal(read(call[2]), 'ore')
  assert.equal(read(call[9]), '7')
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => new DataView(heap.buffer).getFloat64(call[6] + 8 * i, true)), [0, 1, 2, 3, 4, 5])
  assert.equal(released, 42)
})

test('unmounting the page cancels its query as no_view', async () => {
  const { ctx, space, headers } = await mounted()
  try {
    const pending = drawingDescriptionTool.execute({ source: 'selection' }, exec(space.sessionId))
    await request(ctx.route, { method: 'DELETE', url: '/drawing/query', headers })
    assert.equal((await pending).error.code, 'no_view')
  } finally { ctx.unload() }
})

test('the native bridge queries the real C++ view and transfers large JSON without truncation',
  { skip: nativeExecutable === undefined, timeout: 20_000 }, async () => {
    const { CapabilityRegistry, ViewEventStore } = viewModules.events
    const capabilities = new CapabilityRegistry(), store = new ViewEventStore(() => undefined)
    const instance = store.openInstance({ kind: 'native', sessionId: 'native-query', address: 'sheet.iamp', documentName: 'sheet.iamp' })
    const binding = capabilities.issue({ kind: 'native', sessionId: instance.sessionId, resourceAddress: instance.address,
      documentName: instance.documentName, instanceId: instance.instanceId, purposes: ['events'],
      singleUse: true, expiresAt: Date.now() + 30_000 })
    const bridge = new viewModules.native.NativeEditorBridge('drawing', capabilities, store, {}, () => undefined)
    // Drive the shipping connection handler through a real authenticated socket.
    const server = createServer(socket => bridge.accept(socket))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const child = spawn(nativeExecutable, ['--bridge', String(server.address().port), binding.token], { windowsHide: true })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      const deadline = Date.now() + 10_000
      while (!store.get(instance.sessionId, instance.address)?.native.connected) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error('native bridge did not connect: ' + stderr)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const args = { source: 'selection', limit: 5000, expand_blocks: true, max_bytes: 4 * 1024 * 1024 }
      const selected = await bridge.queryDrawingEntities(instance.instanceId, args)
      assert.equal(selected.source, 'selection')
      assert.equal(selected.entities.length, 1)
      assert.equal(selected.entities[0].text.plain, 'collar')
      assert.deepEqual(selected.entities[0].text.insertion, [2, 3, 0])
      const document = await bridge.queryDrawingEntities(instance.instanceId, { ...args, source: 'document' })
      assert.ok(Buffer.byteLength(JSON.stringify(document)) > 64 * 1024)
      assert.equal(document.counts.failed, 0)
      assert.ok(document.entities.length > 1500)
      assert.deepEqual(document.entities.find(entity => entity.handle === selected.entities[0].handle), selected.entities[0])
      assert.match(document.document_digest, /^document:[a-f0-9]{64}$/)
      assert.match(selected.document_digest, /^selection:[a-f0-9]{64}$/)
      assert.notEqual(document.digest_kind, selected.digest_kind)
      assert.equal(document.origin_digest, selected.origin_digest)
      const stale = await bridge.queryDrawingEntities(instance.instanceId, { ...args, selection_version: 999 })
      assert.equal(stale.error.code, 'stale_selection')
      const cancel = new AbortController()
      const cancelled = bridge.queryDrawingEntities(instance.instanceId, { ...args, source: 'document' }, cancel.signal)
      cancel.abort()
      assert.equal((await cancelled).error.code, 'cancelled')
      const again = await bridge.queryDrawingEntities(instance.instanceId, args)
      assert.equal(again.entities[0].text.plain, 'collar')
    } finally {
      bridge.shutdown()
      await new Promise(resolve => server.close(resolve))
      const [code] = await exited
      assert.equal(code, 0, stderr)
    }
  })
