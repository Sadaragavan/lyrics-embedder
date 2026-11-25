import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Normalizes a filesystem path for stable identity comparisons.
 * Windows paths are lowercased because NTFS is case-insensitive by default.
 */
export function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Computes a deterministic track ID from a file path.
 * Uses a SHA-256 hex prefix of the normalized absolute path so the same file
 * always maps to the same `media://track/<id>` URL and draft filename.
 */
export function computeTrackId(filePath: string): string {
  return crypto.createHash('sha256').update(normalizePathKey(filePath)).digest('hex').slice(0, 32)
}

/**
 * Validates a trackId against the expected 32-char lowercase hex format.
 * This prevents traversal and injection via malformed track IDs.
 */
export function isValidTrackId(trackId: string): boolean {
  return /^[0-9a-f]{32}$/.test(trackId)
}

/**
 * Resolves a path to its real path (following symlinks) for containment checks.
 * Returns the real absolute path, or throws if the path does not exist.
 */
export async function resolveRealPath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath)
  try {
    return await fs.realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path does not exist: ${absolute}`)
    }
    throw error
  }
}
