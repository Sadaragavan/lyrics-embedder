import { describe, it, expect } from 'vitest'
import {
  parseLrc,
  formatLrc,
  normalizeLrc,
  parseTimestamp,
  formatTimestamp,
  extractOffset,
  stackLrcLayers,
  shiftLrcOffset
} from '../src/shared/lrc'

describe('parseTimestamp', () => {
  it('parses [mm:ss.xx] centiseconds', () => {
    expect(parseTimestamp('01', '30', '50')).toBe(90_500)
  })

  it('parses single-digit fraction as hundreds of ms', () => {
    expect(parseTimestamp('00', '05', '5')).toBe(5_500)
  })

  it('parses three-digit fraction as milliseconds', () => {
    expect(parseTimestamp('00', '01', '250')).toBe(1_250)
  })

  it('parses missing sub-second fraction as 0 ms', () => {
    expect(parseTimestamp('02', '10', '')).toBe(130_000)
  })

  it('parses zero timestamp', () => {
    expect(parseTimestamp('00', '00', '00')).toBe(0)
  })
})

describe('formatTimestamp', () => {
  it('formats milliseconds as [mm:ss.xx]', () => {
    expect(formatTimestamp(90_500)).toBe('[01:30.50]')
  })

  it('formats zero', () => {
    expect(formatTimestamp(0)).toBe('[00:00.00]')
  })

  it('rounds to nearest centisecond including minute/second rollover', () => {
    expect(formatTimestamp(1_554)).toBe('[00:01.55]')
    expect(formatTimestamp(1_555)).toBe('[00:01.56]')
    expect(formatTimestamp(59_996)).toBe('[01:00.00]')
  })

  it('handles large minute values', () => {
    expect(formatTimestamp(600_000)).toBe('[10:00.00]')
  })

  it('clamps negative to zero', () => {
    expect(formatTimestamp(-500)).toBe('[00:00.00]')
  })
})

describe('extractOffset', () => {
  it('returns 0 when no offset header', () => {
    expect(extractOffset('[00:01.00]Hello')).toBe(0)
  })

  it('extracts positive offset with or without plus sign', () => {
    expect(extractOffset('[offset:200]\n[00:01.00]Hello')).toBe(200)
    expect(extractOffset('[offset:+250]\n[00:01.00]Hello')).toBe(250)
  })

  it('extracts negative offset', () => {
    expect(extractOffset('[offset:-150]\n[00:01.00]Hello')).toBe(-150)
  })

  it('strips UTF-8 BOM when extracting offset', () => {
    expect(extractOffset('\uFEFF[offset:300]\n[00:01.00]Hello')).toBe(300)
  })
})

describe('parseLrc', () => {
  it('parses basic LRC lines and handles colon/no-fraction timestamps', () => {
    const raw = `[00:01.00]Line one\n[00:05:50]Line two\n[00:10]Line three`
    const lines = parseLrc(raw)
    expect(lines).toEqual([
      { timeMs: 1_000, text: 'Line one' },
      { timeMs: 5_500, text: 'Line two' },
      { timeMs: 10_000, text: 'Line three' }
    ])
  })

  it('strips metadata headers including [length:]', () => {
    const raw = `\uFEFF[ti:Song Title]\n[ar:Artist]\n[length:03:30]\n[00:01.00]Hello`
    const lines = parseLrc(raw)
    expect(lines).toEqual([{ timeMs: 1_000, text: 'Hello' }])
  })

  it('bakes [offset:±ms] into timestamps and clamps below 0', () => {
    const raw = `[offset:-500]\n[00:00.20]Too early\n[00:01.00]Line`
    const lines = parseLrc(raw)
    expect(lines).toEqual([
      { timeMs: 0, text: 'Too early' },
      { timeMs: 500, text: 'Line' }
    ])
  })

  it('handles multiple timestamps per line', () => {
    const raw = `[00:01.00][00:05.00]Repeated line`
    const lines = parseLrc(raw)
    expect(lines).toEqual([
      { timeMs: 1_000, text: 'Repeated line' },
      { timeMs: 5_000, text: 'Repeated line' }
    ])
  })

  it('strips A2 word tags by default and collapses excess whitespace', () => {
    const raw = `[00:01.00]<00:01.00>Hello <00:01.50> world <00:02.00>`
    const lines = parseLrc(raw)
    expect(lines[0]!.text).toBe('Hello world')
  })

  it('preserves A2 word tags when option enabled and shifts them with offset', () => {
    const raw = `[offset:500]\n[00:01.00]Hello <00:01.50>world`
    const lines = parseLrc(raw, { preserveWordTags: true })
    expect(lines[0]).toEqual({
      timeMs: 1_500,
      text: 'Hello <00:02.00>world'
    })
  })

  it('sorts stably by timestamp', () => {
    const raw = `[00:05.00]Second\n[00:01.00]FirstA\n[00:01.00]FirstB`
    const lines = parseLrc(raw)
    expect(lines.map((l) => l.text)).toEqual(['FirstA', 'FirstB', 'Second'])
  })

  it('preserves empty instrumental break lines while skipping blank/untagged lines', () => {
    const raw = `\n\nSome random text\n[00:01.00]Real line\n[00:05.00]\n\n`
    const lines = parseLrc(raw)
    expect(lines).toEqual([
      { timeMs: 1_000, text: 'Real line' },
      { timeMs: 5_000, text: '' }
    ])
  })
})

describe('formatLrc', () => {
  it('formats lines with centisecond-rounded timestamps', () => {
    const result = formatLrc([
      { timeMs: 1_004, text: 'Hello' },
      { timeMs: 5_506, text: 'World' }
    ])
    expect(result).toBe('[00:01.00]Hello\n[00:05.51]World')
  })

  it('strips word tags by default', () => {
    const result = formatLrc([{ timeMs: 1_000, text: 'Hello <00:01.50>world' }])
    expect(result).toBe('[00:01.00]Hello world')
  })
})

describe('normalizeLrc', () => {
  it('round-trips clean LRC', () => {
    const raw = `[00:01.00]Hello\n[00:05.50]World`
    expect(normalizeLrc(raw)).toBe(raw)
  })

  it('bakes offset, strips metadata and [length:], rounds centiseconds, and sorts', () => {
    const raw = `[ti:Title]\n[ar:Artist]\n[length:3:00]\n[offset:1000]\n[00:05.555]Second\n[00:01.00]First`
    const result = normalizeLrc(raw)
    expect(result).toBe('[00:02.00]First\n[00:06.56]Second')
  })
})

describe('stackLrcLayers', () => {
  it('merges two layers at the same timestamps in layer order', () => {
    const original = `[00:01.004]English line\n[00:05.00]Line two`
    const translation = `[00:01.000]翻訳行\n[00:05.00]二行目`
    const romanization = `[00:01.00]Hon'yaku gyō`
    const result = stackLrcLayers([original, translation, romanization])
    expect(result).toBe(
      `[00:01.00]English line\n[00:01.00]翻訳行\n[00:01.00]Hon'yaku gyō\n[00:05.00]Line two\n[00:05.00]二行目`
    )
  })

  it('interleaves different timestamps', () => {
    const a = `[00:01.00]A1\n[00:03.00]A2`
    const b = `[00:02.00]B1\n[00:04.00]B2`
    const result = stackLrcLayers([a, b])
    expect(result).toBe('[00:01.00]A1\n[00:02.00]B1\n[00:03.00]A2\n[00:04.00]B2')
  })
})

describe('shiftLrcOffset', () => {
  it('shifts timestamps by positive delta', () => {
    const raw = `[00:01.00]Hello\n[00:05.00]World`
    const result = shiftLrcOffset(raw, 2_000)
    expect(result).toBe('[00:03.00]Hello\n[00:07.00]World')
  })

  it('clamps negative-shifted timestamps to zero', () => {
    const raw = `[00:01.00]Hello`
    const result = shiftLrcOffset(raw, -5_000)
    expect(result).toBe('[00:00.00]Hello')
  })

  it('shifts preserved A2 word tags when preserveWordTags is enabled', () => {
    const raw = `[00:01.00]Hello <00:01.50>world`
    expect(shiftLrcOffset(raw, 500, { preserveWordTags: true })).toBe(
      '[00:01.50]Hello <00:02.00>world'
    )
  })
})
