import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

// A row whose package the bundle does not depend on loads as a missing plugin
// in every fresh profile, and the Desktop closure silently drops its tarball.
const iamRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = resolve(iamRoot, '..', 'bundle', 'iam')
const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
const patch = yaml.load(readFileSync(join(bundle, 'cordis.patch.yml'), 'utf8'))

test('the IAM bundle patch only inserts packages the bundle installs', () => {
  const rows = patch.flatMap(entry => entry?.insert ?? []).map(row => row.name).filter(name => typeof name === 'string')
  assert.ok(rows.length > 0)
  for (const name of rows) {
    assert.ok(manifest.dependencies?.[name] !== undefined, `${name} is inserted by cordis.patch.yml but not a bundle dependency`)
  }
})

// The host build writes lib/*.js before packing, so a files list that names one
// entry file silently drops every sibling the entry imports: the plugin then
// fails to load only in an installer, never in the checkout.
test('every IAM package ships the modules its entry imports', () => {
  const manifests = readdirSync(iamRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(iamRoot, entry.name, 'package.json'))
    .filter(path => existsSync(path))
  manifests.push(join(bundle, 'package.json'))
  for (const manifestPath of manifests) {
    const directory = dirname(manifestPath)
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof pkg.main !== 'string') continue
    const entry = join(directory, pkg.main)
    if (!existsSync(entry)) continue
    const files = Array.isArray(pkg.files) ? pkg.files : []
    for (const match of readFileSync(entry, 'utf8').matchAll(/from\s+['"]\.\/([^'"]+)['"]/gu)) {
      const imported = posix.join(dirname(pkg.main.replaceAll('\\', '/')), match[1])
      const shipped = files.some(file => file === imported || imported.startsWith(`${file}/`))
      assert.ok(shipped, `${pkg.name} ships ${pkg.main} but not ./${match[1]}`)
    }
  }
})
