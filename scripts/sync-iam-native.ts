/** Copy the IAX native viewers and their font set into the IAM views package, or verify them. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dirname, '..')
const VENDOR = join(ROOT, 'packages', 'iam', 'views', 'vendor-native')

/** The executables the views plugin spawns, as `host/native.ts` names them. */
const VIEWERS = ['IamNativeDrawingView.exe', 'IamNativeMiningView.exe']

/**
 * The chrome's CJK UI fonts are the one part of the resource tree left out: it
 * falls back to the Windows UI fonts, and that directory is 60 MiB of the 61 MiB.
 */
const RESOURCE_SKIP = new Set(['fonts'])

function filesUnder(root: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (prefix === '' && RESOURCE_SKIP.has(entry.name)) continue
      files.push(...filesUnder(root, path))
    } else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    native: { type: 'string' },
    fonts: { type: 'string' },
    resource: { type: 'string' },
  },
})
const native = resolve(values.native ?? process.env.IAX_NATIVE_DIR
  ?? join(ROOT, '..', 'IAX', 'build', 'exe', 'win-native'))
const fonts = resolve(values.fonts ?? process.env.IAX_FONTS ?? join(ROOT, '..', 'IAX', 'Fonts'))
const resource = resolve(values.resource ?? process.env.IAX_RESOURCE ?? join(ROOT, '..', 'IAX', 'resource'))

// A checkout without the IAX build skips: the committed copy stands in.
if (!existsSync(native) || !existsSync(fonts) || !existsSync(resource)) {
  console.log(`iam native: skipped, no IAX native build at ${native}`)
  process.exit(0)
}
// Every engine module ships; the test programs beside them are the trim. Which
// module a view loads depends on the document it opens, so a computed subset is
// a missing-DLL dialog for the first feature that subset did not exercise.
const dlls = readdirSync(native).filter(file => file.toLowerCase().endsWith('.dll')).sort()
const missing = [...VIEWERS, ...dlls].filter(file => !existsSync(join(native, file)))
if (missing.length > 0) throw new Error(`iam native: ${native} is missing ${missing.join(', ')}`)
const fontFiles = readdirSync(fonts).filter(file => !file.startsWith('.')).sort()

const groups = [
  { source: native, files: [...VIEWERS, ...dlls], target: join(VENDOR, 'win-x64') },
  { source: resource, files: filesUnder(resource), target: join(VENDOR, 'win-x64', 'resource') },
  { source: fonts, files: fontFiles, target: join(VENDOR, 'fonts') },
]
const total = groups.reduce((count, group) => count + group.files.length, 0)

// One map over the whole vendor directory: the resource group nests inside the
// win-x64 group's target, so a per-group listing would read one group's files as
// the other's extras.
const expected = new Map<string, string>()
for (const { source, files, target } of groups) {
  const prefix = relative(VENDOR, target).replaceAll('\\', '/')
  for (const file of files) expected.set(prefix === '' ? file : `${prefix}/${file}`, join(source, file))
}

if (values.check) {
  const committed = filesUnder(VENDOR)
  const drifted = [...expected].filter(([file, source]) => !existsSync(join(VENDOR, file))
    || !readFileSync(join(VENDOR, file)).equals(readFileSync(source))).map(([file]) => file)
  const extra = committed.filter(file => !expected.has(file))
  if (drifted.length > 0 || extra.length > 0) {
    throw new Error(`iam native: the committed copy is stale (${[...drifted, ...extra].join(', ')}); run pnpm run sync:iam-native`)
  }
  console.log(`iam native: ${String(total)} file(s) match ${native}`)
} else {
  rmSync(VENDOR, { recursive: true, force: true })
  let bytes = 0
  for (const [file, source] of expected) {
    const destination = join(VENDOR, file)
    mkdirSync(join(destination, '..'), { recursive: true })
    copyFileSync(source, destination)
    bytes += statSync(destination).size
  }
  console.log(`iam native: copied ${String(total)} file(s), ${(bytes / 1048576).toFixed(1)} MiB from ${native}`)
}
