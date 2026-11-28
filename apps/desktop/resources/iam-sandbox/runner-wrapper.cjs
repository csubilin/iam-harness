#!/usr/bin/env node
/**
 * IAM `programRunner` adapter: run the target command under the Harness's
 * Windows ACL sandbox.
 *
 * The IAM bridge appends the Python command to the configured runner argv, so
 * this file is the stable prefix: `<electron.exe> runner-wrapper.cjs <python...>`.
 * The workspace and the ACL runner are deployment facts named by the Desktop
 * through the environment; nothing here hard-codes an installation path.
 *
 * `stdin`/`stdout`/`stderr` are inherited so the bridge sees the program's
 * streams exactly as it would without a runner, and the child's exit code is
 * mirrored. The runner's own failures print `iam-sandbox: ...` to stderr and
 * exit 127, which the bridge reports as a program that could not run.
 */

'use strict'

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')

const RUNNER = process.env.IAM_SANDBOX_RUNNER
const WORKSPACE = process.env.IAX_EXECUTION_WORKSPACE
const TEMP_ROOT = process.env.TEMP || process.env.TMP || tmpdir()

function fail(message) {
  process.stderr.write(`iam-sandbox: ${message}\n`)
  process.exit(127)
}

if (!RUNNER || !existsSync(RUNNER)) {
  fail(`IAM_SANDBOX_RUNNER is not a file: ${RUNNER ?? '(unset)'}`)
}
if (!WORKSPACE) {
  fail('IAX_EXECUTION_WORKSPACE is unset, so the program has no workspace to write in')
}
const command = process.argv.slice(2)
if (command.length === 0) fail('no command after the runner prefix')

// The ACL runner expects its own options before `--`; the workspace is the
// write boundary and TEMP is the root it creates a private writable child in.
const child = spawn(process.execPath, [
  RUNNER, '--workspace', WORKSPACE, '--temp', TEMP_ROOT, '--mode', 'workspace-write', '--', ...command,
], {
  cwd: WORKSPACE,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (error) => fail(error.message))
child.on('exit', (code) => { process.exit(code ?? 1) })
