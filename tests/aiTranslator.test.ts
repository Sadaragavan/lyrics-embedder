import { describe, expect, it } from 'vitest'
import {
  AI_REQUEST_TIMEOUT_MS,
  AiTranslator,
  type FetchFunction
} from '../src/main/providers/aiTranslator'
import { ProviderError } from '../src/main/providers/router'
import type { AiProviderSettingsPublic } from '../src/shared/types'

const LRC = '[00:01.00]First line\n[00:02.00]Second line'

function makeSettings(
  overrides: Partial<AiProviderSettingsPublic> = {}
): AiProviderSettingsPublic {
  return {
    preset: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    targetLanguage: 'Spanish',
    romanizationStyle: 'Romaji',
    hasApiKey: true,
    encryptionAvailable: true,
    ...overrides
  }
}

function completion(content: string, model = 'gpt-4o-mini'): Response {
  return new Response(
    JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function makeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): FetchFunction & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as FetchFunction & { calls: Array<{ url: string; init: RequestInit }> }
  fn.calls = calls
  return fn
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    trackId: 'a'.repeat(32),
    mode: 'translation' as const,
    lyrics: LRC,
    settings: makeSettings(),
    apiKey: 'sk-test',
    ...overrides
  }
}

describe('AiTranslator.generate', () => {
  it('POSTs to /chat/completions with a bearer token and parsed LRC back', async () => {
    const fetchFn = makeFetch(() =>
      completion('{"lines":[{"index":1,"text":"Primera"},{"index":2,"text":"Segunda"}]}')
    )
    const translator = new AiTranslator({ fetchFn })
    const outcome = await translator.generate(baseParams())

    expect(fetchFn.calls).toHaveLength(1)
    const call = fetchFn.calls[0]!
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(outcome.lyrics).toBe('[00:01.00]Primera\n[00:02.00]Segunda')
    expect(outcome.lineCount).toBe(2)
  })

  it('omits the Authorization header when no key is configured (local Ollama)', async () => {
    const fetchFn = makeFetch(() =>
      completion('{"lines":[{"index":1,"text":"A"},{"index":2,"text":"B"}]}')
    )
    const translator = new AiTranslator({ fetchFn })
    await translator.generate(
      baseParams({
        apiKey: null,
        settings: makeSettings({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1' })
      })
    )
    const headers = fetchFn.calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(fetchFn.calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('sends the configured model and non-streaming flag', async () => {
    const fetchFn = makeFetch(() =>
      completion('{"lines":[{"index":1,"text":"A"},{"index":2,"text":"B"}]}')
    )
    const translator = new AiTranslator({ fetchFn })
    await translator.generate(baseParams({ settings: makeSettings({ model: 'my-model' }) }))
    const body = JSON.parse(String(fetchFn.calls[0]!.init.body)) as Record<string, unknown>
    expect(body.model).toBe('my-model')
    expect(body.stream).toBe(false)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('rejects an unsafe base URL before any request is made', async () => {
    const fetchFn = makeFetch(() => completion('{}'))
    const translator = new AiTranslator({ fetchFn })
    await expect(
      translator.generate(
        baseParams({ settings: makeSettings({ baseUrl: 'http://evil.example.com/v1' }) })
      )
    ).rejects.toBeInstanceOf(ProviderError)
    expect(fetchFn.calls).toHaveLength(0)
  })

  it('rejects when there are no timed lines to translate', async () => {
    const fetchFn = makeFetch(() => completion('{}'))
    const translator = new AiTranslator({ fetchFn })
    await expect(
      translator.generate(baseParams({ lyrics: 'plain untimed words' }))
    ).rejects.toThrow(/No timed lyric lines/)
    expect(fetchFn.calls).toHaveLength(0)
  })

  it('maps 401 to a credential error mentioning Settings', async () => {
    const fetchFn = makeFetch(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }))
    const translator = new AiTranslator({ fetchFn })
    await expect(translator.generate(baseParams())).rejects.toThrow(/rejected the credentials/)
  })

  it('maps 429 to RATE_LIMITED', async () => {
    const fetchFn = makeFetch(() => new Response('{}', { status: 429 }))
    const translator = new AiTranslator({ fetchFn })
    await expect(translator.generate(baseParams())).rejects.toMatchObject({
      kind: 'RATE_LIMITED'
    })
  })

  it('surfaces the provider error message on 400', async () => {
    const fetchFn = makeFetch(
      () => new Response('{"error":{"message":"model not found"}}', { status: 400 })
    )
    const translator = new AiTranslator({ fetchFn })
    await expect(translator.generate(baseParams())).rejects.toThrow(/model not found/)
  })

  it('times out after the configured limit', async () => {
    const fetchFn: FetchFunction = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    const translator = new AiTranslator({ fetchFn, timeoutMs: 20 })
    await expect(translator.generate(baseParams())).rejects.toThrow(/timed out/)
  })

  it('reports cancellation when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchFn: FetchFunction = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    const translator = new AiTranslator({ fetchFn, timeoutMs: 5000 })
    const promise = translator.generate(baseParams({ signal: controller.signal }))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'ABORTED' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = makeFetch(() => completion('{}'))
    const translator = new AiTranslator({ fetchFn })
    await expect(
      translator.generate(baseParams({ signal: controller.signal }))
    ).rejects.toMatchObject({ kind: 'ABORTED' })
    expect(fetchFn.calls).toHaveLength(0)
  })

  it('rejects a completion with no choices', async () => {
    const fetchFn = makeFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    const translator = new AiTranslator({ fetchFn })
    await expect(translator.generate(baseParams())).rejects.toThrow(/empty completion/)
  })

  it('rejects invalid JSON from the provider', async () => {
    const fetchFn = makeFetch(() => new Response('not json', { status: 200 }))
    const translator = new AiTranslator({ fetchFn })
    await expect(translator.generate(baseParams())).rejects.toThrow(/invalid JSON/)
  })

  it('accepts array-shaped content parts', async () => {
    const fetchFn = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [{ type: 'text', text: '{"lines":[{"index":1,"text":"A"}]}' }]
                }
              }
            ]
          }),
          { status: 200 }
        )
    )
    const translator = new AiTranslator({ fetchFn })
    const outcome = await translator.generate(baseParams())
    expect(outcome.lyrics).toContain('[00:01.00]A')
  })

  it('serializes concurrent jobs at concurrency = 1', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchFn = makeFetch(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return completion('{"lines":[{"index":1,"text":"A"},{"index":2,"text":"B"}]}')
    })
    const translator = new AiTranslator({ fetchFn })
    await Promise.all([translator.generate(baseParams()), translator.generate(baseParams())])
    expect(maxInFlight).toBe(1)
  })

  it('exposes the documented 60 s default timeout', () => {
    expect(AI_REQUEST_TIMEOUT_MS).toBe(60_000)
  })
})
