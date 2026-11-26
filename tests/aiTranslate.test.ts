import { describe, expect, it } from 'vitest'
import {
  buildAiLyricsMessages,
  buildChatCompletionsUrl,
  extractJsonObject,
  extractTranslatableLines,
  parseAiResponseAndRebuildLrc,
  stripMarkdownFence,
  utf8ByteLength,
  validateAiBaseUrl
} from '../src/shared/aiTranslate'

const LRC = [
  '[ar:Some Artist]',
  '[00:01.00]First line',
  '[00:02.50]First line',
  '[00:03.00]',
  '[00:04.00]Second line',
  '[00:05.00]<00:05.00>Word <00:05.50>tags'
].join('\n')

describe('validateAiBaseUrl', () => {
  it('accepts https for any host', () => {
    expect(validateAiBaseUrl('https://api.openai.com/v1')).toEqual({
      ok: true,
      url: 'https://api.openai.com/v1'
    })
    expect(validateAiBaseUrl('https://openrouter.ai/api/v1')).toEqual({
      ok: true,
      url: 'https://openrouter.ai/api/v1'
    })
  })

  it('accepts http only for loopback hosts', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:1234/v1'
    ]) {
      expect(validateAiBaseUrl(url).ok).toBe(true)
    }
  })

  it('rejects plain http for a remote host', () => {
    const result = validateAiBaseUrl('http://api.example.com/v1')
    expect(result.ok).toBe(false)
  })

  it('rejects non-http(s) schemes', () => {
    expect(validateAiBaseUrl('ftp://example.com').ok).toBe(false)
    expect(validateAiBaseUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateAiBaseUrl('javascript:alert(1)').ok).toBe(false)
  })

  it('rejects embedded credentials', () => {
    expect(validateAiBaseUrl('https://user:pass@api.openai.com/v1').ok).toBe(false)
    expect(validateAiBaseUrl('https://user@api.openai.com/v1').ok).toBe(false)
  })

  it('rejects empty, whitespace, control characters, and junk', () => {
    expect(validateAiBaseUrl('').ok).toBe(false)
    expect(validateAiBaseUrl('   ').ok).toBe(false)
    expect(validateAiBaseUrl('https://api.openai.com/v1\nX-Injected: 1').ok).toBe(false)
    expect(validateAiBaseUrl('not a url').ok).toBe(false)
  })

  it('normalizes a trailing slash away', () => {
    const result = validateAiBaseUrl('https://api.openai.com/v1/')
    expect(result).toEqual({ ok: true, url: 'https://api.openai.com/v1' })
  })

  it('preserves an explicit port and path', () => {
    const result = validateAiBaseUrl('https://example.com:8443/openai/v1')
    expect(result).toEqual({ ok: true, url: 'https://example.com:8443/openai/v1' })
  })
})

describe('buildChatCompletionsUrl', () => {
  it('appends /chat/completions', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
  })

  it('is idempotent when the path is already present', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
  })
})

describe('extractTranslatableLines', () => {
  it('deduplicates identical lines and keeps every timestamp', () => {
    const entries = extractTranslatableLines(LRC)
    expect(entries.map((entry) => entry.text)).toEqual([
      'First line',
      'Second line',
      'Word tags'
    ])
    expect(entries[0]).toEqual({ index: 1, text: 'First line', timestampsMs: [1000, 2500] })
  })

  it('skips empty/instrumental lines', () => {
    const entries = extractTranslatableLines(LRC)
    expect(entries.some((entry) => entry.text.length === 0)).toBe(false)
  })

  it('strips A2 word tags by default and keeps them when asked', () => {
    expect(extractTranslatableLines(LRC)[2]?.text).toBe('Word tags')
    expect(
      extractTranslatableLines(LRC, { preserveWordTags: true })[2]?.text
    ).toContain('<00:05.00>')
  })

  it('returns nothing for lyrics without timestamps', () => {
    expect(extractTranslatableLines('plain words only')).toEqual([])
  })

  it('honors maxLines', () => {
    const entries = extractTranslatableLines(LRC, { maxLines: 1 })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.index).toBe(1)
  })
})

describe('buildAiLyricsMessages', () => {
  const entries = extractTranslatableLines(LRC)

  it('produces a system + user message pair with JSON-only instructions', () => {
    const messages = buildAiLyricsMessages(entries, 'translation', { targetLanguage: 'Spanish' })
    expect(messages.map((message) => message.role)).toEqual(['system', 'user'])
    expect(messages[0]?.content).toContain('Translate each lyric line into Spanish')
    expect(messages[0]?.content).toContain('Return ONLY minified JSON')
    expect(messages[1]?.content).toContain('"lines"')
    expect(messages[1]?.content).toContain('First line')
  })

  it('instructs romanization for the romanization mode', () => {
    const messages = buildAiLyricsMessages(entries, 'romanization', {
      romanizationStyle: 'Revised Romanization'
    })
    expect(messages[0]?.content).toContain('Romanize each lyric line using Revised Romanization')
    expect(messages[0]?.content).toContain('do NOT translate')
  })

  it('passes a source-language hint when provided', () => {
    const messages = buildAiLyricsMessages(entries, 'translation', {
      targetLanguage: 'English',
      sourceLanguage: 'Japanese'
    })
    expect(messages[1]?.content).toContain('Source language: Japanese')
  })

  it('defaults the target language to English', () => {
    const messages = buildAiLyricsMessages(entries, 'translation')
    expect(messages[0]?.content).toContain('into English')
  })
})

describe('stripMarkdownFence / extractJsonObject', () => {
  it('strips a json fence', () => {
    expect(stripMarkdownFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripMarkdownFence('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripMarkdownFence('{"a":1}')).toBe('{"a":1}')
  })

  it('extracts a JSON object surrounded by prose', () => {
    expect(extractJsonObject('Sure! {"lines":[{"index":1,"text":"x"}]} hope that helps')).toEqual({
      lines: [{ index: 1, text: 'x' }]
    })
  })

  it('handles braces inside strings', () => {
    expect(extractJsonObject('{"text":"a } brace"}')).toEqual({ text: 'a } brace' })
  })

  it('returns null for non-JSON', () => {
    expect(extractJsonObject('nothing here')).toBeNull()
    expect(extractJsonObject('{"unterminated": ')).toBeNull()
  })
})

describe('parseAiResponseAndRebuildLrc', () => {
  const entries = extractTranslatableLines(LRC)

  it('re-attaches the ORIGINAL timestamps, never model output', () => {
    const response = JSON.stringify({
      lines: [
        { index: 1, text: 'Primera línea' },
        { index: 2, text: 'Segunda línea' },
        { index: 3, text: 'Palabras' }
      ]
    })
    const result = parseAiResponseAndRebuildLrc(response, entries)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lyrics).toBe(
      [
        '[00:01.00]Primera línea',
        '[00:02.50]Primera línea',
        '[00:04.00]Segunda línea',
        '[00:05.00]Palabras'
      ].join('\n')
    )
    expect(result.lineCount).toBe(3)
  })

  it('unwraps a markdown-fenced response', () => {
    const result = parseAiResponseAndRebuildLrc(
      '```json\n{"lines":[{"index":1,"text":"Uno"}]}\n```',
      entries
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Missing indexes fall back to the source text so lyrics are never dropped.
    expect(result.lyrics).toContain('[00:04.00]Second line')
    expect(result.lyrics).toContain('[00:01.00]Uno')
  })

  it('falls back to source text for missing indexes (keepMissingLines default)', () => {
    const result = parseAiResponseAndRebuildLrc('{"lines":[{"index":1,"text":"Uno"}]}', entries)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lyrics.split('\n')).toHaveLength(4)
  })

  it('drops missing indexes when keepMissingLines is false', () => {
    const result = parseAiResponseAndRebuildLrc('{"lines":[{"index":1,"text":"Uno"}]}', entries, {
      keepMissingLines: false
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lyrics).toBe('[00:01.00]Uno\n[00:02.50]Uno')
  })

  it('normalizes whitespace inside generated lines', () => {
    const result = parseAiResponseAndRebuildLrc(
      '{"lines":[{"index":1,"text":"  spaced    out  "}]}',
      entries
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lyrics).toContain('[00:01.00]spaced out')
  })

  it('rejects a response with no matching indexes', () => {
    const result = parseAiResponseAndRebuildLrc('{"lines":[{"index":99,"text":"x"}]}', entries)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/did not match/)
  })

  it('rejects non-JSON and empty responses', () => {
    expect(parseAiResponseAndRebuildLrc('no json at all', entries).ok).toBe(false)
    expect(parseAiResponseAndRebuildLrc('', entries).ok).toBe(false)
    expect(parseAiResponseAndRebuildLrc('{"lines":[]}', entries).ok).toBe(false)
  })

  it('rejects a payload without a lines array', () => {
    expect(parseAiResponseAndRebuildLrc('{"foo":1}', entries).ok).toBe(false)
  })

  it('accepts the "translations" alias some models return', () => {
    const result = parseAiResponseAndRebuildLrc(
      '{"translations":[{"index":1,"text":"Uno"}]}',
      entries
    )
    expect(result.ok).toBe(true)
  })

  it('keeps word tags when preserveWordTags is set', () => {
    const tagged = extractTranslatableLines(LRC, { preserveWordTags: true })
    const result = parseAiResponseAndRebuildLrc(
      JSON.stringify({ lines: [{ index: 3, text: 'Palabras' }] }),
      tagged,
      { preserveWordTags: true }
    )
    expect(result.ok).toBe(true)
  })

  it('sorts output by timestamp', () => {
    const result = parseAiResponseAndRebuildLrc(
      JSON.stringify({
        lines: [
          { index: 2, text: 'B' },
          { index: 1, text: 'A' }
        ]
      }),
      entries
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const times = result.lyrics.split('\n').map((line) => line.slice(0, 10))
    expect(times).toEqual([...times].sort())
  })
})

describe('utf8ByteLength', () => {
  it('matches Buffer.byteLength for ASCII and multi-byte text', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('日本')).toBe(6)
    expect(utf8ByteLength('🎵')).toBe(4)
  })
})
