import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

import { cleanup, fakeTools, loadToolHost } from './helpers.mjs'

after(cleanup)

const repository = await loadToolHost('mining-repository')
const pythonHalf = await loadToolHost('mining-repository', ['python'])
const { name, inject, apply } = repository.index

const PROJECT = 'D:/dev/MiningFlatform/workspace/test1.iam'
const STORE = 'D:/dev/MiningFlatform/workspace/test2.iamh'
const WORKSPACE = 'D:/dev/MiningFlatform/workspace'
const OREBODY = 'merge-1-dimine-36-entity-0'
const PLATFORM = existsSync(PROJECT)
const SKIP = 'needs the built platform and D:/dev/MiningFlatform/workspace/test1.iam'

/**
 * Mount the plugin the way a profile does and hand back its tool table.
 *
 * `carrier` is what `profileContext.name` would say -- 'desktop' on the shell,
 * 'web' in a browser -- and it is the whole of what decides whether a columnar
 * store can be shown at all.
 */
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

function exec(agent = { id: 'session' }) {
  return { signal: new AbortController().signal, agent }
}

async function call(tools, args, agent) {
  const definition = tools.registered.get('iam_mining_show')
  assert.ok(definition, 'iam_mining_show is not registered')
  const value = await definition.execute(args, exec(agent))
  assert.ok(value !== null && typeof value === 'object', 'the tool must return an object value')
  assert.equal(value.content, undefined, 'the tool returned a content envelope; this contract renders via output.render')
  const blocks = definition.output.render(args, value)
  const meta = definition.output.presentationMeta?.(args, value)
  return { value, text: blocks[0].text, meta }
}

describe('MiningRepository host half', () => {
  test('exports the identity a patch row has to name', () => {
    assert.equal(name, 'iam-mining-repository')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof apply, 'function')
  })

  test('IAM_REPOSITORY_SCRIPT names the copy outside app.asar', () => {
    // A packaged Desktop cannot run the asar copy: Python opens a real file.
    // The vendored bindings are then taken beside it rather than from the
    // package root, which is inside the archive.
    const directory = mkdtempSync(join(tmpdir(), 'iam-repository-script-'))
    const script = join(directory, 'repository.py')
    writeFileSync(script, '')
    const previous = process.env.IAM_REPOSITORY_SCRIPT
    process.env.IAM_REPOSITORY_SCRIPT = script
    try {
      assert.equal(pythonHalf.python.repositoryScript(), script)
    } finally {
      if (previous === undefined) delete process.env.IAM_REPOSITORY_SCRIPT
      else process.env.IAM_REPOSITORY_SCRIPT = previous
      rmSync(dirname(script), { recursive: true, force: true })
    }
  })

  test('registers exactly the tools the manifest lists, and no others', () => {
    // The names are pinned because the Harness tool table is ONE global layer: a
    // name that collides with another bundle is not a merge, it is this plugin
    // failing to load.  The write door added three of them, and this is where
    // that stays a decision rather than an accident.
    assert.deepEqual([...mount().registered.keys()], [
      'iam_mining_show', 'iam_mine_edit', 'iam_mine_verb', 'iam_mine_document', 'iam_mine_apply',
    ])
  })

  test('every tool declares a real description and an object schema', () => {
    for (const definition of mount().registered.values()) {
      assert.ok(definition.description.length > 100, `${definition.name} needs a real description`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.parameters.additionalProperties, false,
        `${definition.name} must refuse arguments it does not declare`)
      assert.equal(typeof definition.output.render, 'function')
    }
  })

  test('every tool but the document reader names the project it acts on', () => {
    // `iam_mine_document` is the exception and it is the point of that tool: a
    // document names the project it is FOR, so reading one needs none -- which is
    // what lets an edit be inspected before anyone decides which mine it lands
    // on.  Every other tool has to be told.
    for (const definition of mount().registered.values()) {
      if (definition.name === 'iam_mine_document') {
        assert.deepEqual(definition.parameters.required, ['document'])
        continue
      }
      assert.ok(definition.parameters.required.includes('project'),
        `${definition.name} must name a project`)
    }
  })

  test('the show tool keeps the presentation metadata its card is built from', () => {
    // Only the show tool: nothing renders a card for the write door yet, and a
    // metadata blob no client reads is a second description of the result.
    assert.equal(typeof mount().registered.get('iam_mining_show').output.presentationMeta, 'function')
  })

  test('exactly one tool changes a project, and it is apply', () => {
    // The whole safety argument of this plugin is that an edit produces a
    // document and something else publishes it.  If a second tool could write,
    // that argument would be about which one the model happened to call.
    const writing = [...mount().registered.keys()].filter((key) => ![
      'iam_mining_show', 'iam_mine_edit', 'iam_mine_verb', 'iam_mine_document',
    ].includes(key))
    assert.deepEqual(writing, ['iam_mine_apply'])
  })

  test('a call with no elements is refused before anything runs', async () => {
    const definition = mount().registered.get('iam_mining_show')
    await assert.rejects(() => definition.execute({ project: 'x.iam', elements: [] }, exec()),
      /"elements" is required/)
    await assert.rejects(() => definition.execute({ project: 'x.iam' }, exec()),
      /"elements" is required/)
    await assert.rejects(() => definition.execute({ project: 'x.iam', elements: ['a', ''] }, exec()),
      /non-empty id/)
  })

  test('an id the project does not have is refused by name, not shown as an empty scene',
    { skip: !PLATFORM && SKIP }, async () => {
      const tools = mount({}, WORKSPACE)
      const { value, meta } = await call(tools, { project: 'test1.iam', elements: ['not-an-element'] })
      assert.equal(value.ok, false)
      assert.match(String(value.refused), /not-an-element/)
      // The refusal travels to the card as well: a reader has to see why nothing
      // was shown, and the model has to be able to correct itself from it.
      assert.match(String(meta.refused), /not-an-element/)
    })

  test('a portable .iam is shown in the panel, with the selection the view will be given',
    { skip: !PLATFORM && SKIP }, async () => {
      const tools = mount({}, WORKSPACE)
      const before = statSync(PROJECT)
      const { value, text, meta } = await call(tools, { project: 'test1.iam', elements: [OREBODY], title: '矿体' })

      assert.equal(value.ok, true, `expected a document, got: ${value.refused ?? ''}`)
      assert.equal(value.opened, 'panel')
      assert.equal(value.container, 'iam')
      // The doc the panel opens is the SOURCE, by its workspace-relative path --
      // no second file anywhere, which is what this design is.
      assert.equal(value.relative_path, 'test1.iam')
      assert.equal(value.project.replace(/\\/g, '/'), PROJECT)

      // TWO FIELDS, TWO TYPES, and the card takes the one it can read: the ids
      // as an array (what the client's reader narrows), and the line format the
      // view is handed.  One field serving both is what made the card read a
      // string where it expected an array and quietly ask for the whole document.
      assert.deepEqual(value.selection, [OREBODY])
      assert.equal(value.view_selection, OREBODY)
      assert.deepEqual(meta.selection, [OREBODY])
      assert.equal(meta.relativePath, 'test1.iam')
      assert.equal(meta.opened, 'panel')
      assert.equal(meta.autoOpen, true, 'the default is to show it: the user asked to see it')

      // And the project was only READ.
      const after_ = statSync(PROJECT)
      assert.equal(after_.size, before.size)
      assert.equal(after_.mtimeMs, before.mtimeMs)
      assert.match(text, /面板/)
    }, )

  test('present:false leaves the card and does not ask for the panel to open',
    { skip: !PLATFORM && SKIP }, async () => {
      const tools = mount({}, WORKSPACE)
      const { meta } = await call(tools, { project: 'test1.iam', elements: [OREBODY], present: false })
      assert.equal(meta.autoOpen, false)
    })

  test('a project outside the session workspace is refused rather than misaddressed',
    { skip: !PLATFORM && SKIP }, async () => {
      // The Views host resolves addresses inside the session's workspace and
      // refuses anything else, so handing it an outside path would produce a pane
      // that says "not found" -- a worse answer than this one.
      const tools = mount({}, 'D:/somewhere/else')
      const { value } = await call(tools, { project: PROJECT, elements: [OREBODY] })
      assert.equal(value.ok, false)
      assert.match(String(value.refused), /outside the session workspace/)
    })

  test('a columnar store is refused on the web, by name',
    { skip: !(PLATFORM && existsSync(STORE)) && 'needs both test1.iam and test2.iamh' }, async () => {
      const tools = mount({}, WORKSPACE, 'web')
      const { value, meta } = await call(tools, { project: 'test2.iamh', elements: [OREBODY] })
      assert.equal(value.ok, false)
      assert.equal(value.container, 'iamh')
      assert.match(String(value.refused), /columnar store/)
      assert.match(String(meta.refused), /columnar store/)
    })

  test('and on the desktop it is not refused for that reason: it wants an editor',
    { skip: !(PLATFORM && existsSync(STORE)) && 'needs both test1.iam and test2.iamh' }, async () => {
      // No binary directory is configured for this test, so the call stops at the
      // refusal that names what to configure -- which is the whole of what can be
      // asserted without opening a window on whoever runs the suite.
      const tools = mount({}, WORKSPACE, 'desktop')
      const { value } = await call(tools, { project: 'test2.iamh', elements: [OREBODY] })
      assert.equal(value.ok, false)
      assert.equal(value.container, 'iamh')
      assert.match(String(value.refused), /native editor is not configured/)
    })

  test('a configured binary directory with no editor in it names the path it tried',
    { skip: !(PLATFORM && existsSync(STORE)) && 'needs both test1.iam and test2.iamh' }, async () => {
      const tools = mount({ nativeBinDir: 'D:/no/such/directory', fontsDir: 'D:/no/such/fonts' }, WORKSPACE, 'desktop')
      const { value } = await call(tools, { project: 'test2.iamh', elements: [OREBODY] })
      assert.equal(value.ok, false)
      assert.match(String(value.refused), /noExecutable/)
      assert.match(String(value.refused), /IamMining/)
    })

  test('the session\'s workspace beats the configured one, and a relative project resolves against it',
    { skip: !PLATFORM && SKIP }, async () => {
      // Asserted end to end rather than against a mock: a RELATIVE project path
      // can only succeed if the workspace travelled to the program, and the
      // configured root is deliberately wrong so that the session's directory
      // winning is what makes the call work.
      const tools = mount({ workspace: 'D:/not-the-workspace' }, WORKSPACE)
      const { value } = await call(tools, { project: 'test1.iam', elements: [OREBODY] })
      assert.equal(value.ok, true, `expected a document, got: ${value.refused ?? ''}`)
      assert.equal(value.relative_path, 'test1.iam')
    })

  test('with no working directory and no configured one, a relative project cannot be found',
    { skip: !PLATFORM && SKIP }, async () => {
      const tools = mount()
      const { value } = await call(tools, { project: 'test1.iam', elements: [OREBODY] })
      assert.equal(value.ok, false)
      assert.match(String(value.refused), /no such project|refused/)
    })
})
