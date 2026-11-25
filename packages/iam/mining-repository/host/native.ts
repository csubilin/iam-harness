import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The Mining editor, which is the one that can read both containers. */
const EXECUTABLE = process.platform === 'win32' ? 'IamNativeMiningView.exe' : 'IamNativeMiningView'

/** What the bundle row, or the environment, says about where things are. */
export interface NativeOptions {
  /** Directory holding the editor and its modules. */
  nativeBinDir?: string
  /** Directory holding the SHX fonts the editor resolves through ACAD. */
  fontsDir?: string
}

export interface NativeUnavailable {
  /** Why the editor could not be started, named for the caller to translate. */
  readonly code: 'noBinDir' | 'noFontsDir' | 'noExecutable' | 'alreadyOpen'
  readonly detail?: string
}

/** One live claim on a document, held by whichever launcher started its editor. */
interface EditorClaim {
  /** The process holding the document; absent only in the instant before a spawn fails. */
  readonly pid: number | undefined
}

/**
 * The one table both launchers consult: a document has at most ONE native window.
 *
 * THE SAME TABLE Views' `host/native.ts` USES, by agreement on a global name.
 * The two packages are installed independently, so neither imports the other;
 * the host loads both into one process, and that is exactly the scope the rule
 * needs -- the pane's buttons and `iam_mining_show` must not each start a
 * window for the same file. The property name is the contract.
 *
 * The key is the resolved path, case-folded on Windows: the two callers arrive
 * with a workspace path and a resolved one, and they mean the same file. A
 * claim is dropped when its process exits; a claim whose pid is gone is treated
 * as stale, so a window the user closed never leaves a document locked.
 */
interface ClaimHolder {
  __iamNativeEditorClaims?: Map<string, EditorClaim>
}

function claims(): Map<string, EditorClaim> {
  const holder = globalThis as unknown as ClaimHolder
  return holder.__iamNativeEditorClaims ?? (holder.__iamNativeEditorClaims = new Map())
}

function documentKey(filePath: string): string {
  let absolute = resolve(filePath)
  try {
    // The pane is handed a verified real path while this launcher gets the
    // repository's resolved project path. The canonical path is what makes the
    // shared claim mean the document rather than its spelling.
    absolute = realpathSync.native(absolute)
  } catch {
    // A path that cannot be resolved cannot be opened either; the spawn reports it.
  }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function alive(pid: number): boolean {
  try {
    // Signal 0 delivers nothing; it only asks the OS whether the process exists.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The claim on a document, or null when there is none that is still alive. */
function heldBy(key: string): EditorClaim | null {
  const table = claims()
  const held = table.get(key)
  if (held === undefined) return null
  if (held.pid !== undefined && alive(held.pid)) return held
  // A stale claim is cleared rather than left to refuse a document nobody has open.
  table.delete(key)
  return null
}

/** Drop a claim only if it is still the one this editor took. */
function releaseClaim(key: string, claim: EditorClaim): void {
  const table = claims()
  if (table.get(key) === claim) table.delete(key)
}

/**
 * Where the editor and its fonts are.
 *
 * NO HARD-CODED FALLBACK, for Views' reason: a default would be one developer's
 * build directory.  The two chains are the same two, in the same order, so one
 * variable moves both callers.
 */
export function nativePaths(options: NativeOptions): { binDir: string; fontsDir: string } | NativeUnavailable {
  const binDir = options.nativeBinDir ?? process.env.IAM_NATIVE_DIR
  if (typeof binDir !== 'string' || binDir.length === 0) return { code: 'noBinDir' }
  const fontsDir = options.fontsDir ?? process.env.IAM_FONTS_DIR ?? process.env.ACAD
  if (typeof fontsDir !== 'string' || fontsDir.length === 0) return { code: 'noFontsDir' }
  const executable = join(binDir, EXECUTABLE)
  if (!existsSync(executable)) return { code: 'noExecutable', detail: executable }
  return { binDir, fontsDir }
}

/** Whether this carrier can start one at all.  Named rather than guessed. */
export function nativeAvailability(options: NativeOptions): NativeUnavailable | null {
  const paths = nativePaths(options)
  return 'code' in paths ? paths : null
}

/**
 * One running editor.
 *
 * A pid and the process, kept so that disposal can end what it started.  The
 * record is not keyed by session: an editor opened for a document outlives the
 * call that opened it.  A second call for the same document is refused by the
 * shared claim, not started as a second editor -- one document, one window.
 */
interface Editor {
  readonly pid: number | undefined
  readonly process: ReturnType<typeof spawn>
  readonly file: string
  /** The claim this editor holds, and the document key it is filed under. */
  readonly claimKey: string
  readonly claim: EditorClaim
}

const editors = new Set<Editor>()

/**
 * Open one document in the native editor, showing only `selection`.
 *
 * `selection` is IamView::setVisibleSelection's line format, handed over the
 * environment (IAM_ISOLATE) rather than as an argument: the command line's
 * second positional is the view's secondary output, and a selection is view
 * state, which is what the two variables beside it already are.
 *
 * A spawn failure is RETURNED rather than thrown, because it is a refusal the
 * caller has to be able to describe -- and this returns as soon as the process
 * exists, not when a window appears, because there is nothing to wait for: the
 * editor opens its document in its own time and reports nothing back here.
 */
export function launchNative(file: string, selection: string, options: NativeOptions):
  { ok: true; pid: number | undefined } | { ok: false; refusal: NativeUnavailable | { code: 'spawnFailed'; detail: string } } {
  const paths = nativePaths(options)
  if ('code' in paths) return { ok: false, refusal: paths }

  // One document, one window: the check comes before the spawn, so a second show
  // call costs a refusal and not a duplicate editor.
  const claimKey = documentKey(file)
  if (heldBy(claimKey) !== null) return { ok: false, refusal: { code: 'alreadyOpen' } }

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ACAD: paths.fontsDir,
    ...moduleSearchPath(paths.binDir),
  }
  if (selection.length > 0) environment.IAM_ISOLATE = selection

  try {
    // `--browse` and not `--editable`: the panel is the browser's reading view
    // and this is the desktop's, and an editor that opened in edit mode would
    // offer to change a project nobody asked to change.
    const child = spawn(join(paths.binDir, EXECUTABLE), ['--browse', file], {
      env: environment,
      shell: false,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    const claim: EditorClaim = { pid: child.pid }
    claims().set(claimKey, claim)
    const editor: Editor = { pid: child.pid, process: child, file, claimKey, claim }
    editors.add(editor)
    child.on('exit', () => {
      editors.delete(editor)
      releaseClaim(claimKey, claim)
    })
    child.on('error', () => {
      editors.delete(editor)
      releaseClaim(claimKey, claim)
    })
    return { ok: true, pid: child.pid }
  } catch (error) {
    return { ok: false, refusal: { code: 'spawnFailed', detail: error instanceof Error ? error.message : String(error) } }
  }
}

function moduleSearchPath(binDir: string): Record<string, string> {
  if (process.platform === 'win32') {
    return { PATH: [binDir, process.env.PATH].filter(Boolean).join(';') }
  }
  return {
    LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    DYLD_LIBRARY_PATH: [binDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
  }
}

/** End every editor this plugin started.  Called from the plugin's disposer. */
export function stopEditors(): number {
  let stopped = 0
  for (const editor of editors) {
    try {
      editor.process.kill()
      stopped += 1
    } catch { /* Already gone. */ }
    releaseClaim(editor.claimKey, editor.claim)
  }
  editors.clear()
  return stopped
}
