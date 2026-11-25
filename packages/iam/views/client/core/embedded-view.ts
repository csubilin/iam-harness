import type { ViewDomain } from '../../host/domains'
import { type Appearance, appearanceQuery } from './appearance'

/** The pane's translator, bound to this plugin's namespace by `index.tsx`. */
export type Translate = (key: string, values?: Record<string, string | number>) => string

/** What the view needs from the pane, beyond the container it is mounted into. */
export interface EmbeddedViewOptions {
  /** Which of the package's domains this instance is showing. */
  domain: ViewDomain
  /** The harness's resolved appearance, at the moment the view is built. */
  appearance: Appearance
  /** The pane's words. */
  t: Translate
}

export type ViewMode = 'browse' | 'edit'

/** How long to wait for the wasm module to finish instantiating. */
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 50

/** A document handed to the engine: its bytes and the name it was opened under. */
export interface DocumentInput {
  bytes: Uint8Array
  name: string
}

interface ViewWindow extends Window {
  Module?: {
    _iamOpenBytes?: (pointer: number, length: number, namePointer: number, nameLength: number) => void
    /** Flips the open view between Browse and Edit without reloading the page. */
    _iamSetEditable?: (editable: number) => void
    /**
     * Show only the named items, and frame them.
     *
     * The embedder's half of the panel's own Isolate + Zoom-to-selection: what an
     * agent that has just worked out which resources a question is about says to
     * the view.  An empty string means EVERYTHING, so it is also how the whole
     * document comes back.
     *
     * A page that predates this entry point shrugs at `?.` and shows the whole
     * document -- which is what it did before, so an embedder running ahead of
     * the wasm it vendored degrades rather than breaks.
     */
    _iamSetVisibleSelection?: (pointer: number, length: number) => void
    /**
     * Change the appearance and language without reloading the page.
     *
     * The two are also passed as query parameters, which is what a freshly
     * mounted frame reads; this is for the frame that is already running, so
     * that a user switching to Light does not pay a reload of a 30 MB mine for
     * a repaint. Same shape and same reason as `_iamSetEditable` above.
     */
    _iamSetAppearance?: (mode: number, language: number) => void
    _malloc?: (size: number) => number
    _free?: (pointer: number) => void
    HEAPU8?: Uint8Array
  }
  iamShell?: {
    setLoading?: (text: string) => void
    setEditable?: (editable: boolean) => void
    /**
     * Tell the page which document it is showing.
     *
     * The page keys its local-recovery copy by document AND mode, and this side
     * opens documents through `Module._iamOpenBytes` rather than through the
     * page's own `openBytes()` -- so without this call the page's bookkeeping
     * never learns what it has, and every document it is shown shares one
     * recovery slot. See `setDocument` in the shell.
     */
    setDocument?: (name: string) => void
  }
}

export class EmbeddedView {
  private frame: HTMLIFrameElement | null = null
  private container: HTMLElement | null = null
  private mode: ViewMode = 'browse'
  /** Retained so a mode change or a refresh can re-open the same document. */
  private document: DocumentInput | null = null
  private generation = 0
  /** The harness's appearance, as the frame's URL carries it and the live page is told it. */
  private appearance: Appearance
  /** The pane's words, for the one sentence this class raises itself. */
  private readonly t: Translate
  /** The domain this instance frames: its route, its page, its window title. */
  private readonly domain: ViewDomain

  constructor(options: EmbeddedViewOptions) {
    this.domain = options.domain
    this.appearance = options.appearance
    this.t = options.t
  }

  /**
   * Follow a change of appearance or language, without reloading the page.
   *
   * Called when the harness's settings change while a document is open. A frame
   * that has not finished coming up yet gets the value on its next mount: the
   * call is guarded on the module existing, and a module that is not there yet
   * reads its URL instead, which `mountFrame` has already built from this field.
   */
  setAppearance(next: Appearance): void {
    if (next.theme === this.appearance.theme && next.language === this.appearance.language)
      return
    this.appearance = next
    const view = this.frame?.contentWindow as ViewWindow | null
    view?.Module?._iamSetAppearance?.(
      next.theme === 'dark' ? 2 : 1,
      next.language === 'zh' ? 0 : 1,
    )
  }

  /**
   * Show only the named items, and frame them; an empty string shows everything.
   *
   * Marshalled the way `loadDocument` marshals a document -- malloc, write, call,
   * free -- with one difference: the text is NUL-terminated as well as measured,
   * because the entry point takes the length and a string in the heap with a
   * stray NUL in it is one of the things that can go wrong out here.
   *
   * NOTHING IS WAITED FOR.  The view queues a selection it cannot apply yet (the
   * document may not be open, let alone decoded -- see IamView.h), so calling
   * this the moment the frame is up is the intended use, not a race.
   *
   * Answers whether the page has the entry point at all, so the caller can tell
   * "the view was told" from "this wasm predates the call".
   */
  setVisibleSelection(selection: string): boolean {
    const view = this.frame?.contentWindow as ViewWindow | null
    const set = view?.Module?._iamSetVisibleSelection
    const malloc = view?.Module?._malloc
    const free = view?.Module?._free
    if (typeof set !== 'function' || typeof malloc !== 'function' || typeof free !== 'function') return false

    const bytes = new TextEncoder().encode(selection)
    const pointer = malloc(bytes.length + 1)
    if (!pointer) return false
    try {
      // Read the heap AFTER allocating: a malloc large enough to grow the wasm
      // memory replaces Module.HEAPU8 and detaches the old view.
      const heap = view?.Module?.HEAPU8
      if (!heap) return false
      heap.set(bytes, pointer)
      heap[pointer + bytes.length] = 0
      set(pointer, bytes.length)
      return true
    } finally {
      free(pointer)
    }
  }

  /** The iframe, for the event bridge's `event.source` check. */
  element(): HTMLIFrameElement | null {
    return this.frame
  }

  /** When the current page finished loading its document, for the refresh prompt. */
  loadedAt = 0

  async attach(container: HTMLElement, mode: ViewMode): Promise<void> {
    this.container = container
    this.mode = mode
    await this.mountFrame()
  }

  async loadDocument(input: DocumentInput): Promise<void> {
    this.document = input
    const view = await this.awaitReady()
    // The shell's own `openBytes` copies into the module heap and hands the
    // pointers over; `nameLength` excludes the NUL, matching the shell.
    const module = view.Module
    const malloc = module?._malloc
    const free = module?._free
    const open = module?._iamOpenBytes
    if (!malloc || !free || !open) throw new Error('the embedded view exposes no document entry point')

    this.setLoading(this.t('opening', { name: input.name }))
    // Before the open, so the page's recovery bookkeeping is about THIS document
    // from the first autosave on.  A page that predates the entry point shrugs at
    // `?.` and keeps its old behaviour.
    view.iamShell?.setDocument?.(input.name)
    const dataPointer = malloc(input.bytes.length)
    if (!dataPointer) throw new Error('the embedded view could not allocate the document buffer')
    const name = new TextEncoder().encode(input.name)
    const namePointer = malloc(name.length + 1)
    if (!namePointer) {
      free(dataPointer)
      throw new Error('the embedded view could not allocate the document name')
    }
    // Read the heap *after* allocating, never before.
    //
    // A malloc large enough to grow the wasm memory replaces Module.HEAPU8 with a
    // new view over the new buffer and detaches the old one. A view taken before
    // the allocation therefore throws on first write:
    //
    //   TypeError: Cannot perform %TypedArray%.prototype.set on a detached or
    //   out-of-bounds ArrayBuffer
    //
    // Measured with a 30 MB .iam, which is the ordinary size of one. A small
    // document that fits in the initial heap hides this completely, which is why
    // it survived until a real mine was opened.
    const heap = module?.HEAPU8
    if (!heap) throw new Error('the embedded view exposes no heap')

    try {
      heap.set(input.bytes, dataPointer)
      heap.set(name, namePointer)
      heap[namePointer + name.length] = 0
      open(dataPointer, input.bytes.length, namePointer, name.length)
      this.loadedAt = Date.now()
    } finally {
      free(namePointer)
      free(dataPointer)
    }
  }

  /**
   * Change mode WITHOUT touching the document.
   *
   * `?editable=` is read once, when the page loads, so the only way to change the
   * mode used to be a new page and a new view -- and a new view means reading the
   * document again. Measured on a 31 MB mine in the harness desktop carrier: tens
   * of seconds per toggle, and the user watches a spinner for a switch that
   * changes five entry points and one field of the viewport profile.
   *
   * The view is one class serving both modes (see IamView.h), so the page can
   * simply be told: `Module._iamSetEditable(0|1)` flips the flag, re-derives
   * the profile and redraws, with the document open the whole time.
   *
   * A page that predates that entry point -- an embedder running ahead of the wasm
   * it vendored -- still gets a working switch: the remount below is the old
   * behaviour, kept as the fallback rather than deleted.
   *
   * Answers whether the PAGE was replaced. The caller needs to know, and for one
   * reason: a new page numbers its events and its selections from 1 again, so the
   * event bridge has to be told to speak for a new view instance or the host will
   * read the new page's first events as duplicates of the old page's. See
   * `ViewEventBridge.rehandshake()`.
   */
  async setMode(mode: ViewMode): Promise<{ remounted: boolean }> {
    if (mode === this.mode) return { remounted: false }
    this.mode = mode
    if (this.switchInPlace(mode)) return { remounted: false }
    await this.mountFrame()
    if (this.document !== null) await this.loadDocument(this.document)
    return { remounted: true }
  }

  /**
   * Tell the running view to change mode. Answers whether it could.
   *
   * The page's own bookkeeping is told as well, and that is not decoration: the
   * shell reads `editable` for its local-recovery autosave, so a document edited
   * after this switch would otherwise be the one the browser keeps no recovery
   * copy of.
   */
  private switchInPlace(mode: ViewMode): boolean {
    const view = this.frame?.contentWindow as ViewWindow | null
    const setEditable = view?.Module?._iamSetEditable
    if (typeof setEditable !== 'function') return false
    setEditable(mode === 'edit' ? 1 : 0)
    view?.iamShell?.setEditable?.(mode === 'edit')
    this.loadedAt = Date.now()
    return true
  }

  /**
   * Throw the page away and open the same document again.
   *
   * This is the "refresh preview" the user is offered after the native editor
   * saved the file: the bytes are re-read from the host and pushed into a fresh
   * page, because the running one holds the copy it was given at load and has no
   * way to be told the file underneath it moved.
   */
  async reload(readBytes: () => Promise<DocumentInput>): Promise<void> {
    const input = await readBytes()
    this.document = input
    await this.mountFrame()
    await this.loadDocument(input)
  }

  /** The bytes the preview currently holds, for a refresh that re-reads the file. */
  currentDocument(): DocumentInput | null {
    return this.document
  }

  /**
   * The view's own problem banner, or null when it has none.
   *
   * `#status` is the embedded page's contract with its embedder and its own
   * stylesheet says so: it "carries a problem the user may have to act on", and
   * the view's hosts write it through `iamReportFailure`. Reading it is how
   * this side learns that a view which never drew anything has given up -- the
   * page is same-origin, so the element is reachable, and there is no other way
   * to tell "starting" from "dead" from out here.
   */
  problem(): string | null {
    const element = this.frame?.contentDocument?.getElementById('status')
    const text = element?.textContent?.trim() ?? ''
    return text.length > 0 ? text : null
  }

  /**
   * Whether the page's own "something is happening" bubble is down.
   *
   * False while the view is working on a queued open -- the host raises the
   * bubble before the work and lowers it after -- so a caller watching for a
   * start can tell "still working" from "nothing at all".
   */
  idle(): boolean {
    const element = this.frame?.contentDocument?.getElementById('loading')
    return element === null || element === undefined ? true : element.hidden
  }

  async dispose(): Promise<void> {
    this.generation += 1
    this.frame?.remove()
    this.frame = null
    this.container = null
    this.document = null
  }

  /** Swap in a fresh view page for the current mode and wait for its module. */
  private async mountFrame(): Promise<void> {
    if (!this.container) throw new Error('attach() must run before the view can mount')
    const generation = ++this.generation
    this.frame?.remove()
    const frame = document.createElement('iframe')
    frame.src = `${this.domain.route}/${this.domain.page}?editable=${this.mode === 'edit' ? '1' : '0'}`
      + `&${appearanceQuery(this.appearance)}`
    frame.title = this.mode === 'edit' ? this.domain.frameTitle.edit : this.domain.frameTitle.browse
    // The frame's own background is the VIEW's, not the pane's: the wasm draws a
    // canvas of its own and this colour is only what shows through in the moment
    // before it does.  It is left the dark canvas colour in both appearances,
    // because a light flash before a dark render is worse than a dark one, and
    // the page inside sets its own background from the appearance it was given.
    frame.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#141f26'
    this.frame = frame
    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true })
    })
    this.container.replaceChildren(frame)
    await loaded
    if (generation !== this.generation) return
    await this.awaitReady()
  }

  /** Poll until the module has instantiated and published its entry points. */
  private async awaitReady(): Promise<ViewWindow> {
    const frame = this.frame
    if (!frame) throw new Error('the view page is not mounted')
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      const view = frame.contentWindow as ViewWindow | null
      if (view?.Module?._iamOpenBytes && view.Module._malloc && view.Module.HEAPU8) return view
      if (Date.now() > deadline) throw new Error('the embedded view did not finish loading')
      await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
    }
  }

  private setLoading(text: string): void {
    const view = this.frame?.contentWindow as ViewWindow | null
    view?.iamShell?.setLoading?.(text)
  }

  /**
   * Take the page's own "something is happening" bubble down.
   *
   * The pane calls this when IT has concluded the view failed. The page's
   * `setLoading` is a DOM write this side makes directly, so the host's own guard
   * -- it refuses to raise the bubble once it has reported a failure -- cannot
   * see it: measured 2026-10-07, a failed view was left wearing "打开 …" because
   * the pane had raised it after the failure and nothing lowered it again.
   *
   * THIS METHOD WAS MISSING FROM THIS COPY, and the absence was a crash rather
   * than a missing nicety: the two view packages are maintained by copying one
   * over the other, `MiningViewer.tsx` calls `view.clearLoading()` on both of its
   * failure paths, and the Drawing file it was copied from has had the method
   * since the measurement above. A Mining view that failed therefore threw
   * `view.clearLoading is not a function` instead of reporting why it failed --
   * in the one code path whose whole job is to say what went wrong.
   */
  clearLoading(): void {
    this.setLoading('')
  }
}
