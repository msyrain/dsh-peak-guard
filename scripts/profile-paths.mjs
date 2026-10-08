/**
 * The facts `install.mjs` and `sync.mjs` must agree on.
 *
 * Both scripts operate on the same directory inside a dsh profile, and both
 * have to answer whether what is there is a junction/symlink or a real copy.
 * Each used to carry its own copy of the install-directory name, the DSH_HOME
 * default, and the link test. Two hand-written answers to one question are
 * exactly how a later edit points one script at a directory the other never
 * looks in.
 *
 * @module dsh-peak-guard/profile-paths
 */

import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory name this plugin is installed under, inside a profile. */
export const INSTALL_DIR_NAME = 'dsh-peak-guard'

/**
 * The dsh home a run defaults to.
 * @returns {string} `$DSH_HOME` when set, else `~/.dsh`.
 */
export function defaultDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * True when a path is a directory junction or symlink rather than a real copy.
 *
 * A missing path answers false: both callers read that as nothing being
 * installed here, and each checks existence separately before acting.
 *
 * @param {string} path - the candidate.
 * @returns {boolean} whether the path is a link.
 */
export function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
