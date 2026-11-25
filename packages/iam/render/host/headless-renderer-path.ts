import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS = process.platform === 'win32'

/** The executable's name without its extension, which only Windows adds. */
const RENDERER_EXECUTABLE_STEM = 'IamNativeHeadlessMining'

const RENDERER_EXECUTABLE_OVERRIDE_VARIABLE = 'IAM_NATIVE_HEADLESS_TOOL'

/**
 * The build directories the renderer can be in, in the order they are tried.
 *
 * Two roots, because the tree picks its output root by compiler family --
 * `build/bin/<platform>` for GCC and Clang, `build/exe/<platform>` when
 * `WINDOWS_GCC` is defined -- and build.ps1 defines it.
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

const BUILD_HINT = WINDOWS ? '.\\build.ps1 build native' : './build.sh build native'

function rendererExecutableName(): string {
  return WINDOWS ? `${RENDERER_EXECUTABLE_STEM}.exe` : RENDERER_EXECUTABLE_STEM
}

/** Raised when no renderer is anywhere. */
export class RenderToolMissingError extends Error {
  constructor(attemptedPaths: readonly string[]) {
    super(
      `no ${rendererExecutableName()} found, so nothing was rendered. Tried, in order: ` +
        `${attemptedPaths.join(', ')}. Set ${RENDERER_EXECUTABLE_OVERRIDE_VARIABLE} to its absolute path.`,
    )
    this.name = 'RenderToolMissingError'
  }
}

/**
 * The repository root, guessed from this file's own location.
 *
 * `lib/headless-renderer-path.js` sits at `<repo>/IAM/plugin/Render/lib`, so four directories up
 * is `<repo>`.
 */
function repositoryRoot(): string {
  return resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
}

/**
 * Does `path` name a file this process could execute?
 *
 * The mode bits are asked only where they mean something: on Windows `statSync`
 * reports 0o666 for a file whatever it holds, an `.exe` included, so asking would
 * reject every candidate.
 */
function isExecutableFile(executablePath: string): boolean {
  try {
    if (!statSync(executablePath).isFile()) return false
    return WINDOWS || (statSync(executablePath).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Resolve the renderer, or throw naming everywhere it looked.
 *
 * `configuredToolsDirectory` comes from the plugin's own config and is second, so that a
 * per-deployment setting beats a guess only where the environment said nothing.
 */
export function resolveHeadlessRendererExecutablePath(configuredToolsDirectory?: string): string {
  const executableName = rendererExecutableName()
  const attemptedPaths: string[] = []

  const executableOverride = process.env[RENDERER_EXECUTABLE_OVERRIDE_VARIABLE]
  if (executableOverride !== undefined && executableOverride !== '') {
    // Resolved, so the path in the failure is the one the process actually
    // tried: a relative variable is relative to the plugin host's working
    // directory, which is a directory the caller did not name.
    const executablePath = resolve(executableOverride)
    if (isExecutableFile(executablePath)) return executablePath
    // Named explicitly and not there is a typo the caller can fix, and it must
    // not fall through to a guess that happens to work.
    attemptedPaths.push(`${executablePath} (from ${RENDERER_EXECUTABLE_OVERRIDE_VARIABLE})`)
    throw new RenderToolMissingError(attemptedPaths)
  }

  if (configuredToolsDirectory !== undefined && configuredToolsDirectory !== '') {
    const executablePath = resolve(configuredToolsDirectory, executableName)
    if (isExecutableFile(executablePath)) return executablePath
    attemptedPaths.push(executablePath)
  }

  for (const [outputRoot, platform] of NATIVE_OUTPUT_DIRECTORIES) {
    const executablePath = join(repositoryRoot(), 'build', outputRoot, platform, executableName)
    if (isExecutableFile(executablePath)) return executablePath
    attemptedPaths.push(executablePath)
  }

  const [firstOutputRoot] = NATIVE_OUTPUT_DIRECTORIES[0]
  if (!existsSync(join(repositoryRoot(), 'build', firstOutputRoot))) {
    attemptedPaths.push(`(the build tree has no build/${firstOutputRoot} at all -- run ${BUILD_HINT})`)
  }

  throw new RenderToolMissingError(attemptedPaths)
}
