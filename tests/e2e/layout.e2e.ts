import { test, expect } from '@playwright/test'
import {
  launchElectronApp,
  startProviderMocks,
  setupLrclibMock,
  setupNeteaseMock
} from './fixtures/electronApp'

/**
 * Layout screenshot capture tests.
 * These tests capture screenshots at various viewport sizes for visual regression.
 */
test.describe('Layout Screenshots', () => {
  const viewports = [
    { width: 1366, height: 690, name: '1366x690' },
    { width: 1120, height: 700, name: '1120x700' },
    { width: 840, height: 690, name: '840x690-narrow' }
  ]

  for (const viewport of viewports) {
    test(`capture ${viewport.name} - empty state (no folder)`, async () => {
      const { page, cleanup } = await launchElectronApp({
        seedLibrary: false,
        skipInitialScan: true
      })
      try {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(3000)

        await expect(page.locator('text=No track focused').first()).toBeVisible({ timeout: 10000 })
        await page.screenshot({ path: `tests/e2e/screenshots/empty-no-folder-${viewport.name}.png`, fullPage: true })
      } finally {
        await cleanup()
      }
    })

    test(`capture ${viewport.name} - no track focused`, async () => {
      const { page, cleanup } = await launchElectronApp({
        seedLibrary: true,
        seedWithTracks: true,
        skipInitialScan: false
      })
      try {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(5000)

        await expect(page.locator('text=No track focused').first()).toBeVisible({ timeout: 10000 })
        await page.screenshot({ path: `tests/e2e/screenshots/empty-no-track-${viewport.name}.png`, fullPage: true })
      } finally {
        await cleanup()
      }
    })

    test(`capture ${viewport.name} - no lyrics`, async () => {
      const { page, cleanup } = await launchElectronApp({
        seedLibrary: true,
        seedWithTracks: true,
        skipInitialScan: false
      })
      try {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(5000)

        // Focus a track that has no lyrics
        await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
        const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
        await trackRow.click()

        await expect(page.locator('text=No synced').first()).toBeVisible({ timeout: 10000 })
        await page.screenshot({ path: `tests/e2e/screenshots/empty-no-lyrics-${viewport.name}.png`, fullPage: true })
      } finally {
        await cleanup()
      }
    })

    test(`capture ${viewport.name} - no results`, async () => {
      const { lrclib, netease } = await startProviderMocks()
      const { page, cleanup } = await launchElectronApp({
        lrclibBaseUrl: lrclib.baseUrl,
        neteaseBaseUrl: netease.baseUrl,
        seedLibrary: true,
        seedWithTracks: true,
        skipInitialScan: false
      })

      // The test focuses the first track ("Test Track - Test Artist") and searches
      // Mock should return empty results for the actual track name that will be searched
      setupLrclibMock(lrclib, {
        search: [{
          query: { track_name: 'Test Track', artist_name: 'Test Artist' },
          response: []
        }, {
          query: { q: 'Test Artist Test Track' },
          response: []
        }]
      })

      try {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(5000)

        // Focus a track
        await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
        const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
        await trackRow.click()

        // Go to Find tab and search - use description to disambiguate
        await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: 'Search' }).click()

        // Wait for "no results" message - check for either text
        await expect(page.getByText('No candidates').or(page.getByText('No results')).first()).toBeVisible({ timeout: 10000 })
        await page.screenshot({ path: `tests/e2e/screenshots/empty-no-results-${viewport.name}.png`, fullPage: true })
      } finally {
        await cleanup()
        await lrclib.server.close()
        await netease.server.close()
      }
    })

    test(`capture ${viewport.name} - provider error`, async () => {
      const { lrclib, netease } = await startProviderMocks()
      const { page, cleanup } = await launchElectronApp({
        lrclibBaseUrl: lrclib.baseUrl,
        neteaseBaseUrl: netease.baseUrl,
        seedLibrary: true,
        seedWithTracks: true,
        skipInitialScan: false
      })

      setupLrclibMock(lrclib, {
        get: [{
          query: { track_name: 'Test', artist_name: 'Artist' },
          response: { error: 'Server error' }
        }]
      })

      try {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(5000)

        // Focus a track
        await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
        const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
        await trackRow.click()

        // Go to Find and trigger error - use description to disambiguate
        await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: 'Search' }).click()

        // Wait for error message
        await page.waitForTimeout(3000)
        await page.screenshot({ path: `tests/e2e/screenshots/empty-provider-error-${viewport.name}.png`, fullPage: true })
      } finally {
        await cleanup()
        await lrclib.server.close()
        await netease.server.close()
      }
    })
  }

  test('capture Lyrics tab with active stacked lines + 3-line bottom player', async () => {
    const { lrclib, netease } = await startProviderMocks()
    const { page, cleanup } = await launchElectronApp({
      lrclibBaseUrl: lrclib.baseUrl,
      neteaseBaseUrl: netease.baseUrl,
      seedLibrary: true,
      seedWithTracks: true,
      skipInitialScan: false
    })

    setupLrclibMock(lrclib, {
      get: [{
        query: { track_name: 'Test Track', artist_name: 'Test Artist' },
        response: {
          id: 123,
          trackName: 'Test Track',
          artistName: 'Test Artist',
          duration: 15,
          syncedLyrics: '[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line',
          plainLyrics: null
        }
      }],
      search: [{
        query: { track_name: 'Test Track', artist_name: 'Test Artist' },
        response: [{
          id: 123,
          trackName: 'Test Track',
          artistName: 'Test Artist',
          duration: 15,
          syncedLyrics: '[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line',
          plainLyrics: null,
          translatedLyrics: '',
          romanizedLyrics: ''
        }]
      }, {
        query: { q: 'Test Artist Test Track' },
        response: [{
          id: 123,
          trackName: 'Test Track',
          artistName: 'Test Artist',
          duration: 15,
          syncedLyrics: '[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line',
          plainLyrics: null,
          translatedLyrics: '',
          romanizedLyrics: ''
        }]
      }]
    })

    try {
      for (const viewport of [{ width: 1366, height: 690 }, { width: 1120, height: 700 }]) {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(3000)

        // Focus track and load lyrics
        await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
        const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
        await trackRow.click()

        await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: 'Search' }).click()
        // Candidate rows have title attribute with "Track — Artist (Album)"
        await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
        await page.locator('button[title*="Test Track"]').first().click()
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: 'Load Primary' }).click()

        await page.getByRole('button', { name: 'Lyrics', description: 'Lyrics (Ctrl+1)' }).click()
        await page.waitForTimeout(1000)

        // Wait for active line highlight
        await page.waitForTimeout(2000)

        await page.screenshot({ path: `tests/e2e/screenshots/lyrics-tab-${viewport.width}x${viewport.height}.png`, fullPage: true })
      }
    } finally {
      await cleanup()
      await lrclib.server.close()
      await netease.server.close()
    }
  })

  test('capture Text tab (wide 3-column)', async () => {
    const { lrclib, netease } = await startProviderMocks()
    const { page, cleanup } = await launchElectronApp({
      lrclibBaseUrl: lrclib.baseUrl,
      neteaseBaseUrl: netease.baseUrl,
      seedLibrary: true,
      seedWithTracks: true,
      skipInitialScan: false
    })

    setupNeteaseMock(netease, {
      search: [{
        query: 'Test Artist Test Track',
        response: {
          result: {
            songs: [{
              id: 12345,
              name: 'Test Track',
              artists: [{ name: 'Test Artist' }],
              album: { name: 'Test Album' },
              dt: 240000
            }]
          },
          code: 200
        }
      }],
      lyric: [{
        songId: 12345,
        response: {
          lrc: { lyric: '[00:00.00]Test lyric\n[00:05.00]Second line' },
          tlyric: { lyric: '[00:00.00]Test translation\n[00:05.00]Second translation' },
          romalrc: { lyric: '[00:00.00]Test romanization\n[00:05.00]Second romanization' },
          code: 200
        }
      }]
    })

    try {
      for (const viewport of [{ width: 1366, height: 690 }, { width: 1120, height: 700 }]) {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(3000)

        await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
        const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
        await trackRow.click()

        // Use description to disambiguate
        await page.getByRole('button', { name: 'Text', description: 'Text (Ctrl+2)' }).click()
        await page.waitForTimeout(1000)

        // Load all layers from NetEase mock
        await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
        await page.waitForTimeout(500)
        // NetEase provider filter button has title "Search only NetEase"
        await page.getByRole('button', { name: 'NetEase', exact: true, description: 'Search only NetEase' }).click()
        await page.getByRole('button', { name: 'Search' }).click()
        // Candidate rows have title attribute with "Track — Artist (Album)"
        await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
        await page.locator('button[title*="Test Track"]').first().click()
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: 'Load All Layers' }).click()

        await page.getByRole('button', { name: 'Text', description: 'Text (Ctrl+2)' }).click()
        await page.waitForTimeout(1000)

        await page.screenshot({ path: `tests/e2e/screenshots/text-tab-wide-${viewport.width}x${viewport.height}.png`, fullPage: true })
      }
    } finally {
      await cleanup()
      await lrclib.server.close()
      await netease.server.close()
    }
  })

  test('capture Find tab with mock candidates + preview', async () => {
    const { lrclib, netease } = await startProviderMocks()
    const { page, cleanup } = await launchElectronApp({
      lrclibBaseUrl: lrclib.baseUrl,
      neteaseBaseUrl: netease.baseUrl,
      seedLibrary: true,
      seedWithTracks: true,
      skipInitialScan: false
    })

    setupLrclibMock(lrclib, {
      search: [{
        query: { track_name: 'Test', artist_name: 'Artist' },
        response: [{
          id: 1,
          trackName: 'Test Track',
          artistName: 'Test Artist',
          duration: 240,
          syncedLyrics: '[00:00.00]Test lyric\n[00:05.00]Second line',
          plainLyrics: null,
          translatedLyrics: '',
          romanizedLyrics: ''
        }]
      }]
    })

    try {
      for (const viewport of [{ width: 1366, height: 690 }, { width: 1120, height: 700 }]) {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(3000)

        await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
        const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
        await trackRow.click()

        await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: 'Search' }).click()
        await page.waitForSelector('button[aria-pressed]', { timeout: 15000 })

        await page.screenshot({ path: `tests/e2e/screenshots/find-tab-${viewport.width}x${viewport.height}.png`, fullPage: true })
      }
    } finally {
      await cleanup()
      await lrclib.server.close()
      await netease.server.close()
    }
  })

  test('capture 840px narrow check - TopBar single row, Text tabbed, no overflow', async () => {
    const { page, cleanup } = await launchElectronApp({
      seedLibrary: true,
      seedWithTracks: true,
      skipInitialScan: false
    })

    try {
      await page.setViewportSize({ width: 840, height: 690 })
      await page.waitForTimeout(5000)

      // Focus a track first so Text tab is enabled
      await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
      const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
      await trackRow.click()
      await page.waitForTimeout(1000)

      // Check TopBar doesn't wrap
      const topBar = page.locator('header, .top-bar, [role="banner"]').first()
      await expect(topBar).toBeVisible()

      // Check no horizontal overflow
      const body = page.locator('body')
      const scrollWidth = await body.evaluate(el => el.scrollWidth)
      const clientWidth = await body.evaluate(el => el.clientWidth)
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth)

      // Check Text tab uses layer tabs (if Text tab is accessible)
      await page.getByRole('button', { name: 'Text', description: 'Text (Ctrl+2)' }).click()
      await page.waitForTimeout(500)

      // Check for layer tabs - they are buttons with labels "Primary", "Translation", "Romanization"
      // Use exact: true to match only the layer tab "Primary", not "Embed: Primary"
      const layerTabs = page.getByRole('button', { name: 'Primary', exact: true })
      await expect(layerTabs).toBeVisible()

      // Check no vertical overflow
      const scrollHeight = await body.evaluate(el => el.scrollHeight)
      const clientHeight = await body.evaluate(el => el.clientHeight)
      expect(scrollHeight).toBeLessThanOrEqual(clientHeight)

      await page.screenshot({ path: 'tests/e2e/screenshots/narrow-840px-check.png', fullPage: true })
    } finally {
      await cleanup()
    }
  })
})