/**
 * The package's file list is the single source both the install tooling and npm
 * publish read from.
 *
 * The regression this guards is concrete: a copy install once omitted six files
 * (`LICENSE`, the changelog, the contributing guide, `sync.mjs`, `install.mjs`,
 * and the client build script) because the tooling kept its own hand-written
 * list beside `package.json`'s `files`. Nothing failed — the copy looked
 * installed, and `sync.mjs --check` blamed only the last missing file.
 *
 * `npm pack --dry-run --json` is the authority here: it is what npm would
 * actually publish, so comparing against it is what stops the declaration from
 * quietly drifting from the shipped artifact.
 *
 * Run with `node --test "tests/*.test.js"`.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'

import { PACKAGE_ROOT, declaredEntries, packageFiles } from '../scripts/package-files.mjs'

/**
 * Ask npm what it would actually publish.
 *
 * `--dry-run` writes the tarball to a throwaway destination rather than the
 * working tree, so the test leaves no `.tgz` behind. The JSON report has
 * changed shape across npm majors — older npm emits an array of entries, newer
 * npm emits an object keyed by package name — so both are accepted rather than
 * pinning the test to one version.
 *
 * @returns {string[]} published paths, relative to the package root.
 */
function npmPackFiles() {
  const destination = mkdtempSync(join(tmpdir(), 'peak-guard-pack-'))
  try {
    const stdout = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--pack-destination', destination],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
    )
    const parsed = JSON.parse(stdout)
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    assert.ok(entry && Array.isArray(entry.files), `npm pack --json reported no file list; got ${stdout.slice(0, 200)}`)
    return entry.files.map(file => String(file.path).split('\\').join('/')).sort()
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

test('the declared list resolves to files that all exist', () => {
  const declared = packageFiles()
  assert.ok(declared.length > 0, 'the package declares files')
  for (const relativePath of declared) {
    assert.equal(isAbsolute(relativePath), false, `${relativePath} must be package-relative`)
    assert.ok(existsSync(join(PACKAGE_ROOT, relativePath)), `${relativePath} is declared but missing on disk`)
  }
})

test('every declared entry is accounted for', () => {
  // A directory entry contributes its contents, so the resolved list must be a
  // superset of the non-directory declarations and never silently drop one.
  const files = new Set(packageFiles())
  for (const entry of declaredEntries()) {
    if (existsSync(join(PACKAGE_ROOT, entry)) && packageFiles().includes(entry)) continue
    // Directory entries are represented by their files instead of themselves.
    const covered = [...files].some(file => file.startsWith(`${entry}/`))
    assert.ok(covered, `declared entry "${entry}" contributes nothing to the package`)
  }
})

test('the install tooling would copy exactly what npm publishes', () => {
  // This is the regression test for the six missing files: the tooling reads
  // this same list, so equality with npm's own answer means a copy install
  // cannot be short a file again.
  const fromNpm = npmPackFiles()
  const fromDeclaration = packageFiles()
  assert.deepEqual(
    fromDeclaration,
    fromNpm,
    'scripts/package-files.mjs and the published tarball disagree about the package contents',
  )
})

test('the package ships the files a working install needs', () => {
  // Named explicitly so a future edit that trims "unnecessary" entries has to
  // argue with a test rather than with a user whose installed copy is broken.
  const files = new Set(packageFiles())
  for (const required of [
    'index.js',
    'package.json',
    'cordis.patch.yml',
    'lib/client.js',
    'src/peak.js',
    'src/config.js',
    'scripts/build-client.mjs',
    'install.mjs',
    'sync.mjs',
    'LICENSE',
  ]) {
    assert.ok(files.has(required), `the package must ship ${required}`)
  }
})

test('development-only paths stay out of the package', () => {
  for (const relativePath of packageFiles()) {
    assert.equal(/^(tests|\.github|node_modules)\//.test(relativePath), false, `${relativePath} must not ship`)
    assert.equal(relativePath.startsWith('.'), false, `${relativePath} must not ship`)
  }
})

test('the declaration covers the repository it lives in', () => {
  // Sanity on the other direction: a source file a consumer would need but that
  // nothing declares is just as broken as a declared-but-missing one.
  const files = new Set(packageFiles())
  for (const required of ['src/client.js', 'scripts/package-files.mjs']) {
    assert.ok(files.has(required), `${required} is part of the package and must be declared`)
  }
  assert.equal(relative(PACKAGE_ROOT, PACKAGE_ROOT), '', 'PACKAGE_ROOT is the package root')
})
