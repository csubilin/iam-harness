import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
// A platform module, so the closure resolves it: the strip is drawn into the
// harness's header row, which is not this component's DOM.  See `useHeaderTarget`.
import { createPortal } from 'react-dom'
import {
  EmbeddedView, type DocumentInput, type Translate, type ViewMode,
} from '../core/embedded-view'
import type { Appearance } from '../core/appearance'
import type { ViewDomain } from '../../host/domains'
import { ViewEventBridge } from '../core/view-events'
import { observeSelections, selectionFor } from '../core/mining-show'
import { actionFailureText, refusalText } from '../locales'
import {
  IconAskEdits, IconAskSelection, IconBrowse, IconButton, IconEdit,
  IconInfo, IconNativeBrowse, IconNativeEdit, IconRefresh,
} from './icons'

/** The slice of the document-preview props this body uses. */
export interface DocumentBodyProps {
  /** `{ kind: 'bytes', data }` under the `bytes-complete` load mode. */
  readonly content:
    | { readonly kind: 'bytes'; readonly data: Uint8Array }
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'renderer'; readonly revision: number }
  /** The `dsh-resource://file/session/<id>/<path>` address of the open file. */
  readonly resourceAddress: string
  /** Claim the pane's scrollport; this viewer scrolls nothing. */
  readonly scrollportRef?: (element: HTMLElement | null) => void
}

/**
 * The pane's props: the document, the harness's words, and the harness's
 * appearance.
 *
 * `t` is synthesized by the slot machinery -- `index.tsx` registers this body
 * with `locale: NAMESPACE`, and a slot registration that names a namespace gets
 * the bound translator as a prop.  `appearance` is not synthesized by anything;
 * it comes from the wrapper in `index.tsx`, which is the side that can read
 * `ctx.theme`.
 */
export interface ViewerProps extends DocumentBodyProps {
  /** Which of the package's domains this pane is showing. */
  readonly domain: ViewDomain
  readonly t: Translate
  readonly appearance: Appearance
}

/** How often the pane asks the host what the session's state is. */
const STATUS_POLL_MS = 2000

// How long a view may produce nothing at all before the pane calls it dead.
//
// Generous on purpose: a 30 MB mine is read in tens of seconds under a software
// rasteriser, and the bubble the view raises while it works (see `idle()`) is what
// distinguishes "still working" from "nothing is happening" -- this bound is only
// reached by a view doing neither.
const STARTUP_TIMEOUT_MS = 180_000
const STARTUP_POLL_MS = 1000

/**
 * What to do about a view that failed to start, in the pane's own words.
 *
 * The view reports what happened; the remedy is this side's, because only this
 * side knows which carrier it is on. The case that matters is the one measured on
 * 2026-10-07: an Electron shell with no WebGPU adapter, where the failure is a
 * property of how the hosting browser was started and the user's only moves are
 * to change that or to use the other carrier.
 */
function explainFailure(t: Translate, problem: string): string {
  if (/adapter is unavailable/i.test(problem))
    return t('failedNoAdapter')
  if (/browser WebGPU is unavailable/i.test(problem))
    return t('failedNoWebGPU', {})
  return t('failedOther', { problem })
}


interface HostStatus {
  selection: {
    count: number
    version: number
    /** Every page of this selection has arrived. */
    complete: boolean
    /** The view itself withheld references beyond its own bound. */
    truncated: boolean
    /** How much of the set the host is holding right now. */
    reported: number
    source: string
    at: number
  } | null
  edits: { total: number; unsaved: number }
  lastSave: { path: string; at: number; source: string; revision: number | null } | null
  native: { connected: boolean; pid: number | null; available: boolean }
  /** What a client had to drop because its queue filled up, when anything was. */
  gaps: { droppedFacts: number; at: number; source: string } | null
  lastError: string | null
}

export function ViewerView(props: ViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EmbeddedView | null>(null)
  const bridgeRef = useRef<ViewEventBridge | null>(null)
  const [mode, setMode] = useState<ViewMode>('browse')
  const [status, setStatus] = useState(() => props.t('preparing'))
  const [failed, setFailed] = useState(false)
  const [host, setHost] = useState<HostStatus | null>(null)
  const [nativeNotice, setNativeNotice] = useState<string | null>(null)
  const [staleAt, setStaleAt] = useState<number | null>(null)
  /** Whether the preview holds edits the file does not, for the refresh prompt. */
  const [conflict, setConflict] = useState(false)

  /**
   * Whether the view exists yet, as state rather than only a ref.
   *
   * The effects below read `viewRef.current`, and the effect that fills it is
   * async: on React's first pass they run before there is a view, return at their
   * own guard, and are never run again -- their dependencies do not change.
   * Measured in the harness, that cost the document open and every frame: the
   * pane mounted and then sat on an empty canvas with no request ever made.
   *
   * State is what makes React re-run them the moment the view arrives.
   */
  const [ready, setReady] = useState(false)

  const report = useCallback((message: string, kind: 'status' | 'failure' = 'status') => {
    setStatus(message)
    if (kind === 'failure') setFailed(true)
  }, [])

  const name = basenameOf(props.resourceAddress)
  const headerTarget = useHeaderTarget(containerRef, props.resourceAddress)

  // Mount the view and the bridge, and take both down together.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    props.scrollportRef?.(container)

    const view = new EmbeddedView({ domain: props.domain, appearance: props.appearance, t: props.t })
    const bridge = new ViewEventBridge({
      enableDrawingEntityQueries: props.domain.id === 'drawing',
      route: props.domain.route,
      resourceAddress: props.resourceAddress,
      frame: () => view.element(),
      report,
      t: props.t,
    })
    viewRef.current = view
    bridgeRef.current = bridge

    void (async () => {
      await view.attach(container, mode)
      if (disposed) return
      await bridge.start()
      if (disposed) return
      setReady(true)
    })().catch((error: unknown) => {
      report(error instanceof Error ? error.message : String(error), 'failure')
    })

    return () => {
      disposed = true
      setReady(false)
      setStaleAt(null)
      setConflict(false)
      setHost(null)
      props.scrollportRef?.(null)
      bridge.dispose()
      bridgeRef.current = null
      void view.dispose()
      viewRef.current = null
    }
    // `mode` is deliberately not a dependency: the view is remounted by the mode
    // switch below, and putting it here would tear the whole pane down on a
    // toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resourceAddress, report, props.scrollportRef])

  // Follow a change of appearance or language made in the harness's settings,
  // without reloading the view: the frame is told through the runtime's own
  // entry point (see EmbeddedView.setAppearance), so a theme switch does not
  // cost a re-read of a 30 MB mine.
  useEffect(() => {
    viewRef.current?.setAppearance(props.appearance)
  }, [props.appearance])

  // Hand the document over once both the viewer and its bytes exist -- and
  // `ready` is what makes that "once" happen at all: see its declaration.
  useEffect(() => {
    const view = viewRef.current
    if (!ready || view === null || props.content.kind !== 'bytes') return
    const bytes = new Uint8Array(props.content.data)
    const bridge = bridgeRef.current
    let watching = true
    const startedAt = Date.now()
    const receivedAtStart = bridge?.receivedCount() ?? 0

    /**
     * Watch the view come up, and stop watching when it has.
     *
     * The view renders itself, so there is no frame to acknowledge an open: the
     * pane hands over the bytes and then has nothing to look at. Three things can
     * be true afterwards -- it worked, the view refused and said why on its own
     * banner, or nothing happened at all -- and only the first of them is
     * self-evident. Without this loop the other two both read as "loading", which
     * is what the desktop carrier did for an hour on 2026-10-07.
     */
    const watch = (): void => {
      if (!watching) return
      const problem = view.problem()
      if (problem !== null) {
        watching = false
        view.clearLoading()
        report(explainFailure(props.t, problem), 'failure')
        return
      }
      // An event means the view is running: it publishes from its own frame loop.
      if ((bridge?.receivedCount() ?? 0) > receivedAtStart) {
        watching = false
        report(props.t('opened', { name }))
        return
      }
      if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
        watching = false
        view.clearLoading()
        report(props.t('startupTimeout',
          { name, seconds: Math.round(STARTUP_TIMEOUT_MS / 1000) }), 'failure')
        return
      }
      setTimeout(watch, STARTUP_POLL_MS)
    }
    setTimeout(watch, STARTUP_POLL_MS)

    void view
      .loadDocument({ bytes, name })
      .then(() => report(props.t('opening', { name })))
      .catch((error: unknown) => {
        watching = false
        report(error instanceof Error ? error.message : String(error), 'failure')
      })

    return () => {
      watching = false
    }
  }, [ready, props.content, name, report])

  /**
   * What this document is being asked to SHOW, and keeping up with it.
   *
   * A selection arrives from the card that opened this document
   * (`core/mining-show.ts`), and the pane applies it to the running view: the
   * whole document is loaded and the view is told which items to draw, which is
   * what "显示矿体" means here -- there is no second document anywhere.
   *
   * SUBSCRIBED RATHER THAN READ ONCE, because the second call for a document
   * already on screen is the SAME pane with the same address: no prop changes, so
   * nothing would re-render and the new selection would sit unread.
   *
   * APPLIED AS SOON AS THE VIEW EXISTS, which is safe by construction: the view
   * queues a selection it cannot use yet (it is parsed against the decoded entity
   * list), so there is no race with the document still being read -- see
   * IamView::setVisibleSelection. A `false` from the call means this wasm
   * predates the entry point, and the document then simply draws in full.
   *
   * `props.content` IS A DEPENDENCY, and not for its value: a REFRESH reads the
   * file again and opens it into a fresh page, and the view's hidden set goes with
   * the document it described (`clearSnapshot()`). Without this the selection
   * would survive in this table and be forgotten on screen, which is the one way
   * a refresh could silently lose it.
   */
  useEffect(() => {
    const view = viewRef.current
    if (!ready || view === null) return
    const address = props.resourceAddress
    const apply = (): void => {
      const wanted = selectionFor(address)
      if (wanted !== undefined) view.setVisibleSelection(wanted.selection)
    }
    apply()
    return observeSelections((changed) => {
      if (changed === address) apply()
    })
  }, [ready, props.resourceAddress, props.content])

  // The pane's status line is the HOST's answer, not a count kept here: what it
  // shows is what an agent would be told, and the two must not be able to drift.
  useEffect(() => {
    if (!ready) return
    let running = true
    const poll = async () => {
      const bridge = bridgeRef.current
      if (!running || bridge === null) return
      const answer = (await bridge.status()) as unknown as HostStatus | null
      if (!running) return
      if (answer !== null) {
        setHost(answer)
        // Whether the preview is showing an old copy of the file: the native
        // editor wrote it after this page loaded it.
        const save = answer.lastSave
        if (save !== null && save.source === 'native' && save.at > (viewRef.current?.loadedAt ?? 0)) {
          setStaleAt(save.at)
        }
      }
      setTimeout(() => void poll(), STATUS_POLL_MS)
    }
    void poll()
    return () => {
      running = false
    }
  }, [ready])

  // Whether this carrier can start a native editor, asked once.
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!ready || bridge === null) return
    let running = true
    void bridge.nativeCapability().then((answer) => {
      if (!running) return
      setNativeNotice(answer.available ? null : refusalText(props.t, answer))
    })
    return () => {
      running = false
    }
  }, [ready])

  /**
   * Switch Browse/Edit, and keep the event channel's identity with the view.
   *
   * TWO THINGS THIS ORDER IS FOR, and both are about events not being lost:
   *
   *   1. What is queued is flushed BEFORE the view changes, because the queue is
   *      the page's and outlives it -- events sent afterwards would be filed
   *      under the view instance that replaced the one that produced them.
   *   2. A switch that had to replace the page gets a new capability, because a
   *      fresh page numbers its events and its selections from 1 again. Without
   *      that, the host would take the new page's first events for a repeat of
   *      the old page's and drop every one of them as a duplicate.
   *
   * The in-place switch -- the ordinary path, `Module._iamSetEditable` -- is
   * neither: the page, and so the instance, is the same one throughout.
   */
  const switchMode = useCallback((next: ViewMode) => {
    setMode(next)
    const view = viewRef.current
    if (view === null) return
    setStatus(props.t(next === 'edit' ? 'switchingToEdit' : 'switchingToBrowse'))
    void (async () => {
      const bridge = bridgeRef.current
      await bridge?.flushNow()
      const { remounted } = await view.setMode(next)
      if (remounted) await bridge?.rehandshake()
      report(props.t(next === 'edit' ? 'switchedToEdit' : 'switchedToBrowse'))
    })().catch((error: unknown) => {
      report(error instanceof Error ? error.message : String(error), 'failure')
    })
  }, [report])

  const launchNative = useCallback((nativeMode: ViewMode) => {
    const bridge = bridgeRef.current
    if (bridge === null) return
    setStatus(props.t(nativeMode === 'edit' ? 'nativeLaunchingEdit' : 'nativeLaunchingBrowse'))
    void bridge.launchNative(nativeMode).then((answer) => {
      // "Already open" is the rule working, not a fault: the status line says so
      // plainly, while a launch that genuinely failed keeps the error colour.
      report(answer.ok
        ? props.t(nativeMode === 'edit' ? 'nativeOpenedEdit' : 'nativeOpenedBrowse')
        : actionFailureText(props.t, 'nativeLaunchFailed', answer),
      answer.ok || answer.code === 'alreadyOpen' ? 'status' : 'failure')
    })
  }, [report])

  const wake = useCallback((request: 'selection' | 'edits') => {
    const bridge = bridgeRef.current
    if (bridge === null) return
    void bridge.wake(request).then((answer) => {
      report(answer.ok
        ? props.t(request === 'selection' ? 'askedSelection' : 'askedEdits')
        : actionFailureText(props.t, 'wakeFailed', answer),
      answer.ok ? 'status' : 'failure')
    })
  }, [report])

  /**
   * Reload the preview from the file.
   *
   * The bytes are re-read from the host's route rather than kept: the pane's copy
   * is what it was handed at open, and the point of this button is that the file
   * has moved on. A page has no filesystem, so the only way back to the current
   * bytes is to ask for them again.
   */
  const refresh = useCallback(() => {
    const view = viewRef.current
    if (view === null) return
    // The conflict is stated rather than resolved silently, and it is stated in
    // the banner and not on the status line: a refresh discards what the preview
    // has and did not save, and a transient line that the next second overwrites
    // with "正在重新读取文件…" would be a warning the user never reads.
    setConflict((host?.edits.unsaved ?? 0) > 0)
    setStatus(props.t('reloading'))
    void (async () => {
      // Sent before the page is replaced, for the same reason a mode switch is:
      // the queue belongs to this side and the new page is a new view instance.
      await bridgeRef.current?.flushNow()
      await view.reload(async (): Promise<DocumentInput> => {
        // Through the host, because the address is the harness's own scheme and
        // not a URL this page can fetch, and because the bytes have to come from
        // the FILE -- the pane's copy is precisely what is out of date.
        const response = await fetch(`${props.domain.route}/document?address=${encodeURIComponent(props.resourceAddress)}`, {
          headers: { accept: 'application/octet-stream' },
        })
        if (!response.ok)
          throw new Error(props.t('reloadFailed', { status: response.status }))
        return { bytes: new Uint8Array(await response.arrayBuffer()), name }
      })
      // The refreshed page is a new view instance, so the channel is told to
      // speak for one: its events start at #1 again.
      await bridgeRef.current?.rehandshake()
      setStaleAt(null)
      setConflict(false)
      setFailed(false)
      report(props.t('reloaded', { name }))
    })().catch((error: unknown) => report(error instanceof Error ? error.message : String(error), 'failure'))
  }, [host, name, props.resourceAddress, report])

  const selection = host?.selection ?? null
  const gaps = host?.gaps ?? null
  // `failed` wins the line. The summary describes a session that is working --
  // how many are selected, how many edits are unsaved -- and every one of those
  // numbers is a lie about a preview that never started. Measured 2026-10-07: the
  // failure was reported and immediately hidden behind "0 处未保存".
  //
  // The file name is NOT part of it any more, and that is the point of the header
  // move: the harness draws the full path on the row the strip now shares with
  // it, and a second copy of the name two lines below it is noise.
  const summary = failed || host === null
    ? status
    : [
      selection === null
        ? props.t('noSelection')
      // A selection still arriving is marked as such: the count is the view's
      // own and final, but the list an agent would read is not complete yet,
      // and a pane that showed the two the same way would be claiming a
      // selection the host cannot yet answer for.
        : props.t(selection.truncated ? 'selectionCountMore'
          : selection.complete ? 'selectionCount' : 'selectionCountPartial',
        { count: selection.count }),
      props.t('unsavedCount', { count: host.edits.unsaved }),
      host.native.connected ? props.t('nativeConnected') : null,
      gaps === null ? null : props.t('droppedFacts', { count: gaps.droppedFacts }),
    ].filter((part): part is string => part !== null).join(' · ')

  // The strip, drawn into the harness's own header row rather than into a row of
  // its own.  See `useHeaderTarget` for why this is a portal and not a second
  // slot registration.
  const strip = (
    <div style={TOOLBAR}>
      <IconButton label={props.t('modeBrowse')} active={mode === 'browse'}
        onClick={() => switchMode('browse')}>
        <IconBrowse />
      </IconButton>
      <IconButton label={props.t('modeEdit')} active={mode === 'edit'}
        onClick={() => switchMode('edit')}>
        <IconEdit />
      </IconButton>
      <span style={SEPARATOR} />
      <IconButton label={props.t('askSelection')} onClick={() => wake('selection')}>
        <IconAskSelection />
      </IconButton>
      <IconButton label={props.t('askEdits')} onClick={() => wake('edits')}>
        <IconAskEdits />
      </IconButton>
      <span style={SEPARATOR} />
      {nativeNotice === null ? (
        <>
          <IconButton label={props.t('nativeBrowse')} onClick={() => launchNative('browse')}>
            <IconNativeBrowse />
          </IconButton>
          <IconButton label={props.t('nativeEdit')} onClick={() => launchNative('edit')}>
            <IconNativeEdit />
          </IconButton>
        </>
      ) : (
        <IconButton label={nativeNotice}>
          <IconInfo />
        </IconButton>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {headerTarget === null ? null : createPortal(strip, headerTarget)}
      {staleAt !== null ? (
        <div style={BANNER}>
          <span>
            {props.t('staleNotice')}
            {conflict ? props.t('conflictNotice') : ''}
          </span>
          <IconButton label={props.t('refreshPreview')} onClick={() => refresh()}
            style={BANNER_BUTTON}>
            <IconRefresh />
          </IconButton>
        </div>
      ) : null}
      {/* The canvas area's own background is the VIEW's, not the pane's: the
          wasm paints every pixel of it once it is up, and what this colour is
          for is the moment before it is.  Left the canvas colour in both
          appearances, because a light flash before a dark render reads as a
          fault; the frame inside sets its own background from the appearance it
          was handed. */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative',
        background: 'var(--dsw-alias-bg-document-preview, #141f26)' }} />
      {/* The status line, at the foot of the canvas.  It used to sit at the end
          of the strip; the strip is on the harness's header row now, which is
          323 pixels wide and already carries the path -- so the line that
          reports what is selected and what is unsaved gets a row of its own,
          where it can be read in full instead of being the first thing the
          header's overflow takes. */}
      <div style={{ ...STATUS, color: failed
        ? 'var(--dsw-alias-state-error-primary, #e08a8a)'
        : 'var(--dsw-alias-label-secondary, #9fb4ba)' }} title={status}>
        {summary}
      </div>
    </div>
  )
}

/**
 * The pane for a columnar store: the one document this build cannot render.
 *
 * WHY IT EXISTS SEPARATELY. This pane used to be the ordinary viewer with a
 * notice bar: the harness read the whole file first (`bytes-complete`), mounted
 * the WebAssembly view, and only then did the pane say no reader was linked in.
 * On a large `.iamh` that read WAS the pane's first impression -- seconds or
 * minutes of "rendering" before the two actions that can actually open the file
 * were even on screen. The domain now registers these suffixes as a `renderer`
 * preview (see `client/index.tsx`), so the harness reads nothing, no frame is
 * created, and the native actions are usable from the first paint.
 *
 * WHAT IT DRAWS. The name, the fact that this preview cannot open it, and the
 * two native actions -- as word buttons in the body, where an empty pane has the
 * room, and as the strip's icons in the harness header, where every other
 * preview keeps its actions. There is no Browse/Edit switch and no agent wake:
 * with no view there is no mode to switch, no selection to analyse and no edit
 * history to review.
 *
 * THE BRIDGE HAS NO FRAME, deliberately: the only thing this pane needs from the
 * host is the capability a native launch is authorised by. It never calls
 * `start()`, so no page instance is opened and no event channel is established
 * until a launch asks for one.
 */
export interface ColumnarViewerProps extends DocumentBodyProps {
  /** Which of the package's domains this pane is showing. */
  readonly domain: ViewDomain
  readonly t: Translate
}

export function ColumnarStoreView(props: ColumnarViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<ViewEventBridge | null>(null)
  const [status, setStatus] = useState(() => props.t('columnarReady'))
  const [failed, setFailed] = useState(false)
  const [nativeNotice, setNativeNotice] = useState<string | null>(null)
  const name = basenameOf(props.resourceAddress)
  const headerTarget = useHeaderTarget(containerRef, props.resourceAddress)

  const report = useCallback((message: string, kind: 'status' | 'failure' = 'status') => {
    setStatus(message)
    if (kind === 'failure') setFailed(true)
  }, [])

  // Ask the host whether this carrier can start a native editor at all. Asked
  // here and not on a click because the answer decides whether the pane offers
  // buttons or a refusal -- a button that can only fail is worse than none.
  useEffect(() => {
    props.scrollportRef?.(containerRef.current)
    const bridge = new ViewEventBridge({
      route: props.domain.route,
      resourceAddress: props.resourceAddress,
      // There is no iframe; see this component's docblock. The message listener
      // the bridge installs drops every event, because its source check fails.
      frame: () => null,
      report,
      t: props.t,
    })
    bridgeRef.current = bridge
    let live = true
    void bridge.nativeCapability().then((answer) => {
      if (!live) return
      const notice = answer.available ? null : refusalText(props.t, answer)
      setNativeNotice(notice)
      if (notice !== null) report(notice, 'failure')
    })
    return () => {
      live = false
      props.scrollportRef?.(null)
      bridge.dispose()
      bridgeRef.current = null
    }
  }, [props.resourceAddress, props.domain.route, props.scrollportRef, report])

  const launchNative = useCallback((nativeMode: ViewMode) => {
    const bridge = bridgeRef.current
    if (bridge === null) return
    setFailed(false)
    setStatus(props.t(nativeMode === 'edit' ? 'nativeLaunchingEdit' : 'nativeLaunchingBrowse'))
    void bridge.launchNative(nativeMode).then((answer) => {
      // The ordinary viewer promises a refresh prompt here; this pane has no
      // preview to refresh, so its own pair of sentences says only what happened.
      // "Already open" is the one-window rule working, not a failure.
      report(answer.ok
        ? props.t(nativeMode === 'edit' ? 'columnarOpenedEdit' : 'columnarOpenedBrowse')
        : actionFailureText(props.t, 'nativeLaunchFailed', answer),
      answer.ok || answer.code === 'alreadyOpen' ? 'status' : 'failure')
    })
  }, [report])

  // The header strip: the native actions, or the one glyph that explains why
  // there are none. Same portal and same styles as the viewer above, because
  // this pane sits in the same harness row.
  const strip = (
    <div style={TOOLBAR}>
      {nativeNotice === null ? (
        <>
          <IconButton label={props.t('nativeBrowse')} onClick={() => launchNative('browse')}>
            <IconNativeBrowse />
          </IconButton>
          <IconButton label={props.t('nativeEdit')} onClick={() => launchNative('edit')}>
            <IconNativeEdit />
          </IconButton>
        </>
      ) : (
        <IconButton label={nativeNotice} onClick={() => undefined}>
          <IconInfo />
        </IconButton>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {headerTarget === null ? null : createPortal(strip, headerTarget)}
      {/* The same document-preview background the embedded view paints over:
          this pane is the shape of a view that has nothing to draw, not a
          dialog laid over one. */}
      <div ref={containerRef} style={COLUMNAR_BODY}>
        <div style={COLUMNAR_CARD}>
          <span style={COLUMNAR_TEXT}>{props.t('columnarStore', { name })}</span>
          <span style={COLUMNAR_TEXT}>
            {nativeNotice === null ? props.t('columnarUseNative') : nativeNotice}
          </span>
          {nativeNotice === null ? (
            <div style={COLUMNAR_ACTIONS}>
              <button type="button" style={COLUMNAR_ACTION} onClick={() => launchNative('browse')}>
                {props.t('nativeBrowse')}
              </button>
              <button type="button" style={COLUMNAR_ACTION} onClick={() => launchNative('edit')}>
                {props.t('nativeEdit')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ ...STATUS, color: failed
        ? 'var(--dsw-alias-state-error-primary, #e08a8a)'
        : 'var(--dsw-alias-label-secondary, #9fb4ba)' }} title={status}>
        {status}
      </div>
    </div>
  )
}

/**
 * The harness's header row for THIS preview, or null until it is there.
 *
 * WHY THE STRIP IS PORTALLED AND NOT REGISTERED.  The document preview declares a
 * keyed slot exactly here -- `sidebar.right.tab.document.action`, dispatched with
 * `entryKey: <the preview implementation's id>` -- and registering into it is how
 * the harness's own renderer-specific controls arrive.  What that route costs is
 * the pane's state: a slot entry is a separate React tree, so the mode the strip
 * switches and the bridge the strip's buttons post through would have to be
 * lifted out of the viewer and shared back into it, for buttons that act on a
 * view the viewer owns.  A portal keeps the owner and moves only the pixels:
 * `react-dom` is a platform module, so this needs nothing that is not already
 * here.
 *
 * FOUND FROM THE PANE, NOT FROM THE DOCUMENT.  Several documents can be open at
 * once, and every one of them has a node with this attribute; the one that
 * belongs to this pane is the one inside the preview this viewer is mounted in.
 * The viewer already sits inside that element -- it is the ancestor the harness
 * gives every body -- so the search starts there rather than at `document`.
 *
 * The target is `display: contents`, which is what makes this work: the strip has
 * no box of its own to fight, so its buttons become flex items of the header row
 * and take its gap, its height and its rule.
 */
function useHeaderTarget(anchor: RefObject<HTMLElement>, revision: string): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const preview = anchor.current?.closest('[data-textpreview-state]')
    setTarget(preview?.querySelector<HTMLElement>(HEADER_SLOT) ?? null)
  }, [anchor, revision])
  return target
}

/** The harness's per-preview header slot; see `useHeaderTarget`. */
const HEADER_SLOT = '[data-slot="sidebar.right.tab.document.action"]'

/** The last path segment of a `dsh-resource://` address, percent-decoded. */
function basenameOf(address: string): string {
  const cut = address.search(/[?#]/)
  const bare = cut === -1 ? address : address.slice(0, cut)
  const segment = bare.slice(bare.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(segment) || 'document'
  } catch {
    return segment || 'document'
  }
}

// Every colour below is a HARNESS TOKEN, not a literal.
//
// The harness publishes its resolved theme as custom properties on `body` --
// `--dsw-alias-*`, rebound under `body[data-ds-dark-theme]` -- so a value of
// `var(--dsw-alias-bg-layer-1)` follows light, dark and follow-the-system with
// nothing in this file subscribing to anything.  That is the whole reason these
// are not hex codes: a pane painted in fixed colours is a pane that stays dark
// when the user picks Light, and the harness's own Appearance row then looks
// broken from the inside.
//
// Each has a fallback, and the fallback is the colour this pane used before the
// tokens existed -- the dark palette the view's own chrome is drawn in.  A page
// that somehow has no tokens (a bundler that dropped the stylesheet, a harness
// old enough not to publish them) then looks exactly as it did.
// No padding, no background and no rule: the strip is one flex item of the
// harness's header row now, and the row already has all three.  The gap is the
// row's own 4px, so the buttons sit in the same rhythm as the harness's tools
// beside them rather than in a rhythm of their own.
const TOOLBAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  // Rigid, and that is the whole of the layout decision here: the row is 323
  // pixels and carries the path, this strip, the harness's reload and its "more
  // ways to open".  Of those only the path is built to clip, so the strip keeps
  // the width its buttons need and the path takes the whole shortage.  Letting
  // the strip shrink instead does not make the path wider -- it pushes the last
  // button out of the strip's box and under the harness's controls.
  flex: '0 0 auto',
}

// The strip's buttons are not here: their colours went with them, to
// `./icons.tsx`, which now draws the button and the glyph inside it.
const SEPARATOR: React.CSSProperties = {
  // `0 0` and not the default: a one-pixel rule with no content has nothing to
  // shrink toward, and flex takes it to zero before it takes anything visible.
  flex: '0 0 1px',
  height: 18,
  background: 'var(--dsw-alias-border-l2, #2a3c44)',
  margin: '0 1px',
}


// A row of its own at the foot of the canvas: full width, one line, clipped
// rather than wrapped so the canvas never moves when the line grows.
const STATUS: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: '0 0 auto',
  height: 22,
  padding: '0 8px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  borderTop: '1px solid var(--dsw-alias-border-l2, #2a3c44)',
  background: 'var(--dsw-alias-bg-layer-1, #13242b)',
}

const BANNER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-primary, #f0e0b0)',
  background: 'var(--dsw-alias-bg-layer-3, #3a3320)',
  borderBottom: '1px solid var(--dsw-alias-state-warn-primary, #5c4f2c)',
  flex: '0 0 auto',
}

// The columnar pane's canvas: the document background with one centred card.
// No scrollport and no picture -- there is nothing to draw, and a pane that
// looked like a broken viewer would be read as a fault rather than as a format.
const COLUMNAR_BODY: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  textAlign: 'center',
  background: 'var(--dsw-alias-bg-document-preview, #141f26)',
}

const COLUMNAR_CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  maxWidth: 360,
}

const COLUMNAR_TEXT: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary, #9fb4ba)',
}

const COLUMNAR_ACTIONS: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 6,
}

// A word button, unlike the strip's icons: this pane is empty, so the width the
// viewer spends on its document is not being contested by anything.
const COLUMNAR_ACTION: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary, #d7e5e8)',
  background: 'var(--dsw-alias-bg-layer-2, #1b2f38)',
  border: '1px solid var(--dsw-alias-border-l3, #45616a)',
  borderRadius: 4,
  cursor: 'pointer',
}

// A whole override of the icon button rather than a patch: the amber surface is
// this banner's own and none of the default blue-grey survives it.  The rest of
// the shape comes back from `IconButton`, which spreads this last.
const BANNER_BUTTON: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 3,
  color: 'var(--dsw-alias-label-primary-inverted, #1b1b1b)',
  background: 'var(--dsw-alias-state-warn-primary, #e6c877)',
  border: '1px solid var(--dsw-alias-state-warn-primary, #e6c877)',
  borderRadius: 4,
  cursor: 'pointer',
}
