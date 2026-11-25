import { useEffect, useState } from 'react'
import { CheckCircle2, FileAudio, RefreshCw, Save, TerminalSquare, AlertCircle } from 'lucide-react'
import type { EmbedLyricsResult, TagEngineHealth, TrackMetadata } from '@shared/ipc'

export function App() {
  const [health, setHealth] = useState<TagEngineHealth | null>(null)
  const [track, setTrack] = useState<TrackMetadata | null>(null)
  const [draftLyrics, setDraftLyrics] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refreshHealth() {
    setErrorMessage(null)
    try {
      const result = await window.api.getHealth()
      setHealth(result)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    void refreshHealth()
  }, [])

  async function handleSelectFile() {
    setErrorMessage(null)
    setStatusMessage(null)
    try {
      const filePath = await window.api.selectAudioFile()
      if (!filePath) return
      setBusy(true)
      const metadata = await window.api.readTrackMetadata(filePath)
      setTrack(metadata)
      setDraftLyrics(metadata.lyrics ?? '')
      setStatusMessage(`Loaded ${metadata.format} metadata (${metadata.lyricsSource})`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleEmbed() {
    if (!track) return
    setBusy(true)
    setErrorMessage(null)
    setStatusMessage(null)
    try {
      const result: EmbedLyricsResult = await window.api.embedLyrics({
        filePath: track.filePath,
        lyrics: draftLyrics
      })
      const reloaded = await window.api.readTrackMetadata(track.filePath)
      setTrack(reloaded)
      setDraftLyrics(reloaded.lyrics ?? '')
      setStatusMessage(
        `Verified ${result.lyricsSource} write to ${result.targetPath}`
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
              Poweramp LRC Embedder
            </h1>
            <p className="text-sm text-zinc-400">
              Phase 1 WASI Tag Engine &amp; Isolated Utility Worker Shell
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshHealth()}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
            >
              <RefreshCw className="h-4 w-4" />
              Check Worker
            </button>
            <button
              type="button"
              onClick={() => void handleSelectFile()}
              disabled={busy || !health?.ready}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileAudio className="h-4 w-4" />
              Inspect Audio File
            </button>
          </div>
        </header>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <TerminalSquare className="h-4 w-4 text-emerald-400" />
            UtilityProcess &amp; WASI Status
          </div>
          {health ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg bg-zinc-950/70 p-3">
                <dt className="text-xs uppercase tracking-wider text-zinc-500">Status</dt>
                <dd className="mt-1 flex items-center gap-1.5 font-mono text-zinc-100">
                  {health.ready ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      <span>Ready (PID {health.workerPid ?? 'unknown'})</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                      <span>{health.error ?? 'Not ready'}</span>
                    </>
                  )}
                </dd>
              </div>
              <div className="rounded-lg bg-zinc-950/70 p-3">
                <dt className="text-xs uppercase tracking-wider text-zinc-500">TagLib Version</dt>
                <dd className="mt-1 font-mono text-zinc-100">
                  {health.taglibVersion ?? 'Unavailable'}
                </dd>
              </div>
              <div className="rounded-lg bg-zinc-950/70 p-3 sm:col-span-2">
                <dt className="text-xs uppercase tracking-wider text-zinc-500">WASM Path</dt>
                <dd className="mt-1 break-all font-mono text-xs text-zinc-300">
                  {health.wasmPath ?? 'Unresolved'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-zinc-400">Querying worker health...</p>
          )}
        </section>

        {errorMessage && (
          <div className="flex items-start gap-2 rounded-lg border border-red-900/80 bg-red-950/50 p-3 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <span>{errorMessage}</span>
          </div>
        )}

        {statusMessage && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-900/80 bg-emerald-950/40 p-3 text-sm text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span className="break-all">{statusMessage}</span>
          </div>
        )}

        {track && (
          <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-100">{track.title}</h2>
                <p className="text-sm text-zinc-400">
                  {[track.artist, track.album].filter(Boolean).join(' — ') || 'Unknown Artist'}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-zinc-500">
                  {track.filePath} · {track.format} · {track.durationSec}s · source:{' '}
                  {track.lyricsSource}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleEmbed()}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Embed Lyrics
              </button>
            </div>

            <div>
              <label
                htmlFor="lyrics-editor"
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400"
              >
                Lyrics Payload
              </label>
              <textarea
                id="lyrics-editor"
                value={draftLyrics}
                onChange={(event) => setDraftLyrics(event.target.value)}
                rows={10}
                placeholder="[00:00.00] Paste or edit synced LRC lines..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
