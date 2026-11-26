import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Square, Volume2 } from 'lucide-react'
import type { TagEngineHealth, TrackRecord } from '@shared/ipc'
import { formatDuration } from '@shared/lyricsSync'
import type { PlayerCommand, SeekRequest } from '../types'

export interface AudioPreviewPlayerProps {
  focusedTrack: TrackRecord | null
  /** Every active line sharing the current timestamp, stacked top-to-bottom. */
  activeLineTexts: string[]
  seekRequest: SeekRequest | null
  /** One-shot command from the native Playback menu. */
  playerCommand: PlayerCommand | null
  /** TagLib / WASI worker health, rendered as a quiet status dot. */
  health?: TagEngineHealth | null
  onPlaybackChange: (loadedTrackId: string | null, timeMs: number, isPlaying: boolean) => void
  onPlayerError: (message: string) => void
}

function normalizePathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

export function AudioPreviewPlayer({
  focusedTrack,
  activeLineTexts,
  seekRequest,
  playerCommand,
  health = null,
  onPlaybackChange,
  onPlayerError
}: AudioPreviewPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const loadedMediaRef = useRef<{ trackId: string; filePath: string } | null>(null)
  const loadNonceRef = useRef(0)
  const pendingSeekSecRef = useRef<number | null>(null)

  const [loadedTrackId, setLoadedTrackId] = useState<string | null>(null)
  const [loadedTitle, setLoadedTitle] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTimeSec, setCurrentTimeSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)

  const onPlaybackChangeRef = useRef(onPlaybackChange)
  onPlaybackChangeRef.current = onPlaybackChange

  const onPlayerErrorRef = useRef(onPlayerError)
  onPlayerErrorRef.current = onPlayerError

  const togglePlayRef = useRef<() => void>(() => undefined)
  const stopUnloadRef = useRef<() => void>(() => undefined)
  const handledCommandNonceRef = useRef<number | null>(null)

  const stopAndUnload = useCallback(() => {
    loadNonceRef.current += 1
    pendingSeekSecRef.current = null
    const audioEl = audioRef.current
    if (audioEl) {
      audioEl.pause()
      audioEl.removeAttribute('src')
      audioEl.load()
    }
    loadedMediaRef.current = null
    setLoadedTrackId(null)
    setLoadedTitle(null)
    setIsPlaying(false)
    setCurrentTimeSec(0)
    setDurationSec(0)
    onPlaybackChangeRef.current(null, 0, false)
  }, [])

  // Strict ref-backed synchronous unload handler: executes pause/removeAttribute/load
  // before preload sends acknowledgeUnload back to main.
  useEffect(() => {
    return window.api.onUnloadAudio((request) => {
      loadNonceRef.current += 1
      pendingSeekSecRef.current = null
      const audioEl = audioRef.current
      const loaded = loadedMediaRef.current
      const matchesPath =
        loaded !== null &&
        normalizePathForCompare(loaded.filePath) === normalizePathForCompare(request.filePath)
      const hasActivePlayback =
        audioEl !== null && (audioEl.hasAttribute('src') || !audioEl.paused || loaded !== null)

      if (audioEl && (matchesPath || hasActivePlayback)) {
        audioEl.pause()
        audioEl.removeAttribute('src')
        audioEl.load()
        loadedMediaRef.current = null
        setLoadedTrackId(null)
        setLoadedTitle(null)
        setIsPlaying(false)
        setCurrentTimeSec(0)
        setDurationSec(0)
        onPlaybackChangeRef.current(null, 0, false)
      }
    })
  }, [])

  const loadAndPlayTrack = useCallback(
    async (track: TrackRecord, seekToSec?: number) => {
      const audioEl = audioRef.current
      if (!audioEl) return

      const nonce = ++loadNonceRef.current
      try {
        const media = await window.api.getMediaUrl(track.id)
        if (loadNonceRef.current !== nonce) {
          return
        }

        const currentEl = audioRef.current
        if (!currentEl) return

        loadedMediaRef.current = { trackId: track.id, filePath: track.filePath }
        setLoadedTrackId(track.id)
        setLoadedTitle(`${track.title}${track.artist ? ` — ${track.artist}` : ''}`)
        setDurationSec(track.durationSec)

        pendingSeekSecRef.current = seekToSec ?? null
        currentEl.src = media.url
        currentEl.load()
        if (seekToSec !== undefined && currentEl.readyState >= 1) {
          currentEl.currentTime = seekToSec
          pendingSeekSecRef.current = null
          setCurrentTimeSec(seekToSec)
          onPlaybackChangeRef.current(track.id, seekToSec * 1000, true)
        }
        await currentEl.play()
      } catch (error) {
        if (loadNonceRef.current !== nonce) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        onPlayerErrorRef.current(`Audio preview failed: ${message}`)
      }
    },
    []
  )

  // Handle click-to-seek requests from lyric lines
  useEffect(() => {
    if (!seekRequest || !focusedTrack || seekRequest.trackId !== focusedTrack.id) {
      return
    }
    const targetSec = Math.max(0, seekRequest.timeMs / 1000)
    const audioEl = audioRef.current
    const loaded = loadedMediaRef.current

    if (audioEl && loaded && loaded.trackId === focusedTrack.id && audioEl.hasAttribute('src')) {
      if (audioEl.readyState >= 1) {
        audioEl.currentTime = targetSec
        setCurrentTimeSec(targetSec)
        onPlaybackChangeRef.current(focusedTrack.id, targetSec * 1000, !audioEl.paused)
      } else {
        pendingSeekSecRef.current = targetSec
      }
      if (audioEl.paused) {
        void audioEl.play().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          onPlayerErrorRef.current(`Audio playback failed: ${message}`)
        })
      }
      return
    }

    void loadAndPlayTrack(focusedTrack, targetSec)
  }, [seekRequest, focusedTrack, loadAndPlayTrack])

  // Smooth RAF timer while playing for active-line highlight
  useEffect(() => {
    if (!isPlaying || !loadedTrackId) return
    let rafId = 0
    const tick = () => {
      const audioEl = audioRef.current
      const loaded = loadedMediaRef.current
      if (audioEl && loaded) {
        const sec = audioEl.currentTime
        setCurrentTimeSec(sec)
        onPlaybackChangeRef.current(loaded.trackId, sec * 1000, !audioEl.paused)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, loadedTrackId])

  async function handleTogglePlay() {
    const audioEl = audioRef.current
    const loaded = loadedMediaRef.current

    if (
      audioEl &&
      loaded &&
      focusedTrack &&
      loaded.trackId === focusedTrack.id &&
      audioEl.hasAttribute('src')
    ) {
      if (audioEl.paused) {
        try {
          await audioEl.play()
        } catch (error) {
          onPlayerError(error instanceof Error ? error.message : String(error))
        }
      } else {
        audioEl.pause()
      }
      return
    }

    if (focusedTrack) {
      await loadAndPlayTrack(focusedTrack)
    } else if (audioEl && loaded && audioEl.hasAttribute('src')) {
      if (audioEl.paused) {
        await audioEl.play()
      } else {
        audioEl.pause()
      }
    }
  }

  togglePlayRef.current = () => {
    void handleTogglePlay()
  }
  stopUnloadRef.current = () => {
    stopAndUnload()
  }

  // Native menu playback commands are delivered as one-shot nonce-keyed values.
  useEffect(() => {
    if (!playerCommand) return
    if (handledCommandNonceRef.current === playerCommand.nonce) return
    handledCommandNonceRef.current = playerCommand.nonce
    if (playerCommand.kind === 'toggle') {
      togglePlayRef.current()
    } else {
      stopUnloadRef.current()
    }
  }, [playerCommand])

  function handleScrub(nextSeconds: number) {
    const audioEl = audioRef.current
    const loaded = loadedMediaRef.current
    if (!audioEl || !loaded || !audioEl.hasAttribute('src')) return
    audioEl.currentTime = nextSeconds
    setCurrentTimeSec(nextSeconds)
    onPlaybackChange(loaded.trackId, nextSeconds * 1000, !audioEl.paused)
  }

  const effectiveDuration =
    durationSec > 0 ? durationSec : (focusedTrack?.durationSec ?? 0)

  return (
    <footer className="flex h-[70px] shrink-0 items-center gap-3 border-t border-zinc-800 bg-zinc-900/95 px-4">
      <audio
        ref={audioRef}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const el = event.currentTarget
          if (Number.isFinite(el.duration) && el.duration > 0) {
            setDurationSec(el.duration)
          }
          if (pendingSeekSecRef.current !== null) {
            el.currentTime = pendingSeekSecRef.current
            setCurrentTimeSec(pendingSeekSecRef.current)
            pendingSeekSecRef.current = null
          }
        }}
        onTimeUpdate={(event) => {
          const el = event.currentTarget
          const loaded = loadedMediaRef.current
          setCurrentTimeSec(el.currentTime)
          if (loaded) {
            onPlaybackChange(loaded.trackId, el.currentTime * 1000, !el.paused)
          }
        }}
        onPlay={() => {
          const loaded = loadedMediaRef.current
          setIsPlaying(true)
          if (loaded && audioRef.current) {
            onPlaybackChange(loaded.trackId, audioRef.current.currentTime * 1000, true)
          }
        }}
        onPause={() => {
          const loaded = loadedMediaRef.current
          setIsPlaying(false)
          if (loaded && audioRef.current) {
            onPlaybackChange(loaded.trackId, audioRef.current.currentTime * 1000, false)
          }
        }}
        onEnded={() => {
          const loaded = loadedMediaRef.current
          setIsPlaying(false)
          if (loaded && audioRef.current) {
            onPlaybackChange(loaded.trackId, audioRef.current.currentTime * 1000, false)
          }
        }}
        onError={() => {
          // Ignore empty-src resets triggered by stopAndUnload / onUnloadAudio
          if (!loadedMediaRef.current) return
          setIsPlaying(false)
          onPlayerError('Failed to stream audio track over media://')
        }}
      />

      <div className="flex w-full flex-1 min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={isPlaying && loadedTrackId === focusedTrack?.id ? 'Pause' : 'Play'}
            title={
              isPlaying && loadedTrackId === focusedTrack?.id
                ? 'Pause the preview (keeps the media:// handle open)'
                : 'Play the focused track over media:// (seek first with a lyric line)'
            }
            disabled={!focusedTrack && !loadedTrackId}
            onClick={() => void handleTogglePlay()}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPlaying && (!focusedTrack || loadedTrackId === focusedTrack.id) ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4 ml-0.5" />
            )}
          </button>
          <button
            type="button"
            aria-label="Stop and unload audio"
            title="Stop and unload the preview to release the Windows file lock"
            disabled={!loadedTrackId}
            onClick={stopAndUnload}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="w-52 min-w-0 shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-100 truncate">
            <Volume2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span className="truncate">
              {loadedTitle ??
                (focusedTrack
                  ? `${focusedTrack.title}${focusedTrack.artist ? ` — ${focusedTrack.artist}` : ''}`
                  : 'Select a track to preview')}
            </span>
          </div>
          <div className="min-h-[18px] max-h-[48px] space-y-0.5 overflow-y-auto text-[11px] text-emerald-300/90">
            {activeLineTexts.length > 0 ? (
              activeLineTexts.map((text, index) => (
                <div key={`${index}-${text}`} className="truncate" title={text}>
                  {text}
                </div>
              ))
            ) : (
              <div className="truncate">
                {loadedTrackId ? 'Playing media:// stream' : 'Audio idle'}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-1 min-w-0 items-center gap-2">
          <span className="w-10 text-right font-mono text-[11px] tabular-nums text-zinc-400">
            {formatDuration(currentTimeSec)}
          </span>
          <input
            type="range"
            aria-label="Audio seek scrubber"
            title="Seek within the loaded media:// preview"
            min={0}
            max={Math.max(effectiveDuration, 1)}
            step={0.1}
            value={Math.min(currentTimeSec, Math.max(effectiveDuration, 1))}
            disabled={!loadedTrackId}
            onChange={(event) => handleScrub(Number.parseFloat(event.target.value))}
            className="h-1.5 min-w-0 w-full flex-1 cursor-pointer accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
            {formatDuration(effectiveDuration)}
          </span>
        </div>

        {/*
          Quiet TagLib / WASI engine indicator: green when the utility-process
          tag engine is ready, amber (with the error in the tooltip) otherwise.
        */}
        <span
          title={
            health?.ready
              ? `TagLib ${health.taglibVersion ?? 'ready'} (PID ${health.workerPid ?? '?'})`
              : (health?.error ?? 'Tag engine initializing')
          }
          className="flex shrink-0 items-center gap-1 text-[10px] text-zinc-500"
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${
              health?.ready ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
          />
          TagLib
        </span>
      </div>
    </footer>
  )
}
