/**
 * Pure recursive library scanner.
 *
 * Kept free of `utilityProcess`/Electron so it can be unit tested directly.
 * Symlinks are never followed: every entry is `lstat`-ed and symbolic links
 * are skipped, preventing cycles and escaping an authorized root.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  type TrackRecord
} from '@shared/types'
import type { TrackMetadata } from '@shared/ipc'
import { computeTrackId } from './utils/trackId'

export interface ScanProgressUpdate {
  processed: number
  total: number
  currentPath?: string
  errors: number
}

export interface ScanAudioLibraryOptions {
  rootId: string
  extensions?: readonly string[]
  readMetadata: (filePath: string) => Promise<TrackMetadata>
  onProgress?: (update: ScanProgressUpdate) => void
  computeId?: (filePath: string) => string
  statFile?: (filePath: string) => Promise<{ mtimeMs: number }>
}

function toExtensionSet(extensions: readonly string[]): Set<string> {
  return new Set(extensions.map((extension) => extension.toLowerCase()))
}

/**
 * Recursively collects supported audio file paths beneath `rootPath`.
 * Results are sorted for deterministic scans and tests.
 */
export async function walkAudioFiles(
  rootPath: string,
  extensions: readonly string[] = SUPPORTED_AUDIO_EXTENSIONS
): Promise<string[]> {
  const allowed = toExtensionSet(extensions)
  const files: string[] = []

  async function walk(dirPath: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)

      let stat
      try {
        stat = await fs.lstat(fullPath)
      } catch {
        continue
      }

      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        await walk(fullPath)
        continue
      }

      if (stat.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }

  await walk(path.resolve(rootPath))
  files.sort((left, right) => left.localeCompare(right))
  return files
}

/**
 * Walks a root and turns every readable audio file into a `TrackRecord`.
 * Unreadable files are counted as errors and skipped rather than aborting the
 * whole scan.
 */
export async function scanAudioLibrary(
  rootPath: string,
  options: ScanAudioLibraryOptions
): Promise<TrackRecord[]> {
  const files = await walkAudioFiles(rootPath, options.extensions)
  const total = files.length
  const computeId = options.computeId ?? computeTrackId
  const statFile = options.statFile ?? ((filePath: string) => fs.stat(filePath))
  const tracks: TrackRecord[] = []

  let processed = 0
  let errors = 0

  options.onProgress?.({
    processed,
    total,
    currentPath: path.resolve(rootPath),
    errors
  })

  for (const filePath of files) {
    try {
      const metadata = await options.readMetadata(filePath)
      const stat = await statFile(filePath)
      tracks.push({
        id: computeId(filePath),
        filePath,
        format: metadata.format,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        durationSec: metadata.durationSec,
        lyrics: metadata.lyrics,
        lyricsSource: metadata.lyricsSource,
        existingLyricsKeys: metadata.existingLyricsKeys,
        libraryRootId: options.rootId,
        mtimeMs: stat.mtimeMs
      })
    } catch {
      errors++
    }

    processed++
    options.onProgress?.({ processed, total, currentPath: filePath, errors })
  }

  return tracks
}
