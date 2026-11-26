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
import { computeTrackId, isValidTrackId, normalizePathKey } from './utils/trackId'

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
  /** Optional translation layer persisted with the primary lyrics. */
  translation?: string
  /** Optional romanization layer persisted with the primary lyrics. */
  romanization?: string
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
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(userDataDir: string, options: StoreOptions = {}) {
    this.userDataDir = path.resolve(userDataDir)
    this.draftsDir = path.join(this.userDataDir, 'drafts')
    this.indexPath = path.join(this.userDataDir, 'library-index.json')
    this.options = options
  }

  private draftPath(trackId: string): string {
    if (!isValidTrackId(trackId)) {
      throw new Error(`Invalid trackId format: ${trackId}`)
    }
    return path.join(this.draftsDir, `${computeDraftId(trackId)}.json`)
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async readIndex(): Promise<LibraryIndex> {
    const index = await readJson<LibraryIndex>(this.indexPath)
    if (!index || !Array.isArray(index.roots) || !Array.isArray(index.tracks)) {
      return { roots: [], tracks: [] }
    }
    return { roots: index.roots, tracks: index.tracks }
  }

  async writeIndex(index: LibraryIndex): Promise<void> {
    // Internal method - does not use queue since callers (addRoot, removeRoot, etc.)
    // already serialize via enqueueWrite
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
    return this.enqueueWrite(async () => {
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
    })
  }

  async removeRoot(rootId: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
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

      await Promise.all(removedTrackIds.map((trackId) => this._deleteDraftInternal(trackId)))
      return true
    })
  }

  async markRootScanned(rootId: string, scannedAt = new Date().toISOString()): Promise<void> {
    return this.enqueueWrite(async () => {
      const index = await this.readIndex()
      const root = index.roots.find((candidate) => candidate.id === rootId)
      if (!root) return
      root.lastScannedAt = scannedAt
      await this.writeIndex(index)
    })
  }

  async upsertTracks(tracks: readonly TrackRecord[]): Promise<void> {
    if (tracks.length === 0) return
    return this.enqueueWrite(async () => {
      const index = await this.readIndex()
      const trackMap = new Map(index.tracks.map((track) => [track.id, track]))
      for (const track of tracks) {
        const existing = trackMap.get(track.id)
        // Preserve existing draftId if the incoming track doesn't have one
        const mergedTrack = existing?.draftId && !track.draftId
          ? { ...track, draftId: existing.draftId }
          : track
        trackMap.set(track.id, mergedTrack)
      }
      index.tracks = [...trackMap.values()]
      await this.writeIndex(index)
    })
  }

  async removeTracks(trackIds: readonly string[]): Promise<void> {
    if (trackIds.length === 0) return
    return this.enqueueWrite(async () => {
      const index = await this.readIndex()
      const toRemove = new Set(trackIds)
      index.tracks = index.tracks.filter((track) => !toRemove.has(track.id))
      await this.writeIndex(index)
    })
  }

  async readDraft(trackId: string): Promise<LyricDraft | null> {
    if (!isValidTrackId(trackId)) {
      throw new Error(`Invalid trackId format: ${trackId}`)
    }
    const draft = await readJson<LyricDraft>(this.draftPath(trackId))
    if (!draft) return null
    // Backwards compatibility: drafts written before multi-layer support have no
    // translation/romanization keys; normalize them to absent optional fields.
    return {
      ...draft,
      translation: typeof draft.translation === 'string' ? draft.translation : undefined,
      romanization: typeof draft.romanization === 'string' ? draft.romanization : undefined
    }
  }

  async saveDraft(input: SaveDraftInput): Promise<LyricDraft> {
    if (typeof input.trackId !== 'string' || input.trackId.length === 0) {
      throw new Error('Draft requires a non-empty trackId')
    }
    if (!isValidTrackId(input.trackId)) {
      throw new Error(`Invalid trackId format: ${input.trackId}`)
    }
    if (typeof input.lyrics !== 'string') {
      throw new Error('Draft lyrics must be a string')
    }
    // Whitespace-only layers carry no content; drop them so old drafts stay
    // compact and the renderer's "layer present" checks stay meaningful.
    const translation =
      typeof input.translation === 'string' && input.translation.trim().length > 0
        ? input.translation
        : undefined
    const romanization =
      typeof input.romanization === 'string' && input.romanization.trim().length > 0
        ? input.romanization
        : undefined

    return this.enqueueWrite(async () => {
      const draft: LyricDraft = {
        id: computeDraftId(input.trackId),
        trackId: input.trackId,
        lyrics: input.lyrics,
        ...(translation === undefined ? {} : { translation }),
        ...(romanization === undefined ? {} : { romanization }),
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
    })
  }

  async deleteDraft(trackId: string): Promise<boolean> {
    if (!isValidTrackId(trackId)) {
      throw new Error(`Invalid trackId format: ${trackId}`)
    }
    return this.enqueueWrite(() => this._deleteDraftInternal(trackId))
  }

  /**
   * Internal deleteDraft without queue - for use within already-queued operations.
   */
  async _deleteDraftInternal(trackId: string): Promise<boolean> {
    try {
      await fs.unlink(this.draftPath(trackId))
      // Clear draftId from the track record
      const index = await this.readIndex()
      const track = index.tracks.find((candidate) => candidate.id === trackId)
      if (track && track.draftId) {
        track.draftId = undefined
        await this.writeIndex(index)
      }
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
   * Creates the drafts directory, purges orphaned *.tmp files inside userData,
   * and runs the startup temp sweep across all authorized library roots.
   */
  async initialize(): Promise<string[]> {
    await fs.mkdir(this.draftsDir, { recursive: true })

    // Clean up orphaned *.tmp files in userData (drafts directory)
    const userDataRemoved = await cleanupStaleTempFiles(this.userDataDir, { recursive: true })
    if (userDataRemoved.length > 0) {
      console.log(`[store] removed ${userDataRemoved.length} orphaned staging file(s) from userData`)
    }

    const rootRemoved = await this.sweepRoots()
    return [...userDataRemoved, ...rootRemoved]
  }
}

export function createStore(userDataDir: string, options: StoreOptions = {}): JsonStore {
  return new JsonStore(userDataDir, options)
}
