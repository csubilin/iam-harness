#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
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

const target = join(root, 'vendor')
mkdirSync(target, { recursive: true })

let copied = 0
let bytes = 0
for (const view of VIEWS) {
  for (const suffix of SUFFIXES) {
    const from = join(SOURCE, view + suffix)
    if (!existsSync(from)) {
      process.stderr.write(`vendor-views: missing ${from}\n`)
      process.exit(1)
    }
    copyFileSync(from, join(target, view + suffix))
    copied += 1
    bytes += statSync(from).size
  }
}
process.stdout.write(
  `vendor: ${VIEWS.length} view(s), ${copied} file(s), ${(bytes / 1048576).toFixed(1)} MiB -> vendor/\n`,
)
