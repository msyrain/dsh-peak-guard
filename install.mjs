#!/usr/bin/env node
/**
 * Install or uninstall the dsh-peak-guard plugin in a dsh profile.
 *
 *   node install.mjs                 # link this checkout into the `web` profile
 *   node install.mjs --copy          # copy the runtime files instead of linking
 *   node install.mjs --uninstall     # remove the row and the installed directory
 *   node install.mjs --profile sdk --dsh-home D:\other-home
 *
 * Two strategies, because a dsh plugin module's bare imports resolve from the
 * module's OWN directory:
 *
 * - **link** (default) — creates a directory junction at
 *   `<profile>/dsh-peak-guard` pointing at this checkout. Node resolves a
 *   junction to its real path, so the plugin keeps resolving
 *   `@deepseek-ai/*` through the profile's `node_modules` while every edit made
 *   here is live at once. This is the development loop, and it needs no
 *   elevated shell (a junction is not a symlink).
 * - **copy** — copies the runtime files into the profile. Use this to test
 *   exactly what a user receives, with no checkout on disk.
 *
 * Both strategies edit only the profile's own `cordis.patch.yml`, and only
 * inside the managed marker block, so unrelated user patches survive untouched.
 * The `web` profile has `patchReload: live`, so the patched row mounts without
 * a restart; plugin CODE edits still need a restart because module reload is
 * off in the shipped composition.
 *
 * Written in Node rather than PowerShell deliberately: Windows PowerShell 5.1
 * round-trips non-ASCII literals through the console code page, which mangles
 * the Chinese labels this plugin's config carries.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { packageFiles } from './scripts/package-files.mjs'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const BEGIN_MARKER = '# >>> dsh-peak-guard (managed by install.mjs) >>>'
const END_MARKER = '# <<< dsh-peak-guard <<<'
const INSTALL_DIR_NAME = 'dsh-peak-guard'

/** Parse the small flag surface this script needs. */
function parseArgs(argv) {
  const options = {
    profile: 'web',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    copy: false,
    uninstall: false,
    force: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = requireValue(argv, ++index, arg)
    else if (arg === '--dsh-home') options.dshHome = resolve(requireValue(argv, ++index, arg))
    else if (arg === '--copy') options.copy = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** Read a flag's value or fail loudly. */
function requireValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

const USAGE = `Install dsh-peak-guard into a dsh profile.

  node install.mjs [--profile <name>] [--dsh-home <path>] [--copy] [--force]
  node install.mjs --uninstall [--profile <name>] [--dsh-home <path>]
`

/** The managed block, written into the profile's own patch layer. */
function managedBlock() {
  return [
    BEGIN_MARKER,
    '# An always-active row: the plugin ships its own peak windows (Beijing time,',
    '# Monday-Friday 09:00-12:00 and 14:00-18:00) and its own price table, so this',
    '# row only needs the module path. Override `config:` here to change either.',
    '- insert:',
    '    - id: peak-guard',
    `      name: './${INSTALL_DIR_NAME}/index.js'`,
    END_MARKER,
    '',
  ].join('\n')
}

/**
 * Remove the managed block from a patch document.
 * @param {string} text - the current patch file contents.
 * @returns {string} the document without this script's block.
 */
function stripManagedBlock(text) {
  const pattern = new RegExp(
    `${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\r?\\n?`,
    'g',
  )
  return text.replace(pattern, '')
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Merge the managed block into a patch document.
 *
 * A profile patch that has never been edited ends with the literal `[]` — the
 * empty top-level array. Appending a second document after it would make the
 * file invalid YAML, so the empty array is dropped first while every real row
 * and comment banner above it survives.
 *
 * @param {string} text - the current patch file contents.
 * @returns {string} the document with exactly one managed block.
 */
function withManagedBlock(text) {
  const kept = stripManagedBlock(text)
    .split(/\r?\n/)
    .filter(line => !/^\s*\[\s*\]\s*$/.test(line))
    .join('\n')
    .trimEnd()
  return `${kept}\n\n${managedBlock()}`
}

/** True when the path is a directory junction or symlink. */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Copy the package's files into the profile.
 *
 * The list comes from `package.json`'s `files` field rather than a second,
 * hand-maintained array: a copy has to contain the same files the package
 * publishes, and two lists are exactly how a copy install previously ended up
 * missing six of them.
 */
function copyRuntime(target) {
  mkdirSync(target, { recursive: true })
  for (const relative of packageFiles(SOURCE_DIR)) {
    const destination = join(target, relative)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(join(SOURCE_DIR, relative)))
  }
}

/** Remove the installed directory, whether it is a link or a real directory. */
function removeInstalled(target) {
  if (!existsSync(target) && !isLink(target)) return false
  if (isLink(target)) rmSync(target, { force: true })
  else rmSync(target, { recursive: true, force: true })
  return true
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }

  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const installedDir = join(profileDir, INSTALL_DIR_NAME)

  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`profile "${options.profile}" not found at ${profileDir}`)
  }

  if (options.uninstall) {
    const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    if (text.includes(BEGIN_MARKER)) {
      writeFileSync(patchPath, stripManagedBlock(text))
      process.stdout.write(`removed the peak-guard block from ${patchPath}\n`)
    } else {
      process.stdout.write(`no peak-guard block in ${patchPath}\n`)
    }
    const removed = removeInstalled(installedDir)
    process.stdout.write(removed ? `removed ${installedDir}\n` : `nothing installed at ${installedDir}\n`)
    process.stdout.write('Uninstalled. The row disappears on the next patch reload.\n')
    return
  }

  if (existsSync(installedDir)) {
    const linked = isLink(installedDir)
    if (!linked && !options.force) {
      throw new Error(`${installedDir} already exists and is not a link; re-run with --force to replace it`)
    }
    removeInstalled(installedDir)
  }

  if (options.copy) {
    copyRuntime(installedDir)
    process.stdout.write(`copied the runtime files to ${installedDir}\n`)
  } else {
    // `junction` is the Windows directory-link type a non-elevated process may
    // create; elsewhere a plain directory symlink is the equivalent.
    symlinkSync(SOURCE_DIR, installedDir, process.platform === 'win32' ? 'junction' : 'dir')
    process.stdout.write(`linked ${SOURCE_DIR} -> ${installedDir}\n`)
  }

  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  writeFileSync(patchPath, withManagedBlock(text))
  process.stdout.write(`wrote the peak-guard row to ${patchPath}\n`)
  process.stdout.write(`\nInstalled into profile "${options.profile}".\n`)
  process.stdout.write(`The web profile reloads patches live, so the row mounts now.\n`)
  process.stdout.write(`Verify:  dsh --profile ${options.profile} --dump-config | findstr peak-guard\n`)
  process.stdout.write(`Restart the server to pick up plugin CODE changes (module reload is off).\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`install: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
