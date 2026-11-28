import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import { pluginRoot } from './helpers.mjs'

const WRAPPER = resolve(pluginRoot, '..', '..', 'apps', 'desktop', 'resources',
  'iam-sandbox', 'runner-wrapper.cjs')
const directory = mkdtempSync(join(tmpdir(), 'iam-program-runner-'))
after(() => rmSync(directory, { recursive: true, force: true }))

function wrapper(environment) {
  return spawnSync(process.execPath, [WRAPPER, 'python.exe', '-c', 'print(1)'], {
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  })
}

test('the adapter appends its target after the ACL runner options', () => {
  // The bridge appends the Python command to the configured runner argv; the
  // adapter's whole job is to put the ACL runner's options before it and the
  // workspace/temp it names around it.
  const runner = join(directory, 'fake-runner.cjs')
  writeFileSync(runner, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const result = wrapper({
    IAM_SANDBOX_RUNNER: runner,
    IAX_EXECUTION_WORKSPACE: workspace,
    TEMP: directory,
    TMP: directory,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), [
    '--workspace', workspace, '--temp', directory, '--mode', 'workspace-write',
    '--', 'python.exe', '-c', 'print(1)',
  ])
})

test('without a workspace it refuses rather than running unconfined', () => {
  const runner = join(directory, 'unused-runner.cjs')
  writeFileSync(runner, '')
  const result = wrapper({
    IAM_SANDBOX_RUNNER: runner,
    IAX_EXECUTION_WORKSPACE: '',
    TEMP: directory,
    TMP: directory,
  })
  assert.equal(result.status, 127)
  assert.match(result.stderr, /IAX_EXECUTION_WORKSPACE/)
})

test('without the ACL runner it refuses', () => {
  const result = wrapper({
    IAM_SANDBOX_RUNNER: join(directory, 'missing-runner.cjs'),
    IAX_EXECUTION_WORKSPACE: directory,
    TEMP: directory,
    TMP: directory,
  })
  assert.equal(result.status, 127)
  assert.match(result.stderr, /IAM_SANDBOX_RUNNER/)
})
