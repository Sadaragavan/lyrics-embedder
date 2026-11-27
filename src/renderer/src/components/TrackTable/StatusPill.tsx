import type { LyricsFetchProgress } from '@shared/ipc'
import type { TrackEmbedStatus } from '../../types'

export interface StatusPillProps {
  fetchProgress: LyricsFetchProgress | undefined
  embedStatus: TrackEmbedStatus | undefined
}

function providerLabel(providerId: string | undefined): string {
  if (providerId === 'lrclib') return 'LRCLIB'
  if (providerId === 'localSidecar') return 'Local .lrc'
  return 'provider'
}

const pill = (label: string, title: string, className: string) => (
  <span
    title={title}
    className={`shrink-0 whitespace-nowrap rounded border px-1 py-0.5 text-[9px] font-medium leading-none ${className}`}
  >
    {label}
  </span>
)

export function StatusPill({ fetchProgress, embedStatus }: StatusPillProps) {
  if (embedStatus && embedStatus.phase !== 'idle') {
    if (embedStatus.phase === 'embedding') {
      return pill(
        'Embedding',
        'Embedding lyrics: unloading the media:// preview, staging, writing, verifying, and swapping the file.',
        'bg-blue-950/80 border-blue-800/80 text-blue-300'
      )
    }
    if (embedStatus.phase === 'verified') {
      return pill(
        'Embedded',
        `Verified embed target: ${embedStatus.targetPath ?? 'track tag'} (${embedStatus.lyricsSource === 'sidecar' ? '.lrc sidecar' : 'embedded tag'})`,
        'bg-emerald-950/80 border-emerald-800/80 text-emerald-300'
      )
    }
    return pill(
      'Embed Err',
      `Embed failed: ${embedStatus.error ?? 'unknown error'}`,
      'bg-red-950/80 border-red-800/80 text-red-300'
    )
  }

  if (fetchProgress && fetchProgress.phase !== 'idle') {
    if (fetchProgress.phase === 'fetching') {
      return pill(
        fetchProgress.providerId === 'lrclib' ? 'LRCLIB...' : 'Fetching',
        `Fetching lyrics from ${providerLabel(fetchProgress.providerId)}...`,
        'bg-sky-950/80 border-sky-800/80 text-sky-300'
      )
    }
    if (fetchProgress.phase === 'error') {
      return pill(
        'Fetch Err',
        `Fetch failed (${providerLabel(fetchProgress.providerId)}): ${fetchProgress.error ?? 'unknown error'}`,
        'bg-red-950/80 border-red-800/80 text-red-300'
      )
    }
    if (fetchProgress.phase === 'cancelled') {
      return pill(
        'Cancelled',
        `Fetch cancelled (${providerLabel(fetchProgress.providerId)})`,
        'bg-zinc-800 border-zinc-700 text-zinc-400'
      )
    }
    if (fetchProgress.phase === 'done') {
      return fetchProgress.candidate
        ? pill(
            'Fetched',
            `Fetched via ${providerLabel(fetchProgress.candidate.providerId)} · score ${fetchProgress.candidate.score}`,
            'bg-emerald-950/70 border-emerald-800/70 text-emerald-300'
          )
        : pill(
            'No Match',
            `No match from ${providerLabel(fetchProgress.providerId)}`,
            'bg-zinc-800 border-zinc-700 text-zinc-400'
          )
    }
  }

  return <span className="text-[9px] leading-none text-zinc-600">—</span>
}