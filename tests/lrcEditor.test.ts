import { describe, expect, it } from 'vitest'
import {
  isValidInlineTimestamp,
  parseEditableRows,
  parseInlineTimestamp,
  serializeEditableLayer,
  serializeEditableRows
} from '../src/shared/lrcEditor'

const PRIMARY = ['[00:01.00]Line one', '[00:02.00]<00:02.00>Word <00:02.50>two', '[00:03.00]Line three'].join(
  '\n'
)
const TRANSLATION = ['[00:01.00]Línea uno', '[00:02.00]Palabra dos'].join('\n')
const ROMANIZATION = ['[00:02.00]Kotoba ni', '[00:09.00]Layer only row'].join('\n')

describe('parseEditableRows', () => {
  it('merges layer lines into the primary row sharing their timestamp', () => {
    const rows = parseEditableRows(PRIMARY, TRANSLATION, ROMANIZATION)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      timeMs: 1000,
      text: 'Line one',
      translation: 'Línea uno',
      romanization: '',
      createsOnlyFromLayers: false
    })
    expect(rows[1]?.timeMs).toBe(2000)
    expect(rows[1]?.translation).toBe('Palabra dos')
    expect(rows[1]?.romanization).toBe('Kotoba ni')
  })

  it('keeps a layer-only timestamp as its own row so content is never dropped', () => {
    const rows = parseEditableRows(PRIMARY, TRANSLATION, ROMANIZATION)
    const layerOnly = rows.find((row) => row.timeMs === 9000)
    expect(layerOnly).toBeDefined()
    expect(layerOnly?.text).toBe('')
    expect(layerOnly?.romanization).toBe('Layer only row')
    expect(layerOnly?.createsOnlyFromLayers).toBe(true)
  })

  it('sorts rows by timestamp regardless of input order', () => {
    const rows = parseEditableRows('[00:05.00]five\n[00:01.00]one', '', '')
    expect(rows.map((row) => row.timeMs)).toEqual([1000, 5000])
  })

  it('strips A2 word tags by default and keeps them on request', () => {
    expect(parseEditableRows(PRIMARY, '', '')[1]?.text).toBe('Word two')
    expect(
      parseEditableRows(PRIMARY, '', '', { preserveWordTags: true })[1]?.text
    ).toContain('<00:02.00>')
  })

  it('returns no rows for plain, untimed lyrics', () => {
    expect(parseEditableRows('just some words\nand more', '', '')).toEqual([])
  })

  it('appends duplicate layer lines at the same timestamp instead of overwriting', () => {
    const rows = parseEditableRows('[00:01.00]a', '[00:01.00]x\n[00:01.00]y', '')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.translation).toBe('x\ny')
  })
})

describe('serializeEditableRows', () => {
  it('round-trips the primary layer and drops layer-only rows', () => {
    const rows = parseEditableRows(PRIMARY, TRANSLATION, ROMANIZATION)
    expect(serializeEditableRows(rows)).toBe(
      ['[00:01.00]Line one', '[00:02.00]Word two', '[00:03.00]Line three'].join('\n')
    )
  })

  it('round-trips the translation layer, skipping rows without translation text', () => {
    const rows = parseEditableRows(PRIMARY, TRANSLATION, ROMANIZATION)
    expect(serializeEditableLayer(rows, 'translation')).toBe(
      ['[00:01.00]Línea uno', '[00:02.00]Palabra dos'].join('\n')
    )
  })

  it('round-trips the romanization layer including its layer-only row', () => {
    const rows = parseEditableRows(PRIMARY, TRANSLATION, ROMANIZATION)
    expect(serializeEditableLayer(rows, 'romanization')).toBe(
      ['[00:02.00]Kotoba ni', '[00:09.00]Layer only row'].join('\n')
    )
  })

  it('re-emits edited text, timestamps and layers after an in-place edit', () => {
    const rows = parseEditableRows('[00:01.00]a', '', '')
    const edited = rows.map((row) => ({
      ...row,
      timeMs: 1500,
      key: 150,
      text: 'edited',
      translation: 'editada'
    }))
    expect(serializeEditableRows(edited)).toBe('[00:01.50]edited')
    expect(serializeEditableLayer(edited, 'translation')).toBe('[00:01.50]editada')
  })

  it('omits empty primary rows unless explicitly requested', () => {
    const rows = parseEditableRows('', '[00:09.00]only layer', '')
    expect(serializeEditableRows(rows)).toBe('')
    expect(serializeEditableRows(rows, { includeEmptyPrimary: true })).toBe('[00:09.00]')
  })
})

describe('parseInlineTimestamp', () => {
  it('parses a valid [mm:ss.xx] pill and returns its normalized form', () => {
    expect(parseInlineTimestamp('[01:02.05]')).toEqual({
      timeMs: 62050,
      formatted: '[01:02.05]'
    })
  })

  it('accepts mm:ss without centiseconds', () => {
    expect(parseInlineTimestamp('01:02')?.timeMs).toBe(62000)
  })

  it('rejects out-of-range and garbage input', () => {
    expect(parseInlineTimestamp('00:75.00')).toBeNull()
    expect(parseInlineTimestamp('abc')).toBeNull()
    expect(parseInlineTimestamp('')).toBeNull()
  })

  it('isValidInlineTimestamp mirrors parseInlineTimestamp', () => {
    expect(isValidInlineTimestamp('[00:10.00]')).toBe(true)
    expect(isValidInlineTimestamp('00:75.00')).toBe(false)
  })
})
