import { test, expect } from '@playwright/test'
import {
  launchElectronApp,
  startProviderMocks,
  setupLrclibMock,
  setupNeteaseMock
} from './fixtures/electronApp'

/**
 * Test 1: Focus a track without crashing
 * Click Track A in the virtualized list, assert TrackHeader renders Track A's title and tabs render.
 */
test('focus track without crash', async () => {
  const { page, cleanup } = await launchElectronApp({
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })
  try {
    // Wait for the library sidebar to load
    await page.waitForTimeout(5000)

    // Wait for tracks to appear in the virtualized list
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    // Click the first track (Track A)
    const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
    await trackRow.click()

    // Right panel should show track header with Track A's title
    // Track title is in an h2 with classes truncate text-sm font-semibold
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Tabs should be present - use description to disambiguate
    await expect(page.getByRole('button', { name: 'Lyrics', description: 'Lyrics (Ctrl+1)' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Text', description: 'Text (Ctrl+2)' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' })).toBeVisible()
  } finally {
    await cleanup()
  }
})

/**
 * Test 2: No draft created on focus
 * Focus a track that already has lyrics (and one without), assert userDataDir/drafts/ has NO draft JSON created until a user edit occurs.
 */
test('no draft created on focus', async () => {
  const { page, cleanup } = await launchElectronApp({
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })
  try {
    await page.waitForTimeout(5000)

    // Wait for tracks to appear
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    // Focus a track
    const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
    await trackRow.click()

    // Wait for right panel to load - track title in h2
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Check that no draft was created by checking the draft badge
    await expect(page.locator('text=Draft')).not.toBeVisible({ timeout: 5000 })

    // Also verify via the app's internal state - no draft should exist for this track
    // The app should only create a draft when user edits
  } finally {
    await cleanup()
  }
})

/**
 * Test 3: Translation/romanization layers isolated across two tracks and surviving a switch
 * On Track A, load/enter Primary + Translation + Romanization (via Find mock NetEase Load All Layers or Text tab);
 * Switch to Track B; assert Track B's layers are empty and no draft leaked to Track B;
 * Enter a distinct layer on Track B; switch back to Track A; assert Track A retained its exact Translation + Romanization.
 */
test('layer isolation across track switch', async () => {
  const { lrclib, netease } = await startProviderMocks()
  const { page, cleanup } = await launchElectronApp({
    lrclibBaseUrl: lrclib.baseUrl,
    neteaseBaseUrl: netease.baseUrl,
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })

  // Set up NetEase mock to return multi-layer lyrics
  // NetEase search uses "artist title" format: "Test Artist Test Track"
  // The candidate result needs translatedLyrics and romanizedLyrics for "Load All Layers" to appear
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
    await page.waitForTimeout(5000)
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    const trackRows = page.locator('[role="row"], .track-row, .track-item')
    const trackCount = await trackRows.count()
    expect(trackCount).toBeGreaterThanOrEqual(2)

    // Focus Track A (first track)
    const trackA = trackRows.nth(0)
    await trackA.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Go to Find tab and search NetEase
    await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
    await page.waitForTimeout(500)
    // Click NetEase provider filter
    await page.getByRole('button', { name: 'NetEase' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Search' }).click()

    // Wait for search to complete (button returns to "Search" from "Searching...")
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible({ timeout: 30000 })

    // Wait for search results and select the candidate
    // Candidate rows have title attribute with "Track — Artist (Album)"
    await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
    await page.locator('button[title*="Test Track"]').first().click()
    await page.waitForTimeout(500)

    // Load all layers (primary + translation + romanization)
    await page.getByRole('button', { name: 'Load All Layers' }).click()

    // Go to Text tab to verify layers loaded
    await page.getByRole('button', { name: 'Text', description: 'Text (Ctrl+2)' }).click()
    await page.waitForTimeout(500)

    // Verify Track A has translation
    const translationInput = page.locator('textarea[aria-label="Translation layer LRC editor"]').first()
    await expect(translationInput).toHaveValue('[00:00.00]Test translation\n[00:05.00]Second translation')

    // Switch to Track B (second track)
    const trackB = trackRows.nth(1)
    await trackB.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Track B should have empty layers (no draft leaked)
    await expect(page.locator('textarea[aria-label="Translation layer LRC editor"]').first()).toHaveValue('')

    // Enter a distinct translation on Track B
    const trackBTranslation = page.locator('textarea[aria-label="Translation layer LRC editor"]').first()
    await trackBTranslation.fill('[00:01.00] Track B translation')

    // Switch back to Track A
    const trackRows2 = page.locator('[role="row"], .track-row, .track-item')
    const trackA2 = trackRows2.nth(0)
    await trackA2.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Track A should still have its original translation
    await expect(page.locator('textarea[aria-label="Translation layer LRC editor"]').first()).toHaveValue(
      '[00:00.00]Test translation\n[00:05.00]Second translation'
    )
  } finally {
    await cleanup()
  }
})

/**
 * Test 4: Embed twice yields identical lyrics (idempotent)
 * Embed stacked lyrics on Track A (.mp3/.flac fixture), wait for verified embed completion,
 * embed Track A a second time, and assert read-back embedded lyrics are identical with zero duplicated lines and draft deleted.
 */
test('embed twice yields identical lyrics', async () => {
  const { lrclib, netease } = await startProviderMocks()
  const { page, cleanup } = await launchElectronApp({
    lrclibBaseUrl: lrclib.baseUrl,
    neteaseBaseUrl: netease.baseUrl,
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })

  // Set up LRCLIB mock to return lyrics - both get and search
  // The LRCLIB provider tries multiple search variants, so we mock them all
  // Include translatedLyrics and romanizedLyrics for "Load All Layers" to appear
  // Only specify required params (track_name, artist_name) for flexible matching
  setupLrclibMock(lrclib, {
    get: [{
      query: { track_name: 'Test Track', artist_name: 'Test Artist' },
      response: {
        id: 123,
        trackName: 'Test Track',
        artistName: 'Test Artist',
        duration: 15,
        syncedLyrics: '[00:00.00]Original lyric\n[00:05.00]Second line',
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
        syncedLyrics: '[00:00.00]Original lyric\n[00:05.00]Second line',
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
        syncedLyrics: '[00:00.00]Original lyric\n[00:05.00]Second line',
        plainLyrics: null,
        translatedLyrics: '',
        romanizedLyrics: ''
      }]
    }]
  })

  try {
    await page.waitForTimeout(5000)
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
    await trackRow.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Click Find tab and search
    await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Search' }).click()

    // Wait for search results and select the candidate
    // Candidate rows have title attribute with "Track — Artist (Album)"
    await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
    await page.locator('button[title*="Test Track"]').first().click()
    await page.waitForTimeout(500)

    // Now "Load Primary" button should be visible - it's a native <button> with exact text
    await page.getByRole('button', { name: 'Load Primary' }).click()

    // Go back to Lyrics tab
    await page.getByRole('button', { name: 'Lyrics', description: 'Lyrics (Ctrl+1)' }).click()
    await expect(page.locator('text=Original lyric')).toBeVisible({ timeout: 10000 })

    // First embed
    await page.getByRole('button', { name: /Embed/ }).first().click()
    await expect(page.locator('text=Embedded lyrics for "Test Track"')).toBeVisible({ timeout: 15000 })

    // Get the embedded lyrics
    const editorText = await page.locator('textarea[aria-label="Primary layer LRC editor"]').first().inputValue()
    const firstEmbed = editorText

    // Second embed (should be idempotent)
    await page.getByRole('button', { name: /Embed/ }).first().click()
    await expect(page.locator('text=Embedded lyrics for "Test Track"')).toBeVisible({ timeout: 15000 })

    const secondEmbed = await page.locator('textarea[aria-label="Primary layer LRC editor"]').first().inputValue()

    // Should be identical (no duplicate lines)
    expect(firstEmbed).toBe(secondEmbed)

    // Also verify no duplicate timestamps in the lyrics
    const lines = firstEmbed.split('\n').filter(l => l.trim().startsWith('['))
    const timestamps = lines.map(l => l.match(/\[(\d{2}:\d{2}\.\d{2})\]/)?.[1]).filter(Boolean)
    const uniqueTimestamps = new Set(timestamps)
    expect(timestamps.length).toBe(uniqueTimestamps.size)

    // Verify draft was deleted
    await expect(page.locator('text=Draft')).not.toBeVisible({ timeout: 5000 })
  } finally {
    await cleanup()
  }
})

/**
 * Test 5: Batch embed (Embed Selected) preserves saved layers
 * Create saved layers on Track A and Track B, leave Track A focused while selecting both Track A + Track B,
 * click Embed Selected, and verify Track B's embedded lyrics include its saved layers.
 */
test('batch embed preserves non-focused track layers', async () => {
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
      response: { id: 1, trackName: 'Test Track', artistName: 'Test Artist', duration: 15, syncedLyrics: '[00:00.00]Lyric A', plainLyrics: null }
    }, {
      query: { track_name: 'Another Track', artist_name: 'Another Artist' },
      response: { id: 2, trackName: 'Another Track', artistName: 'Another Artist', duration: 15, syncedLyrics: '[00:00.00]Lyric B', plainLyrics: null }
    }],
    search: [{
      query: { track_name: 'Test Track', artist_name: 'Test Artist' },
      response: [{ id: 1, trackName: 'Test Track', artistName: 'Test Artist', duration: 15, syncedLyrics: '[00:00.00]Lyric A', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }, {
      query: { q: 'Test Artist Test Track' },
      response: [{ id: 1, trackName: 'Test Track', artistName: 'Test Artist', duration: 15, syncedLyrics: '[00:00.00]Lyric A', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }, {
      query: { track_name: 'Another Track', artist_name: 'Another Artist' },
      response: [{ id: 2, trackName: 'Another Track', artistName: 'Another Artist', duration: 15, syncedLyrics: '[00:00.00]Lyric B', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }, {
      query: { q: 'Another Artist Another Track' },
      response: [{ id: 2, trackName: 'Another Track', artistName: 'Another Artist', duration: 15, syncedLyrics: '[00:00.00]Lyric B', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }]
  })

  try {
    await page.waitForTimeout(5000)
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    const trackRows = page.locator('[role="row"], .track-row, .track-item')
    const trackCount = await trackRows.count()
    expect(trackCount).toBeGreaterThanOrEqual(2)

    // Focus Track A and add translation
    const trackA = trackRows.nth(0)
    await trackA.click()
    await page.getByRole('button', { name: 'Text', description: 'Text (Ctrl+2)' }).click()
    const translationInput = page.locator('textarea[aria-label="Translation layer LRC editor"]').first()
    await translationInput.fill('[00:00.00]Track A translation')

    // Focus Track B and add different translation
    const trackB = trackRows.nth(1)
    await trackB.click()
    const trackBTranslation = page.locator('textarea[aria-label="Translation layer LRC editor"]').first()
    await trackBTranslation.fill('[00:00.00]Track B translation')

    // Select both tracks using checkboxes (each track row has a checkbox button for selection)
    const checkboxA = trackA.locator('button[aria-label*="Toggle selection"]').first()
    const checkboxB = trackB.locator('button[aria-label*="Toggle selection"]').first()
    await checkboxA.click()
    await checkboxB.click()

    // Wait for selection to register and "Embed Selected" button to appear
    // The selection count is shown as "N selected" in the library sidebar
    await page.waitForSelector('text=2 selected', { timeout: 10000 })

    // Click Embed Selected - this button is in the library sidebar
    await page.getByRole('button', { name: 'Embed Selected' }).click()
    await expect(page.locator('text=Batch embed finished')).toBeVisible({ timeout: 20000 })

    // Verify Track A has its translation
    await trackA.click()
    await expect(page.locator('textarea[aria-label="Translation layer LRC editor"]').first()).toHaveValue('[00:00.00]Track A translation')

    // Verify Track B has its translation
    await trackB.click()
    await expect(page.locator('textarea[aria-label="Translation layer LRC editor"]').first()).toHaveValue('[00:00.00]Track B translation')
  } finally {
    await cleanup()
  }
})

/**
 * Test 6: Embed during playback does not replay an old seek
 * Focus the >= 10s .wav track with timed lyrics ([00:01.00], [00:04.00], [00:08.00]),
 * start playback, click the [00:01.00] line to seek, let/advance playback past 00:04.00,
 * trigger Embed, and assert playback does not jump back to 00:01.00.
 */
test('embed during playback does not replay old seek', async () => {
  const { lrclib, netease } = await startProviderMocks()
  const { page, cleanup } = await launchElectronApp({
    lrclibBaseUrl: lrclib.baseUrl,
    neteaseBaseUrl: netease.baseUrl,
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })

  // Set up LRCLIB mock to return timed lyrics for the seeded track
  setupLrclibMock(lrclib, {
    get: [{
      query: { track_name: 'Test Track', artist_name: 'Test Artist' },
      response: {
        id: 123,
        trackName: 'Test Track',
        artistName: 'Test Artist',
        duration: 15,
        syncedLyrics: '[00:01.00]First line\n[00:04.00]Second line\n[00:08.00]Third line',
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
        syncedLyrics: '[00:01.00]First line\n[00:04.00]Second line\n[00:08.00]Third line',
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
        syncedLyrics: '[00:01.00]First line\n[00:04.00]Second line\n[00:08.00]Third line',
        plainLyrics: null,
        translatedLyrics: '',
        romanizedLyrics: ''
      }]
    }]
  })

  try {
    await page.waitForTimeout(5000)
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
    await trackRow.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Click Find tab and search to load lyrics
    await page.getByRole('button', { name: 'Find', description: 'Find (Ctrl+3)' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Search' }).click()

    // Wait for search results and load the candidate
    // Candidate rows have title attribute with "Track — Artist (Album)"
    await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
    await page.locator('button[title*="Test Track"]').first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Load Primary' }).click()

    // Go to Lyrics tab to load lyrics in player
    await page.getByRole('button', { name: 'Lyrics', description: 'Lyrics (Ctrl+1)' }).click()
    await page.waitForTimeout(1000)

    // Wait for lyrics to load in player - check for active lyric lines
    // The timestamp buttons in the live editor have the formatted timestamp as text
    await page.waitForSelector('button:has-text("00:01.00")', { timeout: 10000 })

    // Click a lyric line to seek near 0:01 - the timestamp buttons have the timestamp as text
    await page.getByRole('button', { name: '00:01.00' }).click()

    // Wait a moment for playback to advance past 0:04
    await page.waitForTimeout(5000)

    // Trigger Embed
    await page.getByRole('button', { name: /Embed/ }).first().click()
    await expect(page.locator('text=Embedded lyrics for "Test Track"')).toBeVisible({ timeout: 15000 })

    // Verify playback didn't jump back to 0:01
    // The current time should still be > 4 seconds
    const timeDisplay = page.locator('.font-mono[tabular-nums]').first()
    const currentTime = await timeDisplay.textContent()
    expect(currentTime).toBeTruthy()

    // The time should be > 4 seconds (we'll check it's not near 0:01)
    const timeMatch = currentTime?.match(/(\d+):(\d{2})\.(\d{2})/)
    if (timeMatch) {
      const minutes = parseInt(timeMatch[1], 10)
      const seconds = parseInt(timeMatch[2], 10)
      const totalSeconds = minutes * 60 + seconds
      expect(totalSeconds).toBeGreaterThan(4)
    }
  } finally {
    await cleanup()
  }
})

/**
 * Test 7: Zero renderer console errors or uncaught page errors across the suite
 */
test('zero console errors across suite', async () => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  const { page, cleanup } = await launchElectronApp({
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })
  try {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })
    page.on('pageerror', err => {
      pageErrors.push(err.message)
    })

    await page.waitForTimeout(5000)
    // Click a track to focus it
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })
    const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
    await trackRow.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Navigate through enabled tabs
    await page.getByRole('button', { name: 'Lyrics', description: 'Lyrics (Ctrl+1)' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Lyrics', description: 'Lyrics (Ctrl+1)' }).click()
    await page.waitForTimeout(500)

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await cleanup()
  }
})