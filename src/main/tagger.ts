import fs from 'node:fs/promises'
import path from 'node:path'
import { TagLib, type AudioFile } from 'taglib-wasm'
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  type EmbedLyricsResult,
  type LyricsSource,
  type SupportedAudioExtension,
  type TrackMetadata
} from '@shared/ipc'
import { resolveTaglibWasmPath } from './wasmPath'

const LRCEMBED_TMP_FILE_PATTERN = /^.+\.lrcembed\.\d+\.tmp\.[^/\\]+$/
const LOCK_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface FileSwapOps {
  rename: (oldPath: string, newPath: string) => Promise<void>
  utimes: (filePath: string, atime: Date, mtime: Date) => Promise<void>
}

const DEFAULT_SWAP_OPS: FileSwapOps = {
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  utimes: (filePath, atime, mtime) => fs.utimes(filePath, atime, mtime)
}

export function isSupportedAudioPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
}

export function getAudioExtension(filePath: string): SupportedAudioExtension {
  const ext = path.extname(filePath).toLowerCase()
  if (!(SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`Unsupported audio file extension: ${ext || '(none)'}`)
  }
  return ext as SupportedAudioExtension
}

export function isLrcEmbedTempFile(fileName: string): boolean {
  return LRCEMBED_TMP_FILE_PATTERN.test(fileName)
}

/**
 * Builds a same-directory staging path `<basename>.lrcembed.<pid>.tmp.<ext>`
 * so atomic renames avoid cross-drive EXDEV errors and preserve TagLib extension detection.
 */
export function buildTempPath(targetPath: string, pid: number = process.pid): string {
  const dir = path.dirname(targetPath)
  const ext = path.extname(targetPath)
  const base = path.basename(targetPath, ext)
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`
  return path.join(dir, `${base}.lrcembed.${pid}.tmp${normalizedExt}`)
}

export function getSidecarLrcPath(trackPath: string): string {
  const dir = path.dirname(trackPath)
  const base = path.basename(trackPath, path.extname(trackPath))
  return path.join(dir, `${base}.lrc`)
}

function isLyricsPropertyKey(key: string): boolean {
  const upper = key.toUpperCase()
  return upper === 'LYRICS' || upper.startsWith('LYRICS:')
}

function isLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && LOCK_RETRY_CODES.has(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Executes a filesystem operation with bounded exponential backoff on transient
 * Windows file-lock errors (EBUSY, EPERM, EACCES).
 */
export async function retryOnLockError<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 25
  const maxDelayMs = options.maxDelayMs ?? 800

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isLockError(error) || attempt === maxAttempts) {
        throw error
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Deletes stale staging files matching `*.lrcembed.*.tmp.*` inside a directory,
 * leaving unrelated `.tmp` files untouched.
 */
export async function cleanupStaleTempFiles(
  dirPath: string,
  options: { recursive?: boolean } = {}
): Promise<string[]> {
  const removed: string[] = []
  let entries
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return removed
    }
    throw error
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)

    // Never follow symlinks: lstat identifies the link itself, so we skip it
    // rather than recursing into (or deleting through) an unexpected target.
    let stat
    try {
      stat = await fs.lstat(fullPath)
    } catch {
      continue
    }

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      if (options.recursive) {
        const nested = await cleanupStaleTempFiles(fullPath, options)
        removed.push(...nested)
      }
      continue
    }

    if (stat.isFile() && isLrcEmbedTempFile(entry.name)) {
      await fs.unlink(fullPath)
      removed.push(fullPath)
    }
  }

  return removed
}

function extractLyricsState(audioFile: AudioFile): {
  lyrics: string | null
  existingLyricsKeys: string[]
} {
  const existingKeys = new Set<string>()
  const primaryTexts = audioFile
    .getLyrics()
    .map((entry) => entry.text)
    .filter((text) => text.length > 0)

  if (primaryTexts.length > 0) {
    existingKeys.add('LYRICS')
  }

  const fallbackTexts: string[] = []
  const props = audioFile.properties()
  for (const [key, values] of Object.entries(props)) {
    if (!isLyricsPropertyKey(key) || !values) continue
    const nonEmpty = values.filter((v) => v.length > 0)
    if (nonEmpty.length > 0) {
      existingKeys.add(key)
      fallbackTexts.push(...nonEmpty)
    }
  }

  const resolvedTexts = primaryTexts.length > 0 ? primaryTexts : fallbackTexts
  return {
    lyrics: resolvedTexts.length > 0 ? resolvedTexts.join('\n') : null,
    existingLyricsKeys: [...existingKeys]
  }
}

function stripLyricsProperties(audioFile: AudioFile): void {
  const props = audioFile.properties()
  for (const key of Object.keys(props)) {
    if (isLyricsPropertyKey(key)) {
      audioFile.removeProperty(key)
    }
  }
  audioFile.removeProperty('LYRICS')
  audioFile.setLyrics([])
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

async function readSidecarIfExists(sidecarPath: string): Promise<string | null> {
  try {
    return await fs.readFile(sidecarPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export class AudioTagger {
  private readonly taglib: TagLib
  private readonly swapOps: FileSwapOps
  private readonly retryOptions: RetryOptions
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    taglib: TagLib,
    options: { swapOps?: FileSwapOps; retryOptions?: RetryOptions } = {}
  ) {
    this.taglib = taglib
    this.swapOps = options.swapOps ?? DEFAULT_SWAP_OPS
    this.retryOptions = options.retryOptions ?? {}
  }

  static async create(options: {
    wasmUrl?: string
    swapOps?: FileSwapOps
    retryOptions?: RetryOptions
  } = {}): Promise<AudioTagger> {
    const wasmUrl = options.wasmUrl ?? resolveTaglibWasmPath()
    const taglib = await TagLib.initialize({
      wasmUrl,
      forceWasmType: 'wasi'
    })
    return new AudioTagger(taglib, {
      swapOps: options.swapOps,
      retryOptions: options.retryOptions
    })
  }

  getVersion(): string {
    return this.taglib.version()
  }

  async readTrackMetadata(filePath: string): Promise<TrackMetadata> {
    const ext = getAudioExtension(filePath)
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`)
    }

    const audioFile = await this.taglib.open(filePath)
    try {
      if (!audioFile.isValid()) {
        throw new Error(`Invalid audio file: ${filePath}`)
      }
      const tag = audioFile.tag()
      const audioProps = audioFile.audioProperties()
      const { lyrics: tagLyrics, existingLyricsKeys } = extractLyricsState(audioFile)

      let lyrics: string | null = tagLyrics
      let lyricsSource: LyricsSource = tagLyrics !== null ? 'tag' : 'none'

      if (ext === '.wav') {
        const sidecarLyrics = await readSidecarIfExists(getSidecarLrcPath(filePath))
        if (sidecarLyrics !== null) {
          lyrics = sidecarLyrics
          lyricsSource = 'sidecar'
        } else {
          lyrics = null
          lyricsSource = 'none'
        }
      }

      return {
        filePath,
        format: audioFile.getFormat(),
        title: tag.title || path.basename(filePath, ext),
        artist: tag.artist || '',
        album: tag.album || '',
        durationSec: audioProps?.duration ?? 0,
        lyrics,
        lyricsSource,
        existingLyricsKeys
      }
    } finally {
      audioFile.dispose()
    }
  }

  embedLyrics(filePath: string, lyrics: string): Promise<EmbedLyricsResult> {
    return this.enqueueWrite(() => this.performEmbedLyrics(filePath, lyrics))
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async performEmbedLyrics(
    filePath: string,
    lyrics: string
  ): Promise<EmbedLyricsResult> {
    const ext = getAudioExtension(filePath)
    const origStat = await fs.stat(filePath)
    if (!origStat.isFile()) {
      throw new Error(`Target is not a file: ${filePath}`)
    }

    if (ext === '.wav') {
      return this.writeWavSidecar(filePath, lyrics, origStat.mtimeMs)
    }

    const tmpPath = buildTempPath(filePath)
    try {
      await fs.copyFile(filePath, tmpPath)

      const stagedFile = await this.taglib.open(tmpPath)
      try {
        if (!stagedFile.isValid()) {
          throw new Error(`Staged audio file failed validation: ${tmpPath}`)
        }
        stripLyricsProperties(stagedFile)
        if (lyrics.length > 0) {
          stagedFile.setProperty('LYRICS', lyrics)
        }
        await stagedFile.saveToFile()
      } finally {
        stagedFile.dispose()
      }

      const verifiedFile = await this.taglib.open(tmpPath)
      try {
        if (!verifiedFile.isValid() || !verifiedFile.audioProperties()) {
          throw new Error(`Verification failed after saving staged file: ${tmpPath}`)
        }
        const { lyrics: readBack, existingLyricsKeys } = extractLyricsState(verifiedFile)
        const residualCustomKey = existingLyricsKeys.find(
          (key) => key.toUpperCase() !== 'LYRICS'
        )
        if (residualCustomKey) {
          throw new Error(
            `Verification failed: residual lyrics key ${residualCustomKey} was not stripped`
          )
        }
        const expected = lyrics.length > 0 ? lyrics : null
        if (readBack !== expected) {
          throw new Error('Verification failed: written lyrics do not match target payload')
        }
      } finally {
        verifiedFile.dispose()
      }

      await retryOnLockError(
        () => this.swapOps.rename(tmpPath, filePath),
        this.retryOptions
      )
      await retryOnLockError(
        () => this.swapOps.utimes(filePath, origStat.atime, origStat.mtime),
        this.retryOptions
      )

      return {
        filePath,
        targetPath: filePath,
        lyricsSource: 'tag',
        preservedMtimeMs: origStat.mtimeMs,
        verified: true
      }
    } finally {
      await safeUnlink(tmpPath)
    }
  }

  private async writeWavSidecar(
    wavPath: string,
    lyrics: string,
    wavMtimeMs: number
  ): Promise<EmbedLyricsResult> {
    const sidecarPath = getSidecarLrcPath(wavPath)

    // If lyrics is empty, remove the sidecar file if it exists
    if (lyrics.length === 0) {
      await safeUnlink(sidecarPath)
      return {
        filePath: wavPath,
        targetPath: sidecarPath,
        lyricsSource: 'sidecar',
        preservedMtimeMs: wavMtimeMs,
        verified: true
      }
    }

    const tmpPath = buildTempPath(sidecarPath)

    try {
      await fs.writeFile(tmpPath, lyrics, 'utf8')
      const verified = await fs.readFile(tmpPath, 'utf8')
      if (verified !== lyrics) {
        throw new Error(`Verification failed for WAV sidecar: ${sidecarPath}`)
      }
      await retryOnLockError(
        () => this.swapOps.rename(tmpPath, sidecarPath),
        this.retryOptions
      )
      return {
        filePath: wavPath,
        targetPath: sidecarPath,
        lyricsSource: 'sidecar',
        preservedMtimeMs: wavMtimeMs,
        verified: true
      }
    } finally {
      await safeUnlink(tmpPath)
    }
  }
}
