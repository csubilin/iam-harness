import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { loadClientModule, loadToolHost } from './helpers.mjs'

const pointer = await loadClientModule('views', 'client/core/mining-show.ts')
const repository = await loadToolHost('mining-repository', ['tools'])
const {
  MINING_SHOW, readShowCard, isRefusal, documentAddress, shouldAutoOpen, summarize,
  requestSelection, selectionFor, observeSelections,
} = pointer

/** A card as the tool projects it, with every field it actually sends. */
function meta(overrides = {}) {
  return {
    relativePath: 'test1.iam',
    title: '矿体',
    selection: ['merge-1-dimine-36-entity-0'],
    summary: { elements: 1, geometry: 1 },
    opened: 'panel',
    autoOpen: true,
    ...overrides,
  }
}

describe('the tool name the two halves share', () => {
  test('the pane keys its row by the name the host half registers', () => {
    assert.equal(MINING_SHOW, repository.tools.MINING_SHOW)
    assert.equal(MINING_SHOW, 'iam_mining_show')
  })
})

describe('reading the card out of a tool result', () => {
  test('a real card survives the trip', () => {
    const card = readShowCard(meta())
    assert.equal(card.relativePath, 'test1.iam')
    assert.equal(card.title, '矿体')
    assert.deepEqual(card.selection, ['merge-1-dimine-36-entity-0'])
    assert.deepEqual(card.summary, { elements: 1, geometry: 1 })
    assert.equal(card.opened, 'panel')
    assert.equal(card.autoOpen, true)
    assert.equal(isRefusal(card), false)
  })

  test('a refusal is a card too, because a reader has to see why', () => {
    const card = readShowCard({ refused: 'no element \'nope\' in test1.iam' })
    assert.equal(isRefusal(card), true)
    assert.match(card.refused, /nope/)
    assert.equal(shouldAutoOpen(card, { watchedItRun: true, alreadyOpened: false }), false)
  })

  test('a native card has no path and is still readable', () => {
    // The editor was handed an absolute path on the user's machine; what this
    // page needs to know is that something happened somewhere else.
    const card = readShowCard({ opened: 'native', title: '矿体', summary: { elements: 1, geometry: 1 } })
    assert.equal(card.opened, 'native')
    assert.equal(card.relativePath, '')
    assert.equal(shouldAutoOpen(card, { watchedItRun: true, alreadyOpened: false }), false,
      'this pane has nothing to open for a document an editor already has')
  })

  test('anything else is null, so the generic row renders instead of a blank card', () => {
    // Every one of these arrives from a session log a DIFFERENT build may have
    // written, so the reader has to survive values it did not produce.
    for (const junk of [undefined, null, 'text', 42, [], {}, { title: 'no path' },
      { relativePath: '' }, { relativePath: 7 }]) {
      assert.equal(readShowCard(junk), null, `expected null for ${JSON.stringify(junk)}`)
    }
  })

  test('fields that are the wrong type are defaulted, not trusted', () => {
    const card = readShowCard({ relativePath: 'test1.iam', summary: 'nonsense', selection: 'no', opened: 7 })
    assert.deepEqual(card.summary, { elements: 0, geometry: 0 })
    assert.deepEqual(card.selection, [])
    assert.equal(card.opened, 'panel')
    assert.equal(card.autoOpen, true)
    assert.equal(readShowCard({ relativePath: 't.iam', autoOpen: false }).autoOpen, false)
  })

  test('a selection with a non-string in it keeps the strings', () => {
    const card = readShowCard(meta({ selection: ['a', 7, null, 'b'] }))
    assert.deepEqual(card.selection, ['a', 'b'])
  })
})

describe('the address the panel opens', () => {
  test('it is exactly the grammar the host half resolves', () => {
    assert.equal(
      documentAddress('session-1', 'test1.iam'),
      'dsh-resource://file/session/session-1/test1.iam',
    )
  })

  test('each segment is component-encoded, so a space or a hash survives', () => {
    assert.equal(
      documentAddress('s', '矿体 视图#1.iam'),
      'dsh-resource://file/session/s/%E7%9F%BF%E4%BD%93%20%E8%A7%86%E5%9B%BE%231.iam',
    )
  })

  test('a Windows separator and a leading ./ are normalized, not passed through', () => {
    assert.equal(documentAddress('s', 'sub\\mine.iam'), 'dsh-resource://file/session/s/sub/mine.iam')
    assert.equal(documentAddress('s', './mine.iam'), 'dsh-resource://file/session/s/mine.iam')
  })
})

describe('whether the panel opens by itself', () => {
  test('the tool said to present AND this row watched the call happen', () => {
    assert.equal(shouldAutoOpen(readShowCard(meta()), { watchedItRun: true, alreadyOpened: false }), true)
  })

  test('a row that was already settled when it mounted opens nothing', () => {
    // This is the one that matters: reopening yesterday's conversation must not
    // launch every panel it ever mentioned.
    assert.equal(shouldAutoOpen(readShowCard(meta()), { watchedItRun: false, alreadyOpened: false }), false)
  })

  test('the same call is opened once, however many times it rerenders', () => {
    assert.equal(shouldAutoOpen(readShowCard(meta()), { watchedItRun: true, alreadyOpened: true }), false)
  })

  test('present:false leaves the card and its button', () => {
    assert.equal(shouldAutoOpen(readShowCard(meta({ autoOpen: false })),
      { watchedItRun: true, alreadyOpened: false }), false)
  })
})

describe('what the pane is told to draw', () => {
  test('a selection is remembered for the address it was aimed at', () => {
    requestSelection('dsh-resource://file/session/s/a.iam', 'orebody')
    assert.equal(selectionFor('dsh-resource://file/session/s/a.iam').selection, 'orebody')
    assert.equal(selectionFor('dsh-resource://file/session/s/b.iam'), undefined)
  })

  test('a later selection for the same address replaces the earlier one', () => {
    // "显示矿体" then "显示巷道" on one document: same pane, new instruction.
    requestSelection('dsh-resource://file/session/s/c.iam', 'first')
    requestSelection('dsh-resource://file/session/s/c.iam', 'second')
    assert.equal(selectionFor('dsh-resource://file/session/s/c.iam').selection, 'second')
  })

  test('an observer hears about every address and can stop hearing', () => {
    const heard = []
    const stop = observeSelections((address) => heard.push(address))
    requestSelection('x', 'one')
    requestSelection('y', 'two')
    stop()
    requestSelection('z', 'three')
    assert.deepEqual(heard, ['x', 'y'])
  })

  test('an empty selection is a selection: it means "show everything"', () => {
    requestSelection('dsh-resource://file/session/s/d.iam', '')
    assert.equal(selectionFor('dsh-resource://file/session/s/d.iam').selection, '')
  })
})

describe('the card’s one summary line', () => {
  test('it names what was asked for', () => {
    assert.equal(summarize(readShowCard(meta())), '1 元素 · 1 几何')
  })
})
