#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(here, '..', '..', '..', '..')

const VIEWS = process.env.IAX_WASM_VIEWS ?? resolve(checkout, 'build', 'bin', 'wasm')
const PROJECT = process.argv[2] ?? resolve(checkout, '..', 'workspace', 'test1.iam')
const ELEMENT = process.argv[3] ?? 'merge-1-dimine-36-entity-0'
const PAGE = '/views/IamMiningView.html'

/** Where Chrome is: named, or the two places a Windows install puts it. */
const CHROME = process.env.IAX_CHROME
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => existsSync(path))

const HTTP_PORT = Number(process.env.IAX_VERIFY_PORT ?? 8097)
const CDP_PORT = Number(process.env.IAX_VERIFY_CDP ?? 9227)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function serve() {
  return new Promise((resolve_) => {
    const server = createServer((req, res) => {
      const path = normalize(join(VIEWS, decodeURIComponent(req.url.split('?')[0])))
      if (!path.startsWith(normalize(VIEWS)) || !existsSync(path)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-length': String(statSync(path).size) })
      createReadStream(path).pipe(res)
    })
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve_(server))
  })
}

async function targetUrl() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error('Chrome never published a page target')
}

/** A minimal CDP client over the WebSocket Node ships.  No dependencies. */
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data)
    if (frame.id !== undefined) {
      const settle = pending.get(frame.id)
      pending.delete(frame.id)
      if (settle) settle(frame)
    }
  })
  const ready = new Promise((resolve_, reject) => {
    socket.addEventListener('open', resolve_)
    socket.addEventListener('error', reject)
  })
  const send = (method, params = {}) => new Promise((resolve_, reject) => {
    const id = next++
    pending.set(id, (frame) => (frame.error ? reject(new Error(`${method}: ${frame.error.message}`)) : resolve_(frame.result)))
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { ready, send, close: () => socket.close() }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  }
  return result.result.value
}

/** The empty share of the canvas, and a coarse grid for the diagnostics. */
const MEASURE = `(async () => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { error: 'no canvas' };
  const img = new Image();
  img.src = canvas.toDataURL('image/png');
  await img.decode();
  const scratch = document.createElement('canvas');
  scratch.width = img.width; scratch.height = img.height;
  const ctx = scratch.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let clear = 0;
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 8 && data[i+1] < 8 && data[i+2] < 8) clear += 1;
  }
  const N = 24, cellWidth = img.width / N, cellHeight = img.height / N, grid = [];
  for (let row = 0; row < N; row += 1) {
    for (let column = 0; column < N; column += 1) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(row * cellHeight); y < Math.min(img.height, (row + 1) * cellHeight); y += 3) {
        for (let x = Math.floor(column * cellWidth); x < Math.min(img.width, (column + 1) * cellWidth); x += 3) {
          const i = (y * img.width + x) * 4;
          r += data[i]; g += data[i+1]; b += data[i+2]; n += 1;
        }
      }
      grid.push([Math.round(r/n/8), Math.round(g/n/8), Math.round(b/n/8)]);
    }
  }
  return { size: img.width + 'x' + img.height, clearPct: +(100 * clear / total).toFixed(2), grid };
})()`

/** How many of the 576 cells differ between two states. */
function difference(first, second) {
  let cells = 0
  for (let i = 0; i < first.grid.length; i += 1) {
    const a = first.grid[i], b = second.grid[i]
    if (Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]) > 2) cells += 1
  }
  return cells / first.grid.length
}

/** Call the export with a UTF-8 string, the way the pane's EmbeddedView does. */
const call = (text) => `(() => {
  const set = Module._iamSetVisibleSelection;
  if (typeof set !== 'function') return 'no export';
  const bytes = new TextEncoder().encode(${JSON.stringify(text)});
  const pointer = Module._malloc(bytes.length + 1);
  if (!pointer) return 'no memory';
  Module.HEAPU8.set(bytes, pointer);
  Module.HEAPU8[pointer + bytes.length] = 0;
  set(pointer, bytes.length);
  Module._free(pointer);
  return 'ok';
})()`

/**
 * Every frame's emptiness, recorded IN THE PAGE.
 *
 * Polling from here cannot see a one-frame flash -- at 60 Hz it is 16 ms and a
 * round trip to the browser is longer than that.  So the page samples itself on
 * requestAnimationFrame, from BEFORE the document is opened, and the series is
 * read back afterwards.  A downscaled 160x90 read is enough to tell "geometry is
 * on screen" from "the viewport is empty" and cheap enough to run per frame.
 */
const RECORD_FRAMES = `(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return 'no canvas';
  const scratch = document.createElement('canvas');
  scratch.width = 160; scratch.height = 90;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  globalThis.__iaxFrames = [];
  // THROUGH toDataURL AND NOT drawImage(canvas, ...), which reads ALL BLACK for a
  // WebGPU canvas -- measured here, and it made every sampled frame look like an
  // empty viewport.  The drawing buffer is not what drawImage reads; the encoded
  // snapshot is what the browser actually presented.
  const sample = async () => {
    for (;;) {
      try {
        if (canvas.width > 0) {
          const img = new Image();
          img.src = canvas.toDataURL('image/png');
          await img.decode();
          ctx.drawImage(img, 0, 0, 160, 90);
          const data = ctx.getImageData(0, 0, 160, 90).data;
          let clear = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 8 && data[i+1] < 8 && data[i+2] < 8) clear += 1;
          }
          globalThis.__iaxFrames.push([Math.round(performance.now()), +(clear / (160 * 90)).toFixed(3)]);
        }
      } catch { /* a frame we could not read is not a frame that did not happen */ }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  void sample();
  return 'recording';
})()`

/** Set what is shown, let it settle, and read the canvas. */
async function measureAfter(cdp, selection, settleMs) {
  const answer = await evaluate(cdp, call(selection))
  if (answer !== 'ok') throw new Error(`the isolate call answered ${answer}`)
  await sleep(settleMs)
  return evaluate(cdp, MEASURE, true)
}

async function main() {
  if (CHROME === undefined) {
    console.error('verify-selection: no Chrome found; set IAX_CHROME to one')
    return 2
  }
  if (!existsSync(PROJECT)) {
    console.error(`verify-selection: no project at ${PROJECT}`)
    return 2
  }

  const server = await serve()
  const profile = mkdtempSync(join(tmpdir(), 'iax-verify-'))
  const headless = process.env.IAX_HEADLESS === '1'
  const chrome = spawn(CHROME, [
    ...(headless
      ? ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
         '--enable-features=Vulkan,UseSkiaRenderer', '--use-vulkan=swiftshader']
      : ['--new-window', '--window-size=1000,760', '--window-position=0,0']),
    '--enable-unsafe-webgpu', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `http://127.0.0.1:${HTTP_PORT}${PAGE}`,
  ], { stdio: 'ignore' })

  let failure = null
  const cdp = connect(await targetUrl())
  await cdp.ready
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Page.bringToFront')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    for (let attempt = 0; attempt < 300; attempt += 1) {
      const up = await evaluate(cdp, 'typeof Module !== "undefined" && typeof Module._iamOpenBytes === "function"')
      if (up === true) break
      if (attempt === 299) throw new Error('the wasm module never published its entry points')
      await sleep(200)
    }

    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#iam-file-input' })
    if (!nodeId) throw new Error('the page has no #iam-file-input')

    // ---------------------------------------------------------------- first frame
    //
    // THE SELECTION IS SET BEFORE THE DOCUMENT EXISTS, which is the order the
    // pane uses and the one the view's entry point is designed around.  What is
    // being measured is whether the FIRST frame that shows anything already shows
    // only the selection -- the user's report was that the whole mine appeared and
    // was then hidden, which costs a full vectorisation of graphics nobody asked
    // for.
    console.log(`opening ${PROJECT} (${(statSync(PROJECT).size / 1048576).toFixed(1)} MiB) with the selection set first…`)
    if (await evaluate(cdp, RECORD_FRAMES) !== 'recording') throw new Error('the frame recorder would not start')
    const preOpen = await evaluate(cdp, call(ELEMENT))
    if (preOpen !== 'ok') throw new Error(`the isolate call answered ${preOpen}`)
    await cdp.send('DOM.setFileInputFiles', { files: [PROJECT], nodeId })

    // Wait for the document, then let a few frames settle.
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await sleep(1000)
      const measured = await evaluate(cdp, MEASURE, true)
      if (measured.clearPct < 60) break
      if (attempt % 15 === 14) console.log(`  ${attempt + 1}s… empty=${measured.clearPct}%`)
      if (attempt === 299) {
        const status = await evaluate(cdp, 'document.getElementById("status")?.textContent ?? ""')
        throw new Error(`nothing was ever drawn: empty=${measured.clearPct}% status=${status}`)
      }
    }
    await sleep(3000)

    const frames = await evaluate(cdp, 'globalThis.__iaxFrames ?? []')
    // A frame SHOWING THE DOCUMENT, told apart from the two other things the
    // canvas does: an empty viewport (emptiness near 1) and the busy overlay the
    // host presents before it runs the open (emptiness 0 -- a frame covered
    // edge to edge, measured).  The scene itself reads 0.37 to 0.49.
    const drawn = frames.filter(([, empty]) => empty > 0.2 && empty < 0.55)
    const firstDrawn = drawn[0]
    const lastDrawn = drawn[drawn.length - 1]
    console.log(`frames recorded: ${frames.length}, of them showing the document: ${drawn.length}`)
    console.log(`  first such frame at ${firstDrawn?.[0] ?? '-'}ms: empty=${firstDrawn?.[1] ?? '-'}`
      + `   (a whole-document frame reads ~0.40, an isolated one ~0.48)`)
    console.log(`  last such frame: empty=${lastDrawn?.[1] ?? '-'}`)

    // ------------------------------------------------------------- the four states
    const states = {}
    states.everything = await measureAfter(cdp, '', 3500)
    states.element = await measureAfter(cdp, ELEMENT, 3500)
    states.nomatch = await measureAfter(cdp, 'no-such-element-xyz', 3500)
    states.restored = await measureAfter(cdp, '', 3500)

    const empty = (state) => state.clearPct
    console.log(`\ncanvas ${states.everything.size}`)
    for (const [name, state] of Object.entries(states)) {
      console.log(`  ${name.padEnd(9)} viewport empty: ${String(state.clearPct).padStart(5)}%`)
    }
    console.log(`  cells differing: whole-vs-nomatch ${(difference(states.everything, states.nomatch)*100).toFixed(1)}%,`
      + ` element-vs-nomatch ${(difference(states.element, states.nomatch)*100).toFixed(1)}%,`
      + ` restored-vs-everything ${(difference(states.restored, states.everything)*100).toFixed(1)}%`)

    const checks = [
      // THE FIRST FRAME ALREADY SHOWS THE SELECTION, which is what makes opening
      // a mine with a selection cheap: the hidden set is in place before the
      // display entities are told they are visible, so nothing generates graphics
      // for what was not asked for -- and `warmBlockModelSurfaces()`, which skips
      // hidden models, never builds a block model's boundary mesh to throw it
      // away.  An implementation that applies the selection after the open shows
      // the whole document first.
      //
      // MEASURED AGAINST THE WHOLE-DOCUMENT STATE RATHER THAN A THRESHOLD OF ITS
      // OWN, and it has to be a DIFFERENCE: a midpoint between two states would
      // pass when nothing works at all, because every state is then the whole
      // document and they all agree (measured -- the first version of this check
      // passed a deliberately neutered build).  The first frame must be
      // measurably emptier than the document it could have shown.
      ['the FIRST frame with the document already shows only the selection',
        firstDrawn !== undefined && firstDrawn[1] * 100 > empty(states.everything) + 3],
      ['the document draws to begin with', empty(states.everything) < 45],
      // Isolating one element must EMPTY part of what was on screen.  An empty
      // setVisibleSelection() leaves every state at the `whole` number, which is
      // what these four orderings exist to catch.
      ['isolating one element empties the view',
        empty(states.element) > empty(states.everything) + 5],
      // ...and still DRAWS it: the viewport is not as empty as one where nothing
      // matched at all.  This is the pair that says "the right thing was kept",
      // not merely "something changed".
      ['and the element asked for is still drawn',
        empty(states.element) < empty(states.nomatch) - 3],
      ['a selection that matches nothing empties the scene',
        empty(states.nomatch) > empty(states.everything) + 10],
      // The document is back.  Not pixel-identical: the restore frames with fit(),
      // the toolbar's own whole-scene fit, while the open frames with the view's
      // extents sequence -- so this asserts the whole mine is on screen again,
      // which is to say a fuller picture than the isolated one.
      ['an empty selection brings the document back',
        empty(states.restored) < empty(states.element) && empty(states.restored) < empty(states.everything) + 12],
    ]
    console.log('')
    let bad = 0
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
      if (!ok) bad += 1
    }
    failure = bad === 0 ? null : `${bad} check(s) failed`
  } catch (error) {
    failure = error.message
  } finally {
    cdp.close()
    chrome.kill()
    server.close()
  }
  console.log(failure === null ? '\nPASS' : `\nFAIL: ${failure}`)
  return failure === null ? 0 : 1
}

process.exit(await main())
