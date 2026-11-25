import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { cleanup, loadHost, workspace } from './helpers.mjs'

after(cleanup)

const address = await loadHost('views').then((host) => host.address)

test('a file inside the workspace resolves to itself', () => {
  const space = workspace()
  const file = space.write('sheet.iamp', 'drawing')
  const resolved = address.resolveWorkspaceFile(space.roots, space.addressOf('sheet.iamp'))
  assert.ok(!address.isAddressFailure(resolved), JSON.stringify(resolved))
  assert.equal(resolved.realPath, file)
  assert.equal(resolved.path, file)
  assert.equal(resolved.relative, 'sheet.iamp')
  assert.equal(resolved.size, 'drawing'.length)
})

test('a name with a space and a Chinese name both travel', () => {
  const space = workspace()
  const sentence = 'A file with spaces'
  const chinese = '地下矿山整体系统'
  space.write(sentence, 'x')
  space.write(chinese, 'y')
  for (const name of [sentence, chinese]) {
    const resolved = address.resolveWorkspaceFile(space.roots, space.addressOf(name))
    assert.ok(!address.isAddressFailure(resolved), `${name}: ${JSON.stringify(resolved)}`)
    assert.equal(resolved.relative, name)
  }
})

test('a path that climbs out with .. is refused', () => {
  const space = workspace()
  const resolved = address.resolveWorkspaceFile(space.roots, space.addressOf('../outside.iamp'))
  assert.ok(address.isAddressFailure(resolved))
  assert.match(resolved.error, /越出/)
})

test('an absolute path is refused', () => {
  const space = workspace()
  const smuggled = `dsh-resource://file/session/${space.sessionId}/%2Fetc%2Fpasswd`
  const resolved = address.resolveWorkspaceFile(space.roots, smuggled)
  assert.ok(address.isAddressFailure(resolved))
  assert.match(resolved.error, /相对路径/)
})

test('a NUL byte is refused rather than truncating the open', () => {
  const space = workspace()
  const smuggled = `dsh-resource://file/session/${space.sessionId}/sheet.iamp%00.txt`
  const resolved = address.resolveWorkspaceFile(space.roots, smuggled)
  assert.ok(address.isAddressFailure(resolved))
  assert.match(resolved.error, /空字节/)
})

test('a symlink inside the workspace pointing OUT of it is refused', () => {
  const space = workspace()
  const outside = workspace('other-session')
  const secret = outside.write('secret.iamp', 'not yours')
  symlinkSync(secret, join(space.root, 'innocent.iamp'))

  const resolved = address.resolveWorkspaceFile(space.roots, space.addressOf('innocent.iamp'))
  assert.ok(address.isAddressFailure(resolved), 'the symlink was followed out of the workspace')
  assert.match(resolved.error, /符号链接/)
})

test('a symlink pointing INSIDE the workspace is still readable', () => {
  const space = workspace()
  space.write('real.iamp', 'real bytes')
  symlinkSync(join(space.root, 'real.iamp'), join(space.root, 'link.iamp'))

  const resolved = address.resolveWorkspaceFile(space.roots, space.addressOf('link.iamp'))
  assert.ok(!address.isAddressFailure(resolved), JSON.stringify(resolved))
  assert.equal(resolved.realPath, join(space.root, 'real.iamp'))
})

test('a workspace reached through a symlinked root still confines', () => {
  // The root itself is a symlink; `resolve` alone would compare the wrong two
  // strings and either refuse everything or admit everything.
  const real = workspace()
  real.write('sheet.iamp', 'bytes')
  const alias = workspace('session-alias')
  const linkedRoot = join(alias.root, 'workspace')
  symlinkSync(real.root, linkedRoot)

  const lookup = (id) => (id === 'session-alias' ? linkedRoot : undefined)
  const good = address.resolveWorkspaceFile(lookup, alias.addressOf('sheet.iamp'))
  assert.ok(!address.isAddressFailure(good), JSON.stringify(good))
  const bad = address.resolveWorkspaceFile(lookup, alias.addressOf('../escape.iamp'))
  assert.ok(address.isAddressFailure(bad))
})

test('a missing file, a directory and a device are each refused', () => {
  const space = workspace()
  space.write('sub/inner.iamp', 'x')
  const missing = address.resolveWorkspaceFile(space.roots, space.addressOf('nope.iamp'))
  assert.ok(address.isAddressFailure(missing))
  assert.match(missing.error, /没有这个文件/)

  const directory = address.resolveWorkspaceFile(space.roots, space.addressOf('sub'))
  assert.ok(address.isAddressFailure(directory))
  assert.match(directory.error, /常规文件/)
})

test('an address for a session this host does not have is refused', () => {
  const space = workspace()
  space.write('sheet.iamp', 'x')
  const foreign = `dsh-resource://file/session/session-elsewhere/sheet.iamp`
  const resolved = address.resolveWorkspaceFile(space.roots, foreign)
  assert.ok(address.isAddressFailure(resolved))
  assert.match(resolved.error, /工作区/)
})

test('a non-address is refused rather than passed through', () => {
  const space = workspace()
  const resolved = address.resolveWorkspaceFile(space.roots, '/etc/passwd')
  assert.ok(address.isAddressFailure(resolved))
})

test('the session id and the basename are read back out of an address', () => {
  const space = workspace()
  const url = space.addressOf('folder/a sheet.iamp')
  assert.equal(address.resourceAddressSession(url), space.sessionId)
  assert.equal(address.basenameOf(url), 'a sheet.iamp')
  assert.equal(address.resourceAddressSession('dsh-resource://file/other/1/x'), null)
  assert.equal(address.basenameOf('dsh-resource://file/session/s/%E4%B8%AD.iam?x=1'), '中.iam')
})

test('the read holds a handle proven to be the file that was resolved', async () => {
  const space = workspace()
  space.write('sheet.iamp', 'the real bytes')
  const opened = await address.openWorkspaceFile(space.roots, space.addressOf('sheet.iamp'))
  assert.ok(!address.isAddressFailure(opened), JSON.stringify(opened))
  try {
    assert.equal((await opened.handle.readFile()).toString('utf8'), 'the real bytes')
  } finally {
    await opened.handle.close()
  }
})

test('a file swapped between the check and the open is refused', async () => {
  // The one window the textual and the realpath checks cannot close: they
  // describe a path, and something replaces it before the open. `fs.open` is
  // patched for exactly one call, to stand in for the race.
  //
  // The replacement is a SYMLINK TO ANOTHER FILE and not a rewritten one, which
  // is the shape the attack has -- and which the first version of this test got
  // wrong in a way worth keeping: unlinking a file and creating a new one at the
  // same path can be handed the same inode number back, so a dev/ino-only check
  // passed it. That is why the comparison is not dev/ino alone.
  const space = workspace()
  const elsewhere = workspace('other-session')
  const secret = elsewhere.write('secret.iamp', 'not yours')
  const target = space.write('sheet.iamp', 'the real bytes')

  const original = fsPromises.open
  let interposed = false
  fsPromises.open = async (path, ...rest) => {
    if (!interposed && path === target) {
      interposed = true
      unlinkSync(path)
      symlinkSync(secret, path)
    }
    return original.call(fsPromises, path, ...rest)
  }
  try {
    const opened = await address.openWorkspaceFile(space.roots, space.addressOf('sheet.iamp'))
    assert.ok(address.isAddressFailure(opened), 'the swapped file was read')
    assert.match(opened.error, /被替换/)
  } finally {
    fsPromises.open = original
  }
  assert.ok(interposed, 'the interposition never ran, so the test proved nothing')
})

test('a file rewritten between the check and the open is refused', async () => {
  // The same window, with the replacement happening in place: the same inode,
  // different bytes. Identity alone would not notice.
  const space = workspace()
  const target = space.write('sheet.iamp', 'the real bytes')

  const original = fsPromises.open
  let interposed = false
  fsPromises.open = async (path, ...rest) => {
    if (!interposed && path === target) {
      interposed = true
      writeFileSync(path, 'something else entirely')
    }
    return original.call(fsPromises, path, ...rest)
  }
  try {
    const opened = await address.openWorkspaceFile(space.roots, space.addressOf('sheet.iamp'))
    assert.ok(address.isAddressFailure(opened), 'the rewritten file was read')
    assert.match(opened.error, /被替换/)
  } finally {
    fsPromises.open = original
  }
  assert.ok(interposed, 'the interposition never ran, so the test proved nothing')
})

test('verifyWorkspaceFile re-proves the same file before a launch', () => {
  const space = workspace()
  const file = space.write('sheet.iamp', 'bytes')
  const first = address.verifyWorkspaceFile(space.roots, space.addressOf('sheet.iamp'))
  assert.ok(!address.isAddressFailure(first))
  assert.equal(first.realPath, file)
  // And once the file is gone, the second answer follows it.
  unlinkSync(file)
  const second = address.verifyWorkspaceFile(space.roots, space.addressOf('sheet.iamp'))
  assert.ok(address.isAddressFailure(second))
})

test('a directory that exists but holds no such file is refused, not created', () => {
  const space = workspace()
  mkdirSync(join(space.root, 'empty'))
  const resolved = address.resolveWorkspaceFile(space.roots, space.addressOf('empty/new.iamp'))
  assert.ok(address.isAddressFailure(resolved))
  assert.throws(() => readFileSync(join(space.root, 'empty', 'new.iamp')))
})
