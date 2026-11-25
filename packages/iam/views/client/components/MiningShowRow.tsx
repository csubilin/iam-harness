import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  documentAddress, isRefusal, readShowCard, requestSelection, shouldAutoOpen, summarize,
} from '../core/mining-show'
import type { Translate } from '../core/embedded-view'

/** One observable the pane reads, as `dsh-client-store` publishes them. */
export interface ObservableLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The calls this row has already opened a panel for, so a rerender cannot reopen one. */
const openedCalls = new Set<string>()

/**
 * The props the slot runtime supplies plus the face `client/index.tsx` injects,
 * typed structurally.
 *
 * Structural rather than imported for the reason `ViewerView`'s are: a client
 * bundle resolves `require` against a fixed seed table, so a value import from
 * the harness's own packages would throw at materialization. Type-only imports
 * would erase safely; a structural type keeps the constraint visible and costs
 * nothing.
 */
export interface ShowRowProps {
  readonly phase: 'preparing' | 'start' | 'result'
  readonly block: { readonly meta?: unknown }
  readonly callId: string
  readonly sessionId: string
  readonly t: Translate
  /** Open a document in the right sidebar's document pane. */
  readonly openPanel: (address: string) => void
  /** The session whose sidebar is on screen, or undefined while none is. */
  readonly sidebarMounted: ObservableLike<string | undefined>
}

/**
 * The half of the row's props its own package supplies.
 *
 * Named separately because the registration is where they are built
 * (`client/index.tsx`), and the harness merges an `inject` face into the runtime
 * props -- so the row is handed one object and neither side has to know how the
 * other produced its half.
 */
export type ShowRowInjected = Pick<ShowRowProps, 'openPanel' | 'sidebarMounted'>

/** Read one observable the slot face handed down. */
function useObserved<T>(source: ObservableLike<T>): T {
  // Wrapped rather than passed by reference: the store's members are not
  // guaranteed to be bound, and an unbound `subscribe` handed to React throws on
  // the first render that has to subscribe.
  return useSyncExternalStore(
    listener => source.subscribe(listener),
    () => source.getSnapshot(),
  )
}

const ROW: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 3, margin: '4px 0',
  padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #2a3c44)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)',
}
const TITLE: React.CSSProperties = { fontSize: 12, fontWeight: 600 }
const DETAIL: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }
const REFUSED: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary, inherit)' }
const BUTTON: React.CSSProperties = {
  alignSelf: 'flex-start', marginTop: 2, fontSize: 12, padding: '2px 8px', cursor: 'pointer',
  borderRadius: 4, border: '1px solid var(--dsw-alias-border-l3, #2a3c44)', background: 'transparent',
  color: 'var(--dsw-alias-brand-primary, inherit)',
}

/**
 * One `iam_mining_show` call: what it showed, and a way in.
 */
export function MiningShowRow(props: ShowRowProps): JSX.Element | null {
  const { phase, block, callId, sessionId, t, openPanel, sidebarMounted } = props
  const mounted = useObserved(sidebarMounted)

  // Whether this row saw its call RUN. A row that mounts already settled is
  // history -- a reopened session, a scroll back to an old turn -- and opening a
  // panel for it would make reading the log launch every view it ever mentioned.
  const watched = useRef(false)
  if (phase !== 'result') watched.current = true

  const card = phase === 'result' ? readShowCard(block?.meta) : null
  const address = card !== null && !isRefusal(card) && card.opened === 'panel'
    ? documentAddress(sessionId, card.relativePath)
    : null

  const open = (): void => {
    if (card === null || isRefusal(card) || address === null) return
    // The pane is told what to draw BEFORE it is asked to open: on the first call
    // the two land in the same commit and the order is what makes the selection
    // wait for the document instead of arriving after a first full-scene frame.
    requestSelection(address, card.selection.join('\n'))
    openedCalls.add(callId)
    openPanel(address)
  }

  useEffect(() => {
    if (card === null || address === null) return
    const alreadyOpened = openedCalls.has(callId)
    if (!shouldAutoOpen(card, { watchedItRun: watched.current, alreadyOpened })) return
    if (mounted === undefined) return
    requestSelection(address, card.selection.join('\n'))
    openedCalls.add(callId)
    openPanel(address)
  }, [card, address, callId, mounted, openPanel])

  if (card === null) {
    // Nothing to say while the call runs, and nothing to say for a result this
    // build cannot read -- both fall back to the harness's own generic row.
    return phase === 'result'
      ? null
      : <div style={ROW} data-mining-show="preparing"><span style={TITLE}>{t('showPreparing')}</span></div>
  }

  if (isRefusal(card)) {
    // A refusal is a real answer and it stays on screen: the model may correct
    // itself from it, and a user watching should see why nothing was shown.
    return <div style={ROW} data-mining-show="refused">
      <span style={TITLE}>{t('showRefused')}</span>
      <span style={REFUSED}>{card.refused}</span>
    </div>
  }

  if (card.opened === 'native') {
    // Started by the tool, on the user's machine: there is nothing here to open
    // and nothing this page could do about it if there were.
    return <div style={ROW} data-mining-show="native">
      <span style={TITLE}>{card.title || t('showUntitled')}</span>
      <span style={DETAIL}>{t('showNative')} · {summarize(card)}</span>
    </div>
  }

  return <div style={ROW} data-mining-show="ready">
    <span style={TITLE}>{card.title || t('showUntitled')}</span>
    <span style={DETAIL}>{summarize(card)}</span>
    <button type="button" style={BUTTON} aria-label={t('showOpen')} onClick={open}>
      {t('showOpen')}
    </button>
  </div>
}
