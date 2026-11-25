import crypto from 'node:crypto'
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
