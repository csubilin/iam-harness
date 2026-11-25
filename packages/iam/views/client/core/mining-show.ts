export const MINING_SHOW = 'iam_mining_show'

/**
 * A selection waiting for the pane that will apply it.
 *
 * WHY A TABLE OF OUR OWN AND NOT THE TAB'S PARAMS.  The harness carries
 * `params` with a resource address and a document body can read them -- but the
 * `file` resource type's params belong to the document-preview package
 * (`{ line?: number }`), and declaration merging does not let a second package
 * add a field to the same key.  So the selection travels beside the address
 * rather than inside it.
 *
 * WHY AN OBSERVABLE AND NOT A ONE-SHOT.  The pane for this address may already be
 * mounted -- "显示矿体" and then "显示巷道" on the same document is the same tab,
 * which is the whole point -- and a mounted body gets no new props for a
 * navigation that does not change its address.  So the pane SUBSCRIBES here and
 * applies whatever arrives for the address it is showing.
 *
 * IN MEMORY, SO A RELOAD SHOWS EVERYTHING.  Nothing here survives a page reload,
 * and neither would params. The degradation is the good one: the document is
 * still open, and it draws in full rather than drawing nothing.
 */
interface PendingSelection {
  /** The view's own line format: element ids, one per line.  Empty = everything. */
  readonly selection: string
  readonly at: number
}

const pending = new Map<string, PendingSelection>()
const listeners = new Set<(address: string) => void>()

/** Tell the pane showing `address` what to draw. */
export function requestSelection(address: string, selection: string): void {
  pending.set(address, { selection, at: Date.now() })
  for (const listener of listeners) listener(address)
}

/** What the pane showing `address` was last asked to draw, if anything. */
export function selectionFor(address: string): PendingSelection | undefined {
  return pending.get(address)
}

/** Watch for selections aimed at any address.  Returns its own unsubscribe. */
export function observeSelections(listener: (address: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** One row of what the tool said it did, for the card. */
export interface MiningShowCard {
  /** Workspace-relative path of the document the panel opens. */
  readonly relativePath: string
  readonly title: string
  /** The element ids that were asked for. */
  readonly selection: readonly string[]
  readonly summary: { readonly elements: number; readonly geometry: number }
  /** Which carrier showed it: the panel, or the native editor. */
  readonly opened: 'panel' | 'native'
  /** The tool's declaration: open the panel, or leave the card with its button. */
  readonly autoOpen: boolean
}

/** A call that could not be shown, and the sentence saying why. */
export interface MiningShowRefusal {
  readonly refused: string
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Narrow one tool result's presentation metadata to a card, or null.
 *
 * DEFENSIVE, and it has to be: this value comes back out of a session log that a
 * different build may have written, so every field arrives unvalidated. A card
 * that throws while rendering would take the whole transcript down, which is why
 * every accessor here answers a default instead -- the shipped models beside this
 * one (`diff-card-model.ts`, `image-card-model.ts` in the harness) read their
 * metadata the same way and for the same reason.
 *
 * A refusal is a card too: the call ran and the answer is "no, and here is why",
 * which a reader has to see.  Only a value that is neither is null -- and null
 * means the generic tool row renders, which is the right fallback.
 */
export function readShowCard(meta: unknown): MiningShowCard | MiningShowRefusal | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const record = meta as Record<string, unknown>
  if (typeof record.refused === 'string' && record.refused.length > 0) {
    return { refused: record.refused }
  }
  const relativePath = text(record.relativePath)
  const opened = record.opened === 'native' ? 'native' : 'panel'
  // A native card has no path -- the editor was handed an absolute one -- so the
  // only thing that makes a card readable is that it says SOMETHING happened.
  if (relativePath.length === 0 && opened !== 'native') return null
  const summary = (typeof record.summary === 'object' && record.summary !== null
    ? record.summary : {}) as Record<string, unknown>
  return {
    relativePath,
    title: text(record.title),
    selection: Array.isArray(record.selection)
      ? record.selection.filter((id): id is string => typeof id === 'string')
      : [],
    summary: { elements: count(summary.elements), geometry: count(summary.geometry) },
    opened,
    autoOpen: record.autoOpen !== false,
  }
}

/** Whether this is the refusal arm. */
export function isRefusal(
  card: MiningShowCard | MiningShowRefusal,
): card is MiningShowRefusal {
  return typeof (card as MiningShowRefusal).refused === 'string'
}

/**
 * Component-encode one id or path segment, keeping `:` literal.
 *
 * Copied from the harness's own address grammar (`util/workspace-path`), and the
 * copy is not laziness: a client bundle resolves `require` against a fixed seed
 * table -- React and a handful of shell libraries -- so this package cannot
 * import that helper at runtime (measured: it is not in PLATFORM_MODULES).  The
 * alternative to copying the three lines is a preview that opens a path the host
 * resolver cannot find, on the day a file name carries a space.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * The address of a document, as the harness names a file in a session.
 *
 * `dsh-resource://file/session/<sessionId>/<workspace-relative path>` is what
 * Views' own host half resolves, what its capability handshake parses a session
 * out of, and what the sidebar dedupes tabs by -- so this string is load-bearing
 * three times over, and a wrong one fails as "this session has no view state"
 * rather than as a bad link.
 *
 * THE SESSION IS THE ONE ON SCREEN, which is why the tool's metadata carries a
 * relative path and not an address: only the client knows which session's sidebar
 * the panel is about to appear in.
 */
export function documentAddress(sessionId: string, relativePath: string): string {
  const path = relativePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${path.split('/').map(encodeSegment).join('/')}`
}

/**
 * Whether this card should open the panel by itself.
 *
 * TWO CONDITIONS, and the second is the one that is easy to miss. `autoOpen` is
 * the tool's declaration. `watchedItRun` is the card's own history: a row that
 * was already settled when it mounted -- a session reopened from its log, or a
 * user scrolling back through an old turn -- must NOT open anything, or reading
 * yesterday's conversation would launch every panel it ever mentioned. Only a
 * row that saw its call running and then settle is a call that just happened.
 */
export function shouldAutoOpen(
  card: MiningShowCard | MiningShowRefusal,
  options: { readonly watchedItRun: boolean; readonly alreadyOpened: boolean },
): boolean {
  if (isRefusal(card)) return false
  // A native card has nothing for this pane to open: the editor is already up,
  // started by the tool on a machine this page cannot reach.
  if (card.opened === 'native') return false
  return card.autoOpen && options.watchedItRun && !options.alreadyOpened
}

/** `1 元素 · 1 几何`, for the card's one summary line. */
export function summarize(card: MiningShowCard): string {
  return `${card.summary.elements} 元素 · ${card.summary.geometry} 几何`
}
