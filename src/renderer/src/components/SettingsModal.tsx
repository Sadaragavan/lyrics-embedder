import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ExternalLink, KeyRound, Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { validateAiBaseUrl } from '@shared/aiTranslate'
import type { AiProviderPreset, AiProviderSettingsPublic } from '@shared/ipc'

/**
 * Presets for OpenAI-compatible chat endpoints. Every entry uses the same
 * `/chat/completions` contract; only the base URL and default model differ.
 */
export const AI_PRESETS: ReadonlyArray<{
  id: AiProviderPreset
  label: string
  description: string
  baseUrl: string
  model: string
  needsKey: boolean
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'api.openai.com',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true
  },
  {
    id: 'gemini',
    label: 'Gemini (OpenAI-compat)',
    description: 'generativelanguage.googleapis.com',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    needsKey: true
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'openrouter.ai/api/v1',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    needsKey: true
  },
  {
    id: 'ollama',
    label: 'Local Ollama',
    description: 'localhost:11434 (no key)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    needsKey: false
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Any OpenAI-compatible server',
    baseUrl: '',
    model: '',
    needsKey: false
  }
]

export interface SettingsModalProps {
  open: boolean
  settings: AiProviderSettingsPublic | null
  onClose: () => void
  /** Persists settings; `apiKey` is only set when the user typed a new one. */
  onSave: (input: {
    preset: AiProviderPreset
    baseUrl: string
    model: string
    targetLanguage: string
    romanizationStyle: string
    apiKey?: string
  }) => Promise<void>
  onClearKey: () => Promise<void>
}

/**
 * AI provider settings dialog.
 *
 * The API key is write-only from the renderer's perspective: it is never
 * prefilled, and only an `hasApiKey` badge is shown. Saving without touching the
 * key field preserves the stored secret.
 */
export function SettingsModal({
  open,
  settings,
  onClose,
  onSave,
  onClearKey
}: SettingsModalProps): React.JSX.Element | null {
  const [preset, setPreset] = useState<AiProviderPreset>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [targetLanguage, setTargetLanguage] = useState('English')
  const [romanizationStyle, setRomanizationStyle] = useState('Hepburn-style Romaji')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const keyInputRef = useRef<HTMLInputElement | null>(null)

  // Hydrate the form each time the dialog opens.
  useEffect(() => {
    if (!open || !settings) return
    setPreset(settings.preset)
    setBaseUrl(settings.baseUrl)
    setModel(settings.model)
    setTargetLanguage(settings.targetLanguage)
    setRomanizationStyle(settings.romanizationStyle)
    setApiKey('')
    setError(null)
    setSavedAt(null)
  }, [open, settings])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const urlCheck = useMemo(() => validateAiBaseUrl(baseUrl), [baseUrl])
  const activePreset = AI_PRESETS.find((entry) => entry.id === preset) ?? AI_PRESETS[0]!

  if (!open) return null

  function applyPreset(id: AiProviderPreset): void {
    setPreset(id)
    const definition = AI_PRESETS.find((entry) => entry.id === id)
    if (!definition) return
    if (definition.baseUrl) setBaseUrl(definition.baseUrl)
    if (definition.model) setModel(definition.model)
    setError(null)
  }

  async function handleSave(): Promise<void> {
    if (!urlCheck.ok) {
      setError(urlCheck.error)
      return
    }
    if (model.trim().length === 0) {
      setError('Model is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave({
        preset,
        baseUrl,
        model: model.trim(),
        targetLanguage: targetLanguage.trim(),
        romanizationStyle: romanizationStyle.trim(),
        // Only send the key when the user typed one, so an untouched field
        // never wipes the stored secret.
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {})
      })
      setApiKey('')
      setSavedAt(Date.now())
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  async function handleClearKey(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await onClearKey()
      setApiKey('')
      setSavedAt(Date.now())
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex max-h-[90vh] w-[min(560px,95vw)] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <div>
            <h2 id="settings-title" className="text-sm font-semibold text-zinc-100">
              AI Translation Settings
            </h2>
            <p className="text-[11px] text-zinc-500">
              Opt-in OpenAI-compatible provider. Layered on top of the primary LRC; timestamps are
              always taken from your lyrics.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings (Esc)"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {/* Presets */}
          <div>
            <span className="mb-1 block text-[11px] font-medium text-zinc-400">Provider preset</span>
            <div className="grid grid-cols-2 gap-1">
              {AI_PRESETS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={preset === entry.id}
                  onClick={() => applyPreset(entry.id)}
                  title={`${entry.label} — ${entry.description}`}
                  className={`rounded border px-2 py-1.5 text-left text-[11px] ${
                    preset === entry.id
                      ? 'border-emerald-700 bg-emerald-950/60 text-emerald-100'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  <span className="block truncate font-medium">{entry.label}</span>
                  <span className="block truncate text-[10px] text-zinc-500">
                    {entry.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Base URL */}
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-zinc-400">Base URL</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              title="OpenAI-compatible base URL. HTTPS is required except for localhost."
              className={`w-full rounded border bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none ${
                baseUrl.length === 0 || urlCheck.ok
                  ? 'border-zinc-700 focus:border-emerald-500'
                  : 'border-red-600'
              }`}
            />
            {!urlCheck.ok && baseUrl.length > 0 && (
              <span className="mt-0.5 block text-[10px] text-red-400">{urlCheck.error}</span>
            )}
          </label>

          {/* API key */}
          <div>
            <span className="mb-1 flex items-center justify-between text-[11px] font-medium text-zinc-400">
              <span>API Key</span>
              {settings?.hasApiKey ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                  <ShieldCheck className="h-3 w-3" />
                  Saved securely
                </span>
              ) : (
                <span className="text-[10px] text-zinc-500">
                  {activePreset.needsKey ? 'Not set' : 'Not required for local servers'}
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <input
                ref={keyInputRef}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={settings?.hasApiKey ? '•••••••• (leave blank to keep)' : 'sk-…'}
                autoComplete="off"
                spellCheck={false}
                title="Stored encrypted with the OS secret store. Leave blank to keep the saved key."
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleClearKey()}
                disabled={busy || !settings?.hasApiKey}
                title="Delete the stored API key"
                className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear Key
              </button>
            </div>
            {settings && !settings.encryptionAvailable && (
              <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-400/90">
                <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                OS secure storage is unavailable, so an API key cannot be saved. Local Ollama still
                works without one.
              </p>
            )}
          </div>

          {/* Model */}
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-zinc-400">Model</span>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={activePreset.model || 'model-name'}
              spellCheck={false}
              title="Model identifier passed to /chat/completions"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-zinc-400">
                Target Language
              </span>
              <input
                type="text"
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.target.value)}
                placeholder="English"
                title="Language the AI Translate action writes into the translation layer"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-zinc-400">
                Romanization Style
              </span>
              <input
                type="text"
                value={romanizationStyle}
                onChange={(event) => setRomanizationStyle(event.target.value)}
                placeholder="Hepburn-style Romaji"
                title="Style requested by the AI Romanize action"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
            </label>
          </div>

          <p className="flex items-start gap-1 text-[10px] leading-snug text-zinc-500">
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
            Only the unique lyric lines are sent to the provider, never file paths or audio. Results
            are re-timestamped locally.
          </p>

          {error && (
            <p role="alert" className="rounded border border-red-900/80 bg-red-950/60 px-2 py-1 text-[11px] text-red-200">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-800 px-4 py-2">
          <span className="flex items-center gap-1 text-[10px] text-emerald-400">
            {savedAt !== null && (
              <>
                <Check className="h-3 w-3" />
                Settings saved
              </>
            )}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy}
              title="Persist these AI settings (the API key is encrypted with the OS secret store)"
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
