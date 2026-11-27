import { Loader2, Sparkles } from 'lucide-react'

interface AiLayerButtonProps {
  mode: 'translation' | 'romanization'
  label: string
  aiJob: { mode: 'translation' | 'romanization'; jobId: string } | null
  disabled: boolean
  aiConfigured: boolean
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  onAiCancel: () => void
  className: string
}

export function AiLayerButton({
  mode,
  label,
  aiJob,
  disabled,
  aiConfigured,
  onAiGenerate,
  onAiCancel,
  className
}: AiLayerButtonProps) {
  const running = aiJob?.mode === mode
  const otherRunning = aiJob !== null && !running

  if (running) {
    return (
      <button
        type="button"
        onClick={onAiCancel}
        title="Cancel the in-flight AI request"
        className={`${className} border-amber-700/80 bg-amber-950/60 text-amber-200 hover:bg-amber-900/60`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Cancel
      </button>
    )
  }

  return (
    <button
      type="button"
      disabled={disabled || otherRunning}
      onClick={() => onAiGenerate(mode)}
      title={
        aiConfigured
          ? `${label} with the configured AI provider (writes only the ${mode} layer)`
          : 'Configure an AI provider first (Settings…)'
      }
      className={`${className} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <Sparkles className="h-3 w-3" />
      {label}
    </button>
  )
}