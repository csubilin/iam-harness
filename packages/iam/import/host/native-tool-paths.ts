import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Which importer, in this plugin's words rather than in a file's. */
export type ImportToolKind = 'mine' | 'drawing'

const WINDOWS = process.platform === 'win32'

/** The executable's name without its extension, which only Windows adds. */
const IMPORT_EXECUTABLE_STEMS: Record<ImportToolKind, string> = {
  mine: 'IamImportTool',
  drawing: 'IaxDrawingImportTool',
}

const IMPORT_EXECUTABLE_ENVIRONMENT_VARIABLES: Record<ImportToolKind, string> = {
  mine: 'IAM_IMPORT_TOOL',
  drawing: 'IAX_DRAWING_IMPORT_TOOL',
}

const DRAWING_ENTITY_QUERY_EXECUTABLE_NAME = WINDOWS ? 'IaxDrawingQuery.exe' : 'IaxDrawingQuery'

/**
 * What the executable is actually called on this platform.
 *
 * Windows resolves an executable by its full name, extension included, so every
 * candidate below has to carry `.exe` or the `statSync` that tests it will be
 * asking about a file that was never going to be there.
 */
function importExecutableName(importKind: ImportToolKind): string {
  const executableStem = IMPORT_EXECUTABLE_STEMS[importKind]
  return WINDOWS ? `${executableStem}.exe` : executableStem
}

/**
 * The build directories an importer can be in, in the order they are tried.
 *
 * TWO ROOTS, and the second one is the whole reason this is a table. The tree
 * picks its output root by compiler family -- `build/bin/<platform>` for GCC and
 * Clang, `build/exe/<platform>` when `WINDOWS_GCC` is defined -- and build.ps1
 * defines it, so a Windows build writes where a POSIX one does not.
 *
 * Two platform tokens and not one, on each side: `<platform>-native` is where
 * the native configuration puts them, but a tree configured for the Qt host
 * compiles no importer at all (`IAM_BUILD=0` there and only there), so
 * naming only one would point at a directory that exists and is empty of the
 * thing being looked for.
 */
const NATIVE_OUTPUT_DIRECTORIES: ReadonlyArray<readonly [outputRoot: string, platform: string]> = WINDOWS
  ? [
    ['exe', 'win-native'],
    ['exe', 'win'],
  ]
  : [
    ['bin', 'linux-native'],
    ['bin', 'linux'],
  ]

/** The build command named when the build tree is missing entirely. */
const BUILD_HINT = WINDOWS ? '.\\build.ps1 build native' : './build.sh build native'

/**
 * Raised when no importer is anywhere.
 *
 * Thrown rather than returned because this is the one failure that is NOT a
 * domain outcome: an import that failed is a result, an import that could not
 * be attempted is a misconfiguration, and the tool contract's exit codes cannot
 * express it (there is no child to have exited).
 */
export class ImportToolMissingError extends Error {
  constructor(importKind: ImportToolKind, attemptedPaths: readonly string[]) {
    super(
      `no ${importExecutableName(importKind)} found, so nothing was imported. Tried, in order: ` +
        `${attemptedPaths.join(', ')}. Set ${IMPORT_EXECUTABLE_ENVIRONMENT_VARIABLES[importKind]} to its absolute path.`,
    )
    this.name = 'ImportToolMissingError'
  }
}

/**
 * The repository root, guessed from this file's own location.
 *
 * `lib/native-tool-paths.js` sits at `<repo>/IAM/plugin/Import/lib`, so four directories up
 * is `<repo>` -- and the importers land under `<repo>/build`, in whichever of
 * `NATIVE_OUTPUT_DIRECTORIES` this platform's native configuration writes to.
 *
 * A guess, and the last one tried: it is right when the plugin is used from the
 * checkout it ships in (which is how it is installed -- `dsh plugin add` symlinks
 * the source directory) and wrong the moment the package is copied elsewhere.
 * Being wrong costs a clear failure and not a silent one, which is why it is
 * acceptable to guess at all.
 */
function repositoryRoot(): string {
  return resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
}

/**
 * Does `path` name a file this process could execute?
 *
 * THE MODE BITS ARE ASKED ONLY WHERE THEY MEAN SOMETHING. On POSIX they are the
 * question -- mode bits rather than access(2), because a permission check would
 * also answer no for a tool this user cannot run, a different sentence than the
 * one being written here. On Windows they are not: `statSync` reports 0o666 for
 * a file whatever it holds, an `.exe` included, so `mode & 0o111` is 0 and this
 * function rejected EVERY candidate it was ever handed. That was the second half
 * of why the search failed here; the first was the paths above.
 */
function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    return WINDOWS || (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Resolve one importer, or throw naming everywhere it looked.
 *
 * `toolsDir` comes from the plugin's own config; it is second so that a
 * per-deployment setting beats a per-invocation one only where the environment
 * has said nothing.
 */
export function resolveImportExecutablePath(importKind: ImportToolKind, configuredToolsDirectory?: string): string {
  const executableName = importExecutableName(importKind)
  const attemptedPaths: string[] = []
  const overrideVariable = IMPORT_EXECUTABLE_ENVIRONMENT_VARIABLES[importKind]

  const executableOverride = process.env[overrideVariable]
  if (executableOverride !== undefined && executableOverride !== '') {
    if (isExecutable(executableOverride)) return executableOverride
    // Named explicitly and not there: that is a typo the user can fix, and it
    // must not fall through to a guess that happens to work -- the next run
    // would then behave differently for no visible reason.
    attemptedPaths.push(`${executableOverride} (from ${overrideVariable})`)
    throw new ImportToolMissingError(importKind, attemptedPaths)
  }

  if (configuredToolsDirectory !== undefined && configuredToolsDirectory !== '') {
    const executablePath = join(configuredToolsDirectory, executableName)
    if (isExecutable(executablePath)) return executablePath
    attemptedPaths.push(executablePath)
  }

  for (const [outputRoot, platform] of NATIVE_OUTPUT_DIRECTORIES) {
    const executablePath = join(repositoryRoot(), 'build', outputRoot, platform, executableName)
    if (isExecutable(executablePath)) return executablePath
    attemptedPaths.push(executablePath)
  }

  // `existsSync` on the directory only, to say the more useful of two things:
  // "you have not built it" and "it is built somewhere I did not look" are
  // different problems and the caller can only act on the first.
  const [firstOutputRoot] = NATIVE_OUTPUT_DIRECTORIES[0]
  if (!existsSync(join(repositoryRoot(), 'build', firstOutputRoot))) {
    attemptedPaths.push(`(the build tree has no build/${firstOutputRoot} at all -- run ${BUILD_HINT})`)
  }

  throw new ImportToolMissingError(importKind, attemptedPaths)
}

/** Resolve the read-only entity query executable beside the drawing importer. */
export function resolveDrawingEntityQueryExecutablePath(configuredToolsDirectory?: string): string {
  const attemptedPaths: string[] = []
  const executableOverride = process.env.IAX_DRAWING_QUERY_TOOL
  if (executableOverride) {
    if (isExecutable(executableOverride)) return executableOverride
    throw new Error(`IAX_DRAWING_QUERY_TOOL names a missing or non-executable file: ${executableOverride}`)
  }
  if (configuredToolsDirectory) {
    const executablePath = join(configuredToolsDirectory, DRAWING_ENTITY_QUERY_EXECUTABLE_NAME)
    if (isExecutable(executablePath)) return executablePath
    attemptedPaths.push(executablePath)
  }
  for (const [outputRoot, platform] of NATIVE_OUTPUT_DIRECTORIES) {
    const executablePath = join(repositoryRoot(), 'build', outputRoot, platform, DRAWING_ENTITY_QUERY_EXECUTABLE_NAME)
    if (isExecutable(executablePath)) return executablePath
    attemptedPaths.push(executablePath)
  }
  throw new Error(`no ${DRAWING_ENTITY_QUERY_EXECUTABLE_NAME} found; tried ${attemptedPaths.join(', ')}. Set IAX_DRAWING_QUERY_TOOL to its absolute path.`)
}
