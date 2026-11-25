/** Copy the IAX wasm view output into the IAM package vendor directory, or verify it. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dirname, '..')
const VENDOR = join(ROOT, 'packages', 'iam', 'views', 'vendor')
const VIEWS = ['IamDrawingView', 'IamMiningView']
const SUFFIXES = ['.html', '.js', '.wasm', '.data']
const FILES = VIEWS.flatMap(view => SUFFIXES.map(suffix => view + suffix))

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    source: { type: 'string' },
  },
})
const source = resolve(values.source ?? process.env.IAX_WASM_VIEWS
  ?? join(ROOT, '..', 'IAX', 'build', 'bin', 'wasm', 'views'))

// A checkout without the platform build skips: the committed copy stands in.
if (!existsSync(source)) {
  console.log(`iam views: skipped, no IAX wasm build at ${source}`)
  process.exit(0)
}
const missing = FILES.filter(file => !existsSync(join(source, file)))
if (missing.length > 0) throw new Error(`iam views: ${source} is missing ${missing.join(', ')}`)

if (values.check) {
  const stale = FILES.filter((file) => {
    const committed = join(VENDOR, file)
    return !existsSync(committed) || !readFileSync(committed).equals(readFileSync(join(source, file)))
  })
  if (stale.length > 0) {
    throw new Error(`iam views: the committed vendor is stale (${stale.join(', ')}); run pnpm run sync:iam-views`)
  }
  console.log(`iam views: ${String(FILES.length)} file(s) match ${source}`)
} else {
  mkdirSync(VENDOR, { recursive: true })
  for (const file of FILES) copyFileSync(join(source, file), join(VENDOR, file))
  console.log(`iam views: copied ${String(FILES.length)} file(s) from ${source}`)
}
