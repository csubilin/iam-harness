import { promises as fs, realpathSync, statSync, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** The scheme, and the only one this knows how to translate. */
const RESOURCE_PREFIX = 'dsh-resource://file/session/'

/**
 * Look up a session's workspace root by id.
 *
 * A function rather than the session store itself: the store arrives
 * asynchronously (the `sessions` service is injected, and a carrier without one
 * must still load this plugin), and this way the resolver reads whatever is
 * current at the moment it is asked.
 */
export type SessionRootLookup = (sessionId: string) => string | undefined

/** A file the address named, proven to be inside the session's workspace. */
export interface WorkspaceFile {
  /** The address it came from, verbatim. */
  address: string
  /** The session whose workspace it is in. */
  sessionId: string
  /** The path as the address spelled it, joined onto the canonical root. */
  path: string
  /** The canonical path — what `realpath` answers, and what is safe to open. */
  realPath: string
  /** The canonical workspace root the file was confined to. */
  realRoot: string
  /** The part of the path inside the workspace, as the address spelled it. */
  relative: string
  /** The file's identity at resolution time, for the open-then-compare check. */
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

/** Why an address could not be turned into a file. */
export interface AddressFailure {
  error: string
}

/** Whether a resolution answered a file or a reason. */
export type AddressOutcome = WorkspaceFile | AddressFailure

export function isAddressFailure(value: AddressOutcome): value is AddressFailure {
  return (value as AddressFailure).error !== undefined
}

/**
 * The session an address belongs to, or null when it is not one of ours.
 *
 * The capability route needs this and not a path: the whole of what makes a
 * browser half's request answerable is that the address it was handed names the
 * session it is a preview of, and that is the fact this reads out.
 */
export function resourceAddressSession(address: string): string | null {
  if (typeof address !== 'string' || !address.startsWith(RESOURCE_PREFIX)) return null
  const rest = address.slice(RESOURCE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return rest.slice(0, slash)
}

/** The last path segment of a `dsh-resource://` address, percent-decoded. */
export function basenameOf(address: string): string {
  const cut = address.search(/[?#]/)
  const bare = cut === -1 ? address : address.slice(0, cut)
  const segment = bare.slice(bare.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(segment) || 'document'
  } catch {
    return segment || 'document'
  }
}

/**
 * Canonical roots, remembered.
 *
 * A `realpath` per request would be a syscall on a path that does not change:
 * the workspace root is created once and lives as long as the session. A
 * failure is NOT cached — a root that does not exist yet may exist in a moment,
 * and a cached "no" would outlive the reason for it.
 */
const rootCache = new Map<string, string>()

function canonicalRoot(root: string): string | null {
  const cached = rootCache.get(root)
  if (cached !== undefined) return cached
  try {
    const real = realpathSync(root)
    rootCache.set(root, real)
    return real
  } catch {
    return null
  }
}

/** Forget the cached canonical roots. For a test that reuses a directory name. */
export function forgetCanonicalRoots(): void {
  rootCache.clear()
}

/** Whether `child` is `root` or sits under it. Both must already be canonical. */
function within(root: string, child: string): boolean {
  if (child === root) return true
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Turn one address into one file inside one session's workspace.
 *
 * Every route that reads or launches a document goes through this, and it is one
 * function rather than a read-path and a launch-path so that the two cannot
 * drift: the check that keeps a native launch out of `/etc/passwd` is the check
 * that keeps the preview read out of it.
 */
export function resolveWorkspaceFile(sessionRootOf: SessionRootLookup, address: string): AddressOutcome {
  if (typeof address !== 'string' || !address.startsWith(RESOURCE_PREFIX)) {
    return { error: '这不是一个 harness 资源地址。' }
  }

  const rest = address.slice(RESOURCE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return { error: '地址里没有会话标识。' }

  const sessionId = rest.slice(0, slash)
  let relative: string
  try {
    relative = decodeURIComponent(rest.slice(slash + 1))
  } catch {
    // A malformed percent-escape is a bad address, not a crash.
    return { error: '地址里的转义不完整。' }
  }

  // Workspace-relative, never absolute: an address carrying an absolute path
  // could name any file on the machine, and the page supplies this string.
  if (relative.length === 0 || relative.startsWith('/')) {
    return { error: '地址必须指向工作区内的相对路径。' }
  }
  // A NUL would truncate the path at the syscall boundary, which is the classic
  // way a confinement check and an open end up disagreeing about which file they
  // mean.
  if (relative.includes('\0')) return { error: '地址里含有空字节。' }

  const root = sessionRootOf(sessionId)
  if (typeof root !== 'string' || root.length === 0) {
    return { error: `没有找到会话 ${sessionId} 的工作区。` }
  }
  const realRoot = canonicalRoot(root)
  if (realRoot === null) return { error: `会话 ${sessionId} 的工作区目录不存在。` }

  // Resolved against the CANONICAL root, so the textual containment test below
  // and the canonical one after it are about the same string space.
  const target = resolve(realRoot, relative)
  if (!within(realRoot, target)) {
    return { error: '地址越出了会话工作区。' }
  }

  let realPath: string
  try {
    realPath = realpathSync(target)
  } catch {
    return { error: `工作区里没有这个文件：${relative}` }
  }
  // The check a symlink makes necessary: `note.iamp` inside the workspace may BE
  // a symlink to `~/.ssh/id_rsa`, and `resolve` cannot see that.
  if (!within(realRoot, realPath)) {
    return { error: '这个路径是一个指向工作区之外的符号链接。' }
  }

  let stat: Stats
  try {
    stat = statSync(realPath)
  } catch {
    return { error: `无法读取这个文件：${relative}` }
  }
  if (!stat.isFile()) return { error: '这个路径不是一个常规文件。' }

  return {
    address,
    sessionId,
    path: target,
    realPath,
    realRoot,
    relative,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

/**
 * The resolved file, re-proven immediately before it is used.
 *
 * `spawn()` takes a path, so a native launch cannot hold an open handle the way
 * a read can. What it can do is resolve again at the last moment: the window
 * between this answer and the `spawn()` that follows it is the shortest one
 * available without changing what a process is started with, and it is stated
 * here rather than left implied.
 */
export function verifyWorkspaceFile(sessionRootOf: SessionRootLookup, address: string): AddressOutcome {
  return resolveWorkspaceFile(sessionRootOf, address)
}

/**
 * Open a resolved file and prove the open landed on the file that was resolved.
 *
 * The resolution above is a check-then-use: it describes a path, and something
 * may replace that path before the open. `fstat` on the handle describes what
 * was ACTUALLY opened, and comparing it against the resolution is what tells the
 * two apart. A caller that reads through this handle cannot be redirected by a
 * symlink swapped in after the check, because the check is now about the open
 * handle itself.
 *
 * WHY `dev`/`ino` IS NOT THE WHOLE COMPARISON. It is the identity, and it was
 * measured to be insufficient: a path that is unlinked and immediately recreated
 * can be handed the SAME inode number back -- a test that swapped the file that
 * way passed the check it was written to fail. So `size` and `mtimeMs` are
 * compared too. They are not identity, but a file that differs in any of the
 * three between two syscalls microseconds apart is a file that changed under the
 * read, and refusing is the answer either way.
 */
export async function openWorkspaceFile(
  sessionRootOf: SessionRootLookup,
  address: string,
): Promise<{ handle: FileHandle; file: WorkspaceFile } | AddressFailure> {
  const outcome = resolveWorkspaceFile(sessionRootOf, address)
  if (isAddressFailure(outcome)) return outcome

  let handle: FileHandle
  try {
    // `realPath`, not `path`: the canonical name is the one the resolution
    // measured, so a change to a symlink further up cannot move the open.
    handle = await fs.open(outcome.realPath, 'r')
  } catch (error) {
    return { error: `无法打开这个文件：${error instanceof Error ? error.message : String(error)}` }
  }

  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      await handle.close()
      return { error: '这个路径不是一个常规文件。' }
    }
    if (stat.dev !== outcome.dev || stat.ino !== outcome.ino ||
        stat.size !== outcome.size || stat.mtimeMs !== outcome.mtimeMs) {
      await handle.close()
      return { error: '文件在校验与打开之间被替换了，已拒绝读取。' }
    }
    return { handle, file: outcome }
  } catch (error) {
    await handle.close().catch(() => undefined)
    return { error: `无法校验打开的文件：${error instanceof Error ? error.message : String(error)}` }
  }
}
