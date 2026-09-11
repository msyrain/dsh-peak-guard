#!/usr/bin/env node
/**
 * Push the runtime files from this checkout into an installed profile copy.
 *
 *   node sync.mjs                  # report drift, then re-copy the runtime
 *   node sync.mjs --check          # report drift only; exit 1 when it differs
 *   node sync.mjs --profile web --dsh-home D:\other-dsh
 *
 * Why this exists: `install.mjs` COPY mode puts a real copy of the plugin in the
 * profile, and a copy does not follow edits here. The failure is silent and
 * confusing — the host half keeps working from the stale copy while the browser
 * half serves an old bundle, so a fix looks like it "did not apply". This script
 * makes the drift explicit and fixes it in one step.
 *
 * `install.mjs` LINK mode (a directory junction) does not need this at all: the
 * profile then resolves straight through to this checkout, so every edit is live
 * and only the browser refresh remains. Prefer that for development.
 *
 * After a sync, reload the page: the browser bundle is content-addressed, and a
 * page picks a revision up at load (or through the client HMR channel).
 *
 * @module dsh-peak-guard/sync
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { packageFiles } from './scripts/package-files.mjs'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR_NAME = 'dsh-peak-guard'

/** Parse the flag surface. */
function parseArgs(argv) {
  const options = {
    profile: 'web',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    check: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--dsh-home') options.dshHome = resolve(argv[++index])
    else if (arg === '--check') options.check = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** Hash a file's bytes, or undefined when it does not exist. */
function hashOf(path) {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
}

/**
 * True when a path is a junction or symlink, which makes syncing unnecessary.
 * @param {string} path - the candidate.
 * @returns {boolean} whether the path is a link.
 */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('usage: node sync.mjs [--profile <name>] [--dsh-home <path>] [--check]\n')
    return
  }
  const installed = join(options.dshHome, 'profiles', options.profile, INSTALL_DIR_NAME)
  if (!existsSync(installed)) {
    throw new Error(`no installed plugin at ${installed} (run: node install.mjs)`)
  }
  if (isLink(installed)) {
    // Report the link's TARGET, not the link's own path: printing the link path
    // as its own target reads as a self-referential link and hides the one fact
    // the operator wants, namely which checkout is actually serving.
    const target = realpathSync(installed)
    const sameCheckout = resolve(target).toLowerCase() === resolve(SOURCE_DIR).toLowerCase()
    process.stdout.write(`${installed}\n  is a link to: ${target}\n`)
    process.stdout.write(
      sameCheckout
        ? 'That is this checkout, so every edit here is already live. Nothing to sync.\n'
        : `That is NOT this checkout (${SOURCE_DIR}), so this sync would write to the wrong\n`
          + 'copy. Reinstall with `node install.mjs --force` to point it here.\n',
    )
    process.stdout.write('(A page reload is still needed for the browser half.)\n')
    return sameCheckout ? undefined : (process.exitCode = 1, undefined)
  }

  // The comparison set is the package's published file list, so "up to date"
  // means the installed copy matches what a fresh install would produce.
  const files = packageFiles(SOURCE_DIR)
  const drifted = []
  const missing = []
  for (const relative of files) {
    const from = join(SOURCE_DIR, relative)
    const to = join(installed, relative)
    const a = hashOf(from)
    const b = hashOf(to)
    if (b === undefined) missing.push(relative)
    else if (a !== b) drifted.push(relative)
  }

  process.stdout.write(`checkout : ${SOURCE_DIR}\n`)
  process.stdout.write(`installed: ${installed} (real copy, does not follow edits)\n\n`)
  if (drifted.length === 0 && missing.length === 0) {
    process.stdout.write(`${files.length} runtime files, all identical — nothing to do.\n`)
    return
  }
  if (drifted.length > 0) process.stdout.write(`differs (${drifted.length}):\n  ${drifted.join('\n  ')}\n`)
  if (missing.length > 0) process.stdout.write(`missing (${missing.length}):\n  ${missing.join('\n  ')}\n`)

  if (options.check) {
    process.stdout.write('\n--check: drift detected; re-run without --check to sync.\n')
    process.exitCode = 1
    return
  }

  let copied = 0
  for (const relative of [...drifted, ...missing]) {
    const from = join(SOURCE_DIR, relative)
    const to = join(installed, relative)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    copied += 1
  }
  process.stdout.write(`\nre-copied ${copied} file(s) into the installed plugin.\n`)
  process.stdout.write('Now reload the page to pick up the browser bundle.\n')
}

try {
  main()
} catch (error) {
  process.stderr.write(`sync: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
