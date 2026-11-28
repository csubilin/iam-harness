import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BIN_FILES, stageIamPython, stageIfStale } from './stage-iam-python.ts'

function fixture(): string {
  const source = mkdtempSync(join(tmpdir(), 'iam-python-source-'))
  const bin = join(source, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const file of BIN_FILES) {
    writeFileSync(join(bin, file), file)
  }
  const library = join(source, 'lib', 'python3.14')
  for (const [path, body] of [
    ['os.py', 'os'], ['lib-dynload/_codecs.pyd', 'pyd'], ['encodings/utf_8.py', 'utf8'],
    ['test/test_os.py', 'tests'], ['site-packages/pip.py', 'pip'], ['tkinter/__init__.py', 'tk'],
    ['__pycache__/os.cpython-314.pyc', 'pyc'],
  ] as const) {
    mkdirSync(join(library, path, '..'), { recursive: true })
    writeFileSync(join(library, path), body)
  }
  return source
}

it('stages the interpreter and stdlib without tests, pip, tkinter or bytecode caches', () => {
  const source = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'iam-python-out-')), 'runtime')
  try {
    expect(stageIamPython(source, out)).toBeGreaterThan(0)
    for (const file of ['bin/python3.14.exe', 'bin/libpython3.14.dll', 'lib/python3.14/os.py',
      'lib/python3.14/lib-dynload/_codecs.pyd', 'lib/python3.14/encodings/utf_8.py']) {
      expect(existsSync(join(out, file)), file).toBe(true)
    }
    for (const file of ['lib/python3.14/test', 'lib/python3.14/site-packages', 'lib/python3.14/tkinter',
      'lib/python3.14/__pycache__']) {
      expect(existsSync(join(out, file)), file).toBe(false)
    }
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

it('re-stages only when the source is newer than the staged copy', () => {
  const source = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'iam-python-stale-')), 'runtime')
  try {
    expect(stageIfStale(source, out)).toBe(true)
    expect(stageIfStale(source, out)).toBe(false)
    // A runtime staged before a BIN_FILES addition is incomplete even when its
    // interpreter is up to date.
    unlinkSync(join(out, 'bin', 'zlib1.dll'))
    expect(stageIfStale(source, out)).toBe(true)
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(source, 'bin', 'python3.14.exe'), later, later)
    expect(stageIfStale(source, out)).toBe(true)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})
