/**
 * Local `.lrc` sidecar file provider and `.lrc` import helper.
 *
 * Reads a sibling `.lrc` file (UTF-8, optional BOM) next to the audio track.
 * Enforces `<= 1 MiB` byte limit and rejects symlinks.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  LyricsCandidate,
  LyricsProvider,
  LyricsProviderId,
  LyricsQuery
} from '@shared/types'

const PROVIDER_ID: LyricsProviderId = 'localSidecar'
const MAX_SIDECAR_BYTES = 1024 * 1024 // 1 MiB

export interface LocalSidecarOptions {
  /** Override for tests: read file content. */
  readFile?: (filePath: string) => Promise<string>
  /** Override for tests: lstat a file. */
  lstat?: (filePath: string) => Promise<{ isSymbolicLink(): boolean; isFile(): boolean; size: number }>
}

/**
 * Returns the sibling `.lrc` path for the given audio file.
 */
export function getSidecarPath(audioPath: string): string {
  const dir = path.dirname(audioPath)
  const base = path.basename(audioPath, path.extname(audioPath))
  return path.join(dir, `${base}.lrc`)
}

/**
 * Strips a UTF-8 BOM (U+FEFF) from the beginning of a string.
 */
function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1)
  }
  return content
}

async function readVerifiedLrcFile(
  lrcPath: string,
  options: LocalSidecarOptions = {}
): Promise<string | null> {
  const lstatFn = options.lstat ?? ((filePath: string) => fs.lstat(filePath))
  const readFileFn = options.readFile ?? ((filePath: string) => fs.readFile(filePath, 'utf8'))

  let stat: { isSymbolicLink(): boolean; isFile(): boolean; size: number }
  try {
    stat = await lstatFn(lrcPath)
  } catch {
    return null
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return null
  }

  if (stat.size > MAX_SIDECAR_BYTES) {
    return null
  }

  try {
    const raw = await readFileFn(lrcPath)
    if (Buffer.byteLength(raw, 'utf8') > MAX_SIDECAR_BYTES) {
      return null
    }
    const content = stripBom(raw).trim()
    return content.length > 0 ? content : null
  } catch {
    return null
  }
}

export class LocalSidecarProvider implements LyricsProvider {
  readonly id: LyricsProviderId = PROVIDER_ID
  readonly displayName = 'Local .lrc Sidecar'

  private readonly options: LocalSidecarOptions

  constructor(options: LocalSidecarOptions = {}) {
    this.options = options
  }

  async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsCandidate | null> {
    if (signal?.aborted) return null

    const sidecarPath = getSidecarPath(query.filePath)
    const content = await readVerifiedLrcFile(sidecarPath, this.options)
    if (!content || signal?.aborted) return null

    const hasTimestamps = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(content)

    return {
      providerId: PROVIDER_ID,
      syncedLyrics: hasTimestamps ? content : null,
      plainLyrics: hasTimestamps ? null : content,
      score: hasTimestamps ? 100 : 6
    }
  }
}

/**
 * Reads an explicitly chosen `.lrc` file for the dialog import flow.
 * Enforces `.lrc` extension, `<= 1 MiB` size, and rejects symlinks.
 */
export async function importLrcFile(
  lrcPath: string,
  options: LocalSidecarOptions = {}
): Promise<string | null> {
  const ext = path.extname(lrcPath).toLowerCase()
  if (ext !== '.lrc') return null
  return readVerifiedLrcFile(lrcPath, options)
}

export function createLocalSidecarProvider(options: LocalSidecarOptions = {}): LyricsProvider {
  return new LocalSidecarProvider(options)
}
