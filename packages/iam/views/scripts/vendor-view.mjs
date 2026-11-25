#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const SOURCE =
  process.argv[2] ?? process.env.IAX_WASM_VIEWS ?? resolve(root, '..', '..', '..', 'build', 'bin', 'wasm', 'views')
// Both domains, because one package serves both.  The list mirrors
// host/domains.ts; each name is a wasm target's own output name.
const VIEWS = ['IamDrawingView', 'IamMiningView']
const SUFFIXES = ['.html', '.js', '.wasm', '.data']

// Emscripten embeds the build machine's absolute .data path as a cache key and a
// run-dependency name; the loader resolves the data file relative to the page.
function portable(file, body) {
  if (!file.endsWith('.js')) return body
  return Buffer.from(body.toString('utf8')
    .replace(/(var PACKAGE_NAME=")[^"]*\/([^"/\\]+\.data")/gu, '$1$2')
    .replace(/(datafile_)[^"]*?\/([^"/\\]+\.data)/gu, '$1$2'))
}

const target = join(root, 'vendor')
mkdirSync(target, { recursive: true })

let copied = 0
let bytes = 0
for (const view of VIEWS) {
  for (const suffix of SUFFIXES) {
    const file = view + suffix
    const from = join(SOURCE, file)
    if (!existsSync(from)) {
      process.stderr.write(`vendor-views: missing ${from}\n`)
      process.exit(1)
    }
    const body = readFileSync(from)
    if (suffix === '.js') writeFileSync(join(target, file), portable(file, body))
    else copyFileSync(from, join(target, file))
    copied += 1
    bytes += statSync(from).size
  }
}
process.stdout.write(
  `vendor: ${VIEWS.length} view(s), ${copied} file(s), ${(bytes / 1048576).toFixed(1)} MiB -> vendor/\n`,
)
