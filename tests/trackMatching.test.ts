import { describe, it, expect } from 'vitest'
import {
  normalizeMatchText,
  cleanTrackTitle,
  splitArtists,
  extractPrimaryArtist,
  computeTrackFingerprint,
  buildQueryVariants,
  textSimilarity,
  scoreCandidate
} from '../src/shared/trackMatching'

describe('normalizeMatchText', () => {
  it('NFKC-normalizes, lowercases, and strips punctuation across scripts', () => {
    expect(normalizeMatchText('  Ｈｅｌｌｏ,   World!!  ')).toBe('hello world')
    expect(normalizeMatchText('Café—Noir')).toBe('café noir')
  })

  it('preserves Tamil and Cyrillic letters/numbers', () => {
    expect(normalizeMatchText('நெஞ்சம்-01')).toBe('நெஞ்சம் 01')
    expect(normalizeMatchText('Песня-1')).toBe('песня 1')
  })
})

describe('cleanTrackTitle', () => {
  it('strips (From "..."), [Remastered ...], (Official ...), (Bonus Track), - Single', () => {
    expect(
      cleanTrackTitle('My Song (From "The Movie") [Remastered 2011] (Official Video) - Single')
    ).toBe('My Song')
  })

  it('strips feature credits and soundtrack descriptors', () => {
    expect(cleanTrackTitle('My Song (feat. Some Artist)')).toBe('My Song')
    expect(cleanTrackTitle('My Song (ft. Some Artist)')).toBe('My Song')
    expect(cleanTrackTitle('My Song (featuring Some Artist)')).toBe('My Song')
    expect(cleanTrackTitle('My Song (Original Motion Picture Soundtrack)')).toBe('My Song')
  })

  it('keeps meaningful text intact', () => {
    expect(cleanTrackTitle('Bohemian Rhapsody')).toBe('Bohemian Rhapsody')
  })
})

describe('splitArtists / extractPrimaryArtist', () => {
  it('splits on ;, ,, /, &, feat., ft., featuring, and x', () => {
    expect(splitArtists('Artist One; Artist Two, Artist Three / Artist Four & Artist Five')).toEqual(
      ['Artist One', 'Artist Two', 'Artist Three', 'Artist Four', 'Artist Five']
    )
    expect(splitArtists('Hero feat. Guest')).toEqual(['Hero', 'Guest'])
    expect(splitArtists('Hero ft. Guest')).toEqual(['Hero', 'Guest'])
    expect(splitArtists('Hero featuring Guest')).toEqual(['Hero', 'Guest'])
    expect(splitArtists('Hero x Guest')).toEqual(['Hero', 'Guest'])
  })

  it('deduplicates artists case-insensitively', () => {
    expect(splitArtists('Artist; artist / ARTIST')).toEqual(['Artist'])
  })

  it('extracts the first artist as primary', () => {
    expect(extractPrimaryArtist('Artist One; Artist Two')).toBe('Artist One')
    expect(extractPrimaryArtist('Solo Artist')).toBe('Solo Artist')
  })
})

describe('computeTrackFingerprint / buildQueryVariants', () => {
  it('produces a stable fingerprint across equivalent inputs', () => {
    const a = computeTrackFingerprint({ title: 'Song', artist: 'Artist', album: 'Album', durationSec: 180 })
    const b = computeTrackFingerprint({ title: 'song', artist: 'artist', album: 'album', durationSec: 180 })
    expect(a).toBe(b)
  })

  it('builds raw, cleaned+album, and cleaned-no-album variants', () => {
    const variants = buildQueryVariants({
      title: 'Song (From "Movie") [Remastered]',
      artist: 'Artist One; Artist Two',
      album: 'Album',
      durationSec: 180
    })
    expect(variants.map((v) => v.id)).toEqual(['raw', 'cleaned-album', 'cleaned'])
    expect(variants[0]!.title).toBe('Song (From "Movie") [Remastered]')
    expect(variants[1]!.title).toBe('Song')
    expect(variants[1]!.artist).toBe('Artist One')
    expect(variants[1]!.album).toBe('Album')
    expect(variants[2]!.album).toBe('')
  })

  it('dedupes variants when cleaned values equal raw values', () => {
    const variants = buildQueryVariants({
      title: 'Plain Song',
      artist: 'Solo Artist',
      album: 'Album',
      durationSec: 180
    })
    // raw == cleaned-album (no noise), but cleaned drops the album -> 2 unique
    expect(variants.map((v) => v.id)).toEqual(['raw', 'cleaned'])
    expect(new Set(variants.map((v) => v.fingerprint)).size).toBe(variants.length)
  })
})

describe('textSimilarity', () => {
  it('matches Unicode tokens independent of case and punctuation', () => {
    expect(textSimilarity('நெஞ்சம்', 'நெஞ்சம்')).toBe(1)
    expect(textSimilarity('Песня', 'песня')).toBe(1)
    expect(textSimilarity('Hello World', 'hello, world!')).toBe(1)
    expect(textSimilarity('Hello World', 'Completely Different')).toBe(0)
  })
})

describe('scoreCandidate', () => {
  const base = {
    queryTitle: 'Test Song',
    queryArtist: 'Test Artist',
    queryAlbum: 'Test Album',
    queryDurationSec: 240,
    candidateTitle: 'Test Song',
    candidateArtist: 'Test Artist',
    candidateAlbum: 'Test Album'
  }

  it('gives higher scores to word-synced than line-synced than plain', () => {
    const word = scoreCandidate({
      ...base,
      syncedLyrics: '[00:01.00]<00:01.00>Hello<00:01.50>World',
      plainLyrics: null,
      candidateDurationSec: 240
    })
    const line = scoreCandidate({
      ...base,
      syncedLyrics: '[00:01.00]Hello',
      plainLyrics: null,
      candidateDurationSec: 240
    })
    const plain = scoreCandidate({
      ...base,
      syncedLyrics: null,
      plainLyrics: 'Hello',
      candidateDurationSec: 240
    })
    expect(word.timingKind).toBe('word')
    expect(line.timingKind).toBe('line')
    expect(plain.timingKind).toBe('plain')
    expect(word.score).toBeGreaterThan(line.score)
    expect(line.score).toBeGreaterThan(plain.score)
  })

  it('penalizes duration deltas beyond 15s and more beyond 30s', () => {
    const exact = scoreCandidate({ ...base, syncedLyrics: '[00:01.00]Hi', candidateDurationSec: 240 })
    const close = scoreCandidate({ ...base, syncedLyrics: '[00:01.00]Hi', candidateDurationSec: 242 })
    const far = scoreCandidate({ ...base, syncedLyrics: '[00:01.00]Hi', candidateDurationSec: 260 })
    const veryFar = scoreCandidate({ ...base, syncedLyrics: '[00:01.00]Hi', candidateDurationSec: 280 })

    expect(exact.durationDeltaSec).toBe(0)
    expect(close.durationDeltaSec).toBe(2)
    // exact and close are both within the +8 tier, so they tie
    expect(exact.score).toBe(close.score)
    // both <= 15s: no penalty, exact just has the +8 close bonus
    expect(close.score).toBeGreaterThan(far.score)
    expect(far.score).toBeGreaterThan(veryFar.score)
  })

  it('gives an album bonus for matching album names', () => {
    const withAlbum = scoreCandidate({
      ...base,
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240,
      candidateAlbum: 'Test Album'
    })
    const withoutAlbum = scoreCandidate({
      ...base,
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240,
      candidateAlbum: 'Different Album'
    })
    expect(withAlbum.score).toBeGreaterThan(withoutAlbum.score)
  })

  it('scores a multi-artist query against the best matching credited artist', () => {
    const multi = scoreCandidate({
      ...base,
      queryArtist: 'Main Artist; Feature Guest',
      candidateArtist: 'Feature Guest',
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240
    })
    const none = scoreCandidate({
      ...base,
      queryArtist: 'Main Artist; Feature Guest',
      candidateArtist: 'Unrelated Band',
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240
    })
    expect(multi.artistSimilarity).toBe(1)
    expect(none.artistSimilarity).toBe(0)
    expect(multi.score).toBeGreaterThan(none.score)
  })

  it('takes the maximum artist similarity across every split entry', () => {
    const result = scoreCandidate({
      ...base,
      queryArtist: 'Alpha, Beta & Gamma',
      candidateArtist: 'gamma',
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240
    })
    expect(result.artistSimilarity).toBe(1)
  })

  it('falls back to the raw title when cleaning strips it to an empty string', () => {
    const result = scoreCandidate({
      ...base,
      queryTitle: '(Official Video)',
      candidateTitle: '(Official Video)',
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240
    })
    expect(cleanTrackTitle('(Official Video)')).toBe('')
    expect(result.titleSimilarity).toBe(1)
  })

  it('applies the local synced baseline of 100', () => {
    const local = scoreCandidate({
      ...base,
      syncedLyrics: '[00:01.00]Hi',
      candidateDurationSec: 240,
      isLocalSidecar: true
    })
    expect(local.score).toBe(100)
  })
})
