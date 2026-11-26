/**
 * OpenAI-compatible chat translator for the opt-in AI translation /
 * romanization layers.
 *
 * Invariants: `concurrency = 1` (one in-flight request per provider instance),
 * per-track `AbortController` cancellation, a 60 s request timeout, and an
 * `Authorization: Bearer` header only when an API key is configured (so a local
 * Ollama server works without one). Failures surface as typed `ProviderError`s.
 *
 * Timestamps are never trusted from the model: the response is mapped back onto
 * the original `[mm:ss.xx]` stamps by `@shared/aiTranslate`.
 */

import {
  buildAiLyricsMessages,
  buildChatCompletionsUrl,
  extractTranslatableLines,
  parseAiResponseAndRebuildLrc,
  validateAiBaseUrl,
  type ChatMessage
} from '@shared/aiTranslate'
import type { AiGenerateMode, AiProviderSettingsPublic } from '@shared/types'
import { classifyProviderError, ProviderError } from './router'

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>

/** Hard cap for one generation request (ms). */
export const AI_REQUEST_TIMEOUT_MS = 60_000

const PROVIDER_ID = 'ai' as const

export interface AiTranslatorOptions {
  fetchFn?: FetchFunction
  /** Overrides `AI_REQUEST_TIMEOUT_MS` (tests use a short timeout). */
  timeoutMs?: number
}

export interface AiGenerateParams {
  jobId: string
  trackId: string
  mode: AiGenerateMode
  /** Primary LRC whose `[mm:ss.xx]` stamps are preserved verbatim. */
  lyrics: string
  settings: AiProviderSettingsPublic
  apiKey: string | null
  signal?: AbortSignal
  /** Overrides the configured source-language hint. */
  sourceLanguage?: string
  preserveWordTags?: boolean
}

export interface AiGenerateOutcome {
  lyrics: string
  lineCount: number
  model?: string
}

interface ChatCompletionResponse {
  model?: unknown
  choices?: unknown
}

function readFirstMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as ChatCompletionResponse
  if (!Array.isArray(body.choices) || body.choices.length === 0) return null
  const first = body.choices[0]
  if (!first || typeof first !== 'object') return null
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object') return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  // Some providers return an array of content parts.
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.length > 0 ? parts.join('') : null
  }
  return null
}

/**
 * OpenAI-compatible chat client with a single-flight queue.
 *
 * `generate()` throws `ProviderError` with a normalized kind so the renderer can
 * show a useful message (bad URL, 401, rate limit, timeout, bad JSON).
 */
export class AiTranslator {
  private readonly fetchFn: FetchFunction
  private readonly timeoutMs: number
  private requestQueue: Promise<void> = Promise.resolve()

  constructor(options: AiTranslatorOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.requestQueue.then(task, task)
    this.requestQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Runs one generation job at `concurrency = 1`. */
  generate(params: AiGenerateParams): Promise<AiGenerateOutcome> {
    return this.enqueue(() => this.performGenerate(params))
  }

  private async performGenerate(params: AiGenerateParams): Promise<AiGenerateOutcome> {
    const { mode, settings, apiKey, signal } = params

    if (signal?.aborted) {
      throw new ProviderError('ABORTED', 'AI generation aborted', { providerId: PROVIDER_ID })
    }

    const baseUrlCheck = validateAiBaseUrl(settings.baseUrl)
    if (!baseUrlCheck.ok) {
      throw new ProviderError('BAD_RESPONSE', baseUrlCheck.error, { providerId: PROVIDER_ID })
    }
    if (settings.model.trim().length === 0) {
      throw new ProviderError('BAD_RESPONSE', 'No AI model configured', {
        providerId: PROVIDER_ID
      })
    }

    const entries = extractTranslatableLines(params.lyrics, {
      preserveWordTags: params.preserveWordTags
    })
    if (entries.length === 0) {
      throw new ProviderError(
        'BAD_RESPONSE',
        'No timed lyric lines to process (the primary LRC has no [mm:ss.xx] lines)',
        { providerId: PROVIDER_ID }
      )
    }

    const messages = buildAiLyricsMessages(entries, mode, {
      targetLanguage: settings.targetLanguage,
      romanizationStyle: settings.romanizationStyle,
      ...(params.sourceLanguage ? { sourceLanguage: params.sourceLanguage } : {})
    })

    const content = await this.requestCompletion({
      url: buildChatCompletionsUrl(baseUrlCheck.url),
      model: settings.model,
      messages,
      apiKey,
      signal
    })

    const parsed = parseAiResponseAndRebuildLrc(content, entries, {
      preserveWordTags: params.preserveWordTags ?? false
    })
    if (!parsed.ok) {
      throw new ProviderError('BAD_RESPONSE', parsed.error, { providerId: PROVIDER_ID })
    }

    return { lyrics: parsed.lyrics, lineCount: parsed.lineCount }
  }

  private async requestCompletion(input: {
    url: string
    model: string
    messages: ChatMessage[]
    apiKey: string | null
    signal?: AbortSignal
  }): Promise<string> {
    // Compose the caller's abort signal with our own timeout signal.
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs)
    const onExternalAbort = (): void => timeoutController.abort()
    input.signal?.addEventListener('abort', onExternalAbort, { once: true })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
    // Only send credentials when a key exists; local Ollama expects none.
    if (input.apiKey && input.apiKey.length > 0) {
      headers.Authorization = `Bearer ${input.apiKey}`
    }

    let response: Response
    try {
      response = await this.fetchFn(input.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: 0.2,
          stream: false
        }),
        signal: timeoutController.signal
      })
    } catch (error) {
      if (input.signal?.aborted) {
        throw new ProviderError('ABORTED', 'AI generation cancelled', {
          providerId: PROVIDER_ID,
          cause: error
        })
      }
      if (timeoutController.signal.aborted) {
        throw new ProviderError(
          'NETWORK',
          `AI request timed out after ${Math.round(this.timeoutMs / 1000)}s`,
          { providerId: PROVIDER_ID, cause: error }
        )
      }
      const classified = classifyProviderError(error, PROVIDER_ID)
      throw new ProviderError(
        classified.kind === 'ABORTED' ? 'ABORTED' : 'NETWORK',
        classified.message,
        { providerId: PROVIDER_ID, cause: error }
      )
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onExternalAbort)
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        'BAD_RESPONSE',
        `AI provider rejected the credentials (HTTP ${response.status}). Check the API key in Settings.`,
        { providerId: PROVIDER_ID }
      )
    }
    if (response.status === 429) {
      throw new ProviderError('RATE_LIMITED', 'AI provider rate-limited the request (HTTP 429)', {
        providerId: PROVIDER_ID
      })
    }
    if (!response.ok) {
      const detail = await this.readErrorDetail(response)
      throw new ProviderError(
        response.status >= 500 ? 'NETWORK' : 'BAD_RESPONSE',
        `AI provider request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        { providerId: PROVIDER_ID }
      )
    }

    let payload: unknown
    try {
      payload = (await response.json()) as unknown
    } catch (error) {
      throw new ProviderError('BAD_RESPONSE', 'AI provider returned invalid JSON', {
        providerId: PROVIDER_ID,
        cause: error
      })
    }

    const content = readFirstMessageContent(payload)
    if (content === null || content.trim().length === 0) {
      throw new ProviderError('BAD_RESPONSE', 'AI provider returned an empty completion', {
        providerId: PROVIDER_ID
      })
    }
    return content
  }

  /** Best-effort extraction of a provider error message for the UI. */
  private async readErrorDetail(response: Response): Promise<string | null> {
    try {
      const text = await response.text()
      if (text.length === 0) return null
      try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object') {
          const error = (parsed as Record<string, unknown>).error
          if (typeof error === 'string') return error.slice(0, 200)
          if (error && typeof error === 'object') {
            const message = (error as Record<string, unknown>).message
            if (typeof message === 'string') return message.slice(0, 200)
          }
        }
      } catch {
        // Fall through to the raw body.
      }
      return text.trim().slice(0, 200)
    } catch {
      return null
    }
  }
}

export function createAiTranslator(options: AiTranslatorOptions = {}): AiTranslator {
  return new AiTranslator(options)
}
