/**
 * Atomic JSON persistence for `library-index.json` and per-track drafts.
 *
 * All writes go to `app.getPath('userData')`, staged as a same-directory
 * temporary file and swapped with `fs.rename` under bounded Windows lock
 * retries. Draft filenames are the deterministic track hash:
 * `userData/drafts/<trackIdHash>.json`.
 *
 * This module deliberately has no `electron` import so it can be unit tested
 * in a plain Node/Vitest environment.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  DraftStatus,
  LibraryIndex,
  LibraryRoot,
  LyricDraft,
  TrackRecord
} from '@shared/types'
import {
  cleanupStaleTempFiles,
  retryOnLockError,
  type RetryOptions
} from './tagger'
import { computeTrackId, normalizePathKey } from './utils/trackId'

export { computeTrackId }

export type RenameOperation = (oldPath: string, newPath: string) => Promise<void>

export interface StoreOptions {
  /** Injected for tests; defaults to `fs.rename`. */
  rename?: RenameOperation
  retryOptions?: RetryOptions
  /** Injected for tests; defaults to `cleanupStaleTempFiles(..., { recursive: true })`. */
  sweepDirectory?: (dirPath: string) => Promise<string[]>
}

export interface SaveDraftInput {
  trackId: string
  lyrics: string
  status?: DraftStatus
}

/**
 * Deterministic draft identifier for a track. The track id is already a
 * SHA-256 hex prefix, so it doubles as the draft filename.
 */
export function computeDraftId(trackId: string): string {
  return trackId
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

/**
 * Reads and parses JSON. Returns `null` when the file does not exist.
 * Corrupt JSON is surfaced with the file path for diagnosability.
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  try {
    return JSON.parse(content) as T
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse JSON at ${filePath}: ${reason}`)
  }
}

/**
 * Writes JSON atomically: stage a uniquely named sibling temp file, then
 * `fs.rename` it into place with bounded retry on EBUSY/EPERM/EACCES.
 */
export async function writeJson<T>(
  filePath: string,
  data: T,
  options: StoreOptions = {}
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  )
  const rename = options.rename ?? fs.rename

  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await retryOnLockError(() => rename(tmpPath, filePath), options.retryOptions)
  } finally {
    await safeUnlink(tmpPath)
  }
}

function cloneIndex(index: LibraryIndex): LibraryIndex {
  return {
    roots: [...index.roots],
    tracks: [...index.tracks]
  }
}

export class JsonStore {
  readonly userDataDir: string
  readonly draftsDir: string
  readonly indexPath: string
  private readonly options: StoreOptions

  constructor(userDataDir: string, options: StoreOptions = {}) {
    this.userDataDir = path.resolve(userDataDir)
    this.draftsDir = path.join(this.userDataDir, 'drafts')
    this.indexPath = path.join(this.userDataDir, 'library-index.json')
    this.options = options
  }

  private draftPath(trackId: string): string {
    return path.join(this.draftsDir, `${computeDraftId(trackId)}.json`)
  }

  async readIndex(): Promise<LibraryIndex> {
    const index = await readJson<LibraryIndex>(this.indexPath)
    if (!index || !Array.isArray(index.roots) || !Array.isArray(index.tracks)) {
      return { roots: [], tracks: [] }
    }
    return { roots: index.roots, tracks: index.tracks }
  }

  async writeIndex(index: LibraryIndex): Promise<void> {
    await writeJson(this.indexPath, cloneIndex(index), this.options)
  }

  async getRoots(): Promise<LibraryRoot[]> {
    const index = await this.readIndex()
    return index.roots
  }

  async getTracks(): Promise<TrackRecord[]> {
    const index = await this.readIndex()
    return index.tracks
  }

  async getTrack(trackId: string): Promise<TrackRecord | null> {
    const index = await this.readIndex()
    return index.tracks.find((track) => track.id === trackId) ?? null
  }

  async addRoot(root: LibraryRoot): Promise<LibraryRoot> {
    const index = await this.readIndex()
    const existing = index.roots.find(
      (candidate) => normalizePathKey(candidate.path) === normalizePathKey(root.path)
    )
    if (existing) {
      return existing
    }
    index.roots.push(root)
    await this.writeIndex(index)
    return root
  }

  async removeRoot(rootId: string): Promise<boolean> {
    const index = await this.readIndex()
    const nextRoots = index.roots.filter((root) => root.id !== rootId)
    if (nextRoots.length === index.roots.length) {
      return false
    }
    const removedTrackIds = index.tracks
      .filter((track) => track.libraryRootId === rootId)
      .map((track) => track.id)

    index.roots = nextRoots
    index.tracks = index.tracks.filter((track) => track.libraryRootId !== rootId)
    await this.writeIndex(index)

    await Promise.all(removedTrackIds.map((trackId) => this.deleteDraft(trackId)))
    return true
  }

  async markRootScanned(rootId: string, scannedAt = new Date().toISOString()): Promise<void> {
    const index = await this.readIndex()
    const root = index.roots.find((candidate) => candidate.id === rootId)
    if (!root) return
    root.lastScannedAt = scannedAt
    await this.writeIndex(index)
  }

  async upsertTracks(tracks: readonly TrackRecord[]): Promise<void> {
    if (tracks.length === 0) return
    const index = await this.readIndex()
    const trackMap = new Map(index.tracks.map((track) => [track.id, track]))
    for (const track of tracks) {
      trackMap.set(track.id, track)
    }
    index.tracks = [...trackMap.values()]
    await this.writeIndex(index)
  }

  async removeTracks(trackIds: readonly string[]): Promise<void> {
    if (trackIds.length === 0) return
    const index = await this.readIndex()
    const toRemove = new Set(trackIds)
    index.tracks = index.tracks.filter((track) => !toRemove.has(track.id))
    await this.writeIndex(index)
  }

  async readDraft(trackId: string): Promise<LyricDraft | null> {
    return readJson<LyricDraft>(this.draftPath(trackId))
  }

  async saveDraft(input: SaveDraftInput): Promise<LyricDraft> {
    if (typeof input.trackId !== 'string' || input.trackId.length === 0) {
      throw new Error('Draft requires a non-empty trackId')
    }
    if (typeof input.lyrics !== 'string') {
      throw new Error('Draft lyrics must be a string')
    }

    const draft: LyricDraft = {
      id: computeDraftId(input.trackId),
      trackId: input.trackId,
      lyrics: input.lyrics,
      updatedAt: new Date().toISOString(),
      status: input.status ?? 'pending'
    }

    await writeJson(this.draftPath(input.trackId), draft, this.options)

    // Best-effort: reflect the draft on the track record for the UI.
    const index = await this.readIndex()
    const track = index.tracks.find((candidate) => candidate.id === input.trackId)
    if (track && track.draftId !== draft.id) {
      track.draftId = draft.id
      await this.writeIndex(index)
    }

    return draft
  }

  async deleteDraft(trackId: string): Promise<boolean> {
    try {
      await fs.unlink(this.draftPath(trackId))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
  }

  /**
   * Removes orphaned `*.lrcembed.*.tmp.*` staging files from every registered
   * library root. Symlinks are never followed by `cleanupStaleTempFiles`.
   */
  async sweepRoots(roots?: readonly LibraryRoot[]): Promise<string[]> {
    const targets = roots ?? (await this.readIndex()).roots
    const sweep = this.options.sweepDirectory
      ?? ((dirPath: string) => cleanupStaleTempFiles(dirPath, { recursive: true }))

    const removed: string[] = []
    for (const root of targets) {
      try {
        removed.push(...(await sweep(root.path)))
      } catch (error) {
        console.warn(`[store] Temp sweep failed for root ${root.id} (${root.path}):`, error)
      }
    }
    return removed
  }

  /**
   * Creates the drafts directory and runs the startup temp sweep across all
   * authorized library roots.
   */
  async initialize(): Promise<string[]> {
    await fs.mkdir(this.draftsDir, { recursive: true })
    return this.sweepRoots()
  }
}

export function createStore(userDataDir: string, options: StoreOptions = {}): JsonStore {
  return new JsonStore(userDataDir, options)
}
