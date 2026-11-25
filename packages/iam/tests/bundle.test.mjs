import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

// A row whose package the bundle does not depend on loads as a missing plugin
// in every fresh profile, and the Desktop closure silently drops its tarball.
const bundle = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bundle', 'iam')
const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
const patch = yaml.load(readFileSync(join(bundle, 'cordis.patch.yml'), 'utf8'))

test('the IAM bundle patch only inserts packages the bundle installs', () => {
  const rows = patch.flatMap(entry => entry?.insert ?? []).map(row => row.name).filter(name => typeof name === 'string')
  assert.ok(rows.length > 0)
  for (const name of rows) {
    assert.ok(manifest.dependencies?.[name] !== undefined, `${name} is inserted by cordis.patch.yml but not a bundle dependency`)
  }
})
