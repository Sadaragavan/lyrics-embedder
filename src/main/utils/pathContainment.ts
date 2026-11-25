/**
 * Windows-safe path containment utilities.
 *
 * Uses `path.resolve` + `path.relative` so containment is decided by the real
 * relative path rather than string prefixes. This rejects:
 *  - cross-drive targets (`path.relative` returns an absolute path),
 *  - traversal escapes (`..`, `..\\`),
 *  - sibling-prefix bypasses such as `C:\\MusicEvil` vs root `C:\\Music`.
 *
 * On win32 both sides are lowercased before comparison because NTFS is
 * case-insensitive by default.
 */

import path from 'node:path'
import { normalizePathKey } from './trackId'

// Use unified canonical path normalization from trackId.ts
function normalizeForComparison(filePath: string): string {
  return normalizePathKey(filePath)
}

/**
 * Returns true when `filePath` is the root itself or lives underneath one of
 * the supplied absolute root paths.
 */
export function isPathWithinRoots(filePath: string, roots: readonly string[]): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  if (!path.isAbsolute(filePath)) return false

  const target = normalizeForComparison(filePath)

  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue
    if (!path.isAbsolute(root)) continue

    const relative = path.relative(normalizeForComparison(root), target)

    // Same path as the root.
    if (relative === '') return true

    // Cross-drive on Windows yields an absolute relative path.
    if (path.isAbsolute(relative)) continue

    // Traversal escape. Covers both `..` and `..\\` on Windows.
    if (relative.startsWith('..')) continue

    return true
  }

  return false
}

/**
 * Finds the first authorized root that contains `filePath`.
 */
export function findContainingRoot(filePath: string, roots: readonly string[]): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) {
    return null
  }

  for (const root of roots) {
    if (isPathWithinRoots(filePath, [root])) {
      return root
    }
  }

  return null
}

/**
 * Validates an absolute, supported audio path inside one of the authorized
 * roots. Throws with a descriptive message when validation fails.
 */
export function validateAudioPathInRoots(
  filePath: string,
  roots: readonly string[],
  supportedExtensions: readonly string[]
): string {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    throw new Error('Invalid file path')
  }

  const normalized = path.resolve(filePath)
  if (!path.isAbsolute(normalized)) {
    throw new Error(`Path must be absolute: ${filePath}`)
  }

  const extension = path.extname(normalized).toLowerCase()
  const allowed = supportedExtensions.map((ext) => ext.toLowerCase())
  if (!allowed.includes(extension)) {
    throw new Error(`Unsupported audio file extension: ${extension || '(none)'}`)
  }

  if (!isPathWithinRoots(normalized, roots)) {
    throw new Error(`Path is outside authorized library roots: ${normalized}`)
  }

  return normalized
}
