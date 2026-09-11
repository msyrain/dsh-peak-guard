/**
 * The one list of files that constitutes this package.
 *
 * Both consumers read it, which is the point: `package.json`'s `files` field is
 * the canonical, published answer to "what is this package", and the install and
 * sync tooling copies exactly that. Keeping a second hand-maintained list in the
 * tooling is what previously let a copy install silently omit six files
 * (`LICENSE`, the changelog, the contributing guide, `sync.mjs`, `install.mjs`,
 * and the client build script) while `sync.mjs --check` reported only the last
 * one as missing.
 *
 * Directory entries are expanded to the files beneath them, because a copy has
 * to materialize real files rather than carry a directory-level rule.
 *
 * @module dsh-peak-guard/package-files
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this module lives in `scripts/`). */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Files npm always includes regardless of the `files` field. */
const ALWAYS_INCLUDED = ['package.json', 'README.md', 'LICENSE']

/**
 * Read `package.json`'s `files` field.
 * @param {string} [root] - package root to read from.
 * @returns {string[]} the declared entries, directories included.
 * @throws {Error} when the manifest is unreadable or declares no file list.
 */
export function declaredEntries(root = PACKAGE_ROOT) {
  const manifestPath = join(root, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`package-files: cannot read ${manifestPath}: ${error.message}`)
  }
  const files = manifest.files
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('package-files: package.json declares no "files" list, so there is nothing to copy')
  }
  return [...files, ...ALWAYS_INCLUDED]
}

/**
 * Resolve every file the package consists of, as paths relative to its root.
 *
 * @param {string} [root] - package root.
 * @returns {string[]} sorted relative file paths using `/` separators.
 * @throws {Error} when a declared entry does not exist on disk.
 */
export function packageFiles(root = PACKAGE_ROOT) {
  const out = new Set()
  for (const entry of declaredEntries(root)) {
    const absolute = join(root, entry)
    if (!existsSync(absolute)) {
      throw new Error(`package-files: package.json declares "${entry}" but it does not exist in ${root}`)
    }
    if (statSync(absolute).isDirectory()) {
      for (const file of walk(absolute, root)) out.add(file)
    } else {
      out.add(entry.split(sep).join('/'))
    }
  }
  return [...out].sort()
}

/**
 * List files beneath a directory, relative to the package root.
 * @param {string} directory - absolute directory to walk.
 * @param {string} root - package root the returned paths are relative to.
 * @returns {string[]} package-relative file paths.
 */
function walk(directory, root) {
  const out = []
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name)
    if (statSync(absolute).isDirectory()) out.push(...walk(absolute, root))
    else out.push(relative(root, absolute).split(sep).join('/'))
  }
  return out
}
