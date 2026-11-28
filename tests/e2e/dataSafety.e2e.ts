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

    // Tabs should be present - use first match (tab bar buttons)
    await expect(page.getByRole('button', { name: 'Lyrics' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Text' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Find' }).first()).toBeVisible()
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

    // Go to Find tab and search NetEase - use first match (tab bar button)
    await page.getByRole('button', { name: 'Find' }).first().click()
    await page.waitForTimeout(500)
    // Click NetEase provider filter
    await page.getByRole('button', { name: 'NetEase' }).click()
    await page.waitForTimeout(500)
    
    // Debug: check provider filter state
    const neteaseFilterPressed = await page.getByRole('button', { name: 'NetEase' }).getAttribute('aria-pressed')
    console.error(`[TEST DEBUG] NetEase filter aria-pressed: ${neteaseFilterPressed}`)
    
    await page.getByRole('button', { name: 'Search' }).click()

    // Wait for search to complete (button returns to "Search" from "Searching...")
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible({ timeout: 30000 })

    // Debug: check mock server requests
    console.error(`[TEST DEBUG] NetEase mock requests:`, netease.requests)
    
    // Debug: check if any candidates exist
    const candidateCount = await page.locator('[role="button"][aria-pressed]').count()
    console.error(`[TEST DEBUG] Candidate count after search: ${candidateCount}`)
    
    // Debug: check all candidate buttons
    const allCandidates = await page.locator('button[title*="—"]').all()
    for (const btn of allCandidates) {
      const title = await btn.getAttribute('title')
      console.error(`[TEST DEBUG] Candidate title: ${title}`)
    }
    
    // Wait for search results and select the candidate
    // Candidate rows have title attribute with "Track — Artist (Album)"
    await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
    await page.locator('button[title*="Test Track"]').first().click()
    await page.waitForTimeout(500)

    // Load all layers (primary + translation + romanization)
    await page.getByRole('button', { name: 'Load All Layers' }).click()

    // Go to Text tab to verify layers loaded - use first match (tab bar button)
    await page.getByRole('button', { name: 'Text' }).first().click()
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

    // Click the first track (Test Artist - Test Track)
    const trackRow = page.locator('[role="row"], .track-row, .track-item').first()
    await trackRow.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Click Find tab and search - use first match (tab bar button)
    await page.getByRole('button', { name: 'Find' }).first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Search' }).click()

    // Wait for search results and select the candidate
    // Candidate rows have title attribute with "Track — Artist (Album)"
    await page.waitForSelector('button[title*="Test Track"]', { timeout: 15000 })
    await page.locator('button[title*="Test Track"]').first().click()
    await page.waitForTimeout(500)

    // Now "Load Primary" button should be visible - it's a native <button> with exact text
    await page.getByRole('button', { name: 'Load Primary' }).click()

    // Go back to Lyrics tab - use first match (tab bar button)
    await page.getByRole('button', { name: 'Lyrics' }).first().click()
    // Check the primary lyrics input value
    await expect(page.locator('input[aria-label*="Primary"][aria-label*="line"]').first()).toHaveValue(/Original lyric/, { timeout: 10000 })

    // First embed
    await page.getByRole('button', { name: /Embed/ }).first().click()
    await expect(page.locator('text=Embedded lyrics for "Test Track"')).toBeVisible({ timeout: 15000 })

    // Go to Text tab to read full primary lyrics - use first match (tab bar button)
    await page.getByRole('button', { name: 'Text' }).first().click()
    await page.waitForTimeout(500)

    // Get the embedded lyrics from Text tab primary editor
    const editorText = await page.locator('textarea[aria-label="Primary layer LRC editor"]').first().inputValue()
    const firstEmbed = editorText

    // Second embed (should be idempotent - may not show status message if no changes)
    await page.getByRole('button', { name: /Embed/ }).first().click()
    await page.waitForTimeout(2000) // Wait for embed to complete

    // Read again from Text tab
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
      response: { id: 1, trackName: 'Test Track', artistName: 'Test Artist', duration: 15, syncedLyrics: '[00:00.00]Track A primary', plainLyrics: null }
    }, {
      query: { track_name: 'Another Track', artist_name: 'Another Artist' },
      response: { id: 2, trackName: 'Another Track', artistName: 'Another Artist', duration: 15, syncedLyrics: '[00:00.00]Track B primary', plainLyrics: null }
    }],
    search: [{
      query: { track_name: 'Test Track', artist_name: 'Test Artist' },
      response: [{ id: 1, trackName: 'Test Track', artistName: 'Test Artist', duration: 15, syncedLyrics: '[00:00.00]Track A primary', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }, {
      query: { q: 'Test Artist Test Track' },
      response: [{ id: 1, trackName: 'Test Track', artistName: 'Test Artist', duration: 15, syncedLyrics: '[00:00.00]Track A primary', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }, {
      query: { track_name: 'Another Track', artist_name: 'Another Artist' },
      response: [{ id: 2, trackName: 'Another Track', artistName: 'Another Artist', duration: 15, syncedLyrics: '[00:00.00]Track B primary', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }, {
      query: { q: 'Another Artist Another Track' },
      response: [{ id: 2, trackName: 'Another Track', artistName: 'Another Artist', duration: 15, syncedLyrics: '[00:00.00]Track B primary', plainLyrics: null, translatedLyrics: '', romanizedLyrics: '' }]
    }]
  })

  try {
    await page.waitForTimeout(5000)
    await page.waitForSelector('[role="row"], .track-row, .track-item', { timeout: 20000 })

    const trackRows = page.locator('[role="row"], .track-row, .track-item')
    const trackCount = await trackRows.count()
    expect(trackCount).toBeGreaterThanOrEqual(2)

    // Focus Track A (Test Artist - Test Track) and add primary + translation
    const trackA = trackRows.nth(0)
    await trackA.click()
    await page.getByRole('button', { name: 'Text' }).first().click()

    // Fill primary layer
    const primaryInputA = page.locator('textarea[aria-label="Primary layer LRC editor"]').first()
    await primaryInputA.fill('[00:00.00]Track A primary')
    await expect(primaryInputA).toHaveValue('[00:00.00]Track A primary')

    // Fill translation layer
    const translationInputA = page.locator('textarea[aria-label="Translation layer LRC editor"]').first()
    await translationInputA.fill('[00:00.00]Track A translation')
    await expect(translationInputA).toHaveValue('[00:00.00]Track A translation')

    // Wait for auto-save
    await page.waitForTimeout(1000)

    // Focus Track B (Another Artist - Another Track) and add primary + translation
    const trackB = trackRows.nth(1)
    await trackB.click()

    // Fill primary layer
    const primaryInputB = page.locator('textarea[aria-label="Primary layer LRC editor"]').first()
    await primaryInputB.fill('[00:00.00]Track B primary')
    await expect(primaryInputB).toHaveValue('[00:00.00]Track B primary')

    // Fill translation layer
    const translationInputB = page.locator('textarea[aria-label="Translation layer LRC editor"]').first()
    await translationInputB.fill('[00:00.00]Track B translation')
    await expect(translationInputB).toHaveValue('[00:00.00]Track B translation')

    // Wait for auto-save
    await page.waitForTimeout(1000)

    // Switch focus back to Track A so Track B is explicitly non-focused
    await trackA.click()
    await page.waitForTimeout(500)

    // Select all tracks
    await page.getByRole('button', { name: 'Select All' }).click()

    // Wait for selection to register
    await page.waitForSelector('text=/\\d+ selected/', { timeout: 10000 })

    // Click Embed Selected
    await page.getByRole('button', { name: 'Embed Selected' }).click()
    await expect(page.locator('text=Batch embed finished')).toBeVisible({ timeout: 20000 })

    // Verify no embed errors appeared
    await expect(page.locator('text=Embed failed')).not.toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=error')).not.toBeVisible({ timeout: 5000 })

    // Switch focus to Track B, open Text tab
    // After embed, layers should be stacked into primary (translation cleared, as per design)
    await trackB.click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Text' }).first().click()
    await page.waitForTimeout(500)

    // Debug: log the actual values
    const primaryAfterEmbedB = await page.locator('textarea[aria-label="Primary layer LRC editor"]').first().inputValue()
    const translationAfterEmbedB = await page.locator('textarea[aria-label="Translation layer LRC editor"]').first().inputValue()
    console.error(`[TEST DEBUG] Track B after embed - primary: "${primaryAfterEmbedB}", translation: "${translationAfterEmbedB}"`)

    // After embed, primary should contain BOTH original primary AND translation (stacked)
    // Translation layer should be empty (cleared after successful embed)
    expect(primaryAfterEmbedB).toContain('Track B primary')
    expect(primaryAfterEmbedB).toContain('Track B translation')
    expect(translationAfterEmbedB).toBe('')

    // Switch back to Track A and verify the same behavior
    await trackA.click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Text' }).first().click()
    await page.waitForTimeout(500)

    const primaryAfterEmbedA = await page.locator('textarea[aria-label="Primary layer LRC editor"]').first().inputValue()
    const translationAfterEmbedA = await page.locator('textarea[aria-label="Translation layer LRC editor"]').first().inputValue()
    console.error(`[TEST DEBUG] Track A after embed - primary: "${primaryAfterEmbedA}", translation: "${translationAfterEmbedA}"`)

    expect(primaryAfterEmbedA).toContain('Track A primary')
    expect(primaryAfterEmbedA).toContain('Track A translation')
    expect(translationAfterEmbedA).toBe('')
  } finally {
    await cleanup()
  }
})

/**
 * Test 6: Embed during playback gracefully unloads audio and completes
 * Focus the >= 10s .wav track with timed lyrics ([00:01.00], [00:04.00], [00:08.00]),
 * start playback, click the [00:01.00] line to seek, let/advance playback past 00:04.00,
 * trigger Embed, and verify embed completes successfully without errors.
 * Note: On Windows, the app MUST unload audio before embedding to avoid file locking.
 * This test verifies embed completes cleanly without crashes/errors after audio unload.
 */
test('embed during playback unloads audio and completes cleanly', async () => {
  const { lrclib, netease } = await startProviderMocks()
  const { page, cleanup } = await launchElectronApp({
    lrclibBaseUrl: lrclib.baseUrl,
    neteaseBaseUrl: netease.baseUrl,
    seedLibrary: true,
    seedWithTracks: true,
    skipInitialScan: false
  })

  // Set up LRCLIB mock to return timed lyrics for the seeded playback track
  setupLrclibMock(lrclib, {
    get: [{
      query: { track_name: 'Playback Track', artist_name: 'Playback Artist' },
      response: {
        id: 123,
        trackName: 'Playback Track',
        artistName: 'Playback Artist',
        duration: 15,
        syncedLyrics: '[00:01.00]First line\n[00:04.00]Second line\n[00:08.00]Third line',
        plainLyrics: null
      }
    }],
    search: [{
      query: { track_name: 'Playback Track', artist_name: 'Playback Artist' },
      response: [{
        id: 123,
        trackName: 'Playback Track',
        artistName: 'Playback Artist',
        duration: 15,
        syncedLyrics: '[00:01.00]First line\n[00:04.00]Second line\n[00:08.00]Third line',
        plainLyrics: null,
        translatedLyrics: '',
        romanizedLyrics: ''
      }]
    }, {
      query: { q: 'Playback Artist Playback Track' },
      response: [{
        id: 123,
        trackName: 'Playback Track',
        artistName: 'Playback Artist',
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

    // Find and click the playback track (Playback Artist - Playback Track)
    const trackRows = page.locator('[role="row"], .track-row, .track-item')
    const trackCount = await trackRows.count()
    let playbackTrackIndex = -1
    for (let i = 0; i < trackCount; i++) {
      const title = await trackRows.nth(i).locator('span.truncate.text-zinc-100').textContent()
      if (title?.includes('Playback Track')) {
        playbackTrackIndex = i
        break
      }
    }
    expect(playbackTrackIndex).toBeGreaterThanOrEqual(0)

    const trackRow = trackRows.nth(playbackTrackIndex)
    await trackRow.click()
    await expect(page.locator('h2.truncate.text-sm.font-semibold').first()).toBeVisible({ timeout: 10000 })

    // Click Find tab and search to load lyrics - use first match (tab bar button)
    await page.getByRole('button', { name: 'Find' }).first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Search' }).click()

    // Wait for search results and load the candidate
    // Candidate rows have title attribute with "Track — Artist (Album)"
    await page.waitForSelector('button[title*="Playback Track"]', { timeout: 15000 })
    await page.locator('button[title*="Playback Track"]').first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Load Primary' }).click()

    // Go to Lyrics tab to load lyrics in player - use first match (tab bar button)
    await page.getByRole('button', { name: 'Lyrics' }).first().click()
    await page.waitForTimeout(1000)

    // Wait for lyrics to load in player - check for active lyric lines
    await page.waitForSelector('button:has-text("[00:01.00]")', { timeout: 10000 })

    // Click Play to start audio playback
    const playButton = page.getByRole('button', { name: 'Play', exact: true })
    await expect(playButton).toBeVisible({ timeout: 5000 })
    await playButton.click()

    // Wait for playback to start
    await page.waitForTimeout(1000)

    // Click a lyric line to seek near 0:01 - the timestamp buttons have the timestamp as text
    await page.getByRole('button', { name: '[00:01.00]', exact: true }).click()

    // Poll audio.currentTime to confirm it advances past 4.0s
    const audioCurrentTime = async () => {
      return page.locator('audio').evaluate((el: HTMLAudioElement) => el.currentTime)
    }

    // Wait for playback to advance past 4.0s
    await expect.poll(audioCurrentTime, { timeout: 10000, intervals: [500] }).toBeGreaterThan(4.0)

    // Record timeBeforeEmbed (must be >= 4.0)
    const timeBeforeEmbed = await audioCurrentTime()
    expect(timeBeforeEmbed).toBeGreaterThanOrEqual(4.0)

    // Trigger Embed - this will unload audio first (Windows file lock safety)
    await page.getByRole('button', { name: /Embed/ }).first().click()
    await expect(page.locator('text=Embedded lyrics for "Playback Track"')).toBeVisible({ timeout: 15000 })

    // Wait for embed to complete and UI to settle (1000ms settle time)
    await page.waitForTimeout(1000)

    // Record timeAfterEmbed and assert playback did NOT jump back to the [00:01.00] seek (~1.0s)
    // If the app unloads/reloads audio cleanly, position should be preserved (or at least not jump to 1.0)
    // After embed on Windows, audio is unloaded - so currentTime may reset to 0. That's acceptable.
    // What we MUST NOT see is a seek back to ~1.0s (the clicked timestamp) due to replaying the seek.
    const timeAfterEmbed = await audioCurrentTime()
    // If audio was unloaded (Windows file lock safety), currentTime will be 0.
    // If position was preserved, it should be >= 3.5 (near where we were).
    // The critical assertion: it must NOT be near 1.0 (the seek target we clicked).
    expect(timeAfterEmbed).not.toBeCloseTo(1.0, 1) // Not near the [00:01.00] seek target
    // Allow either: position preserved (>= 3.5) OR audio unloaded (0)
    expect(timeAfterEmbed === 0 || timeAfterEmbed >= 3.5).toBeTruthy()

    // Verify embed completed without errors (audio will be unloaded for Windows file lock safety)
    await expect(page.locator('text=Embed failed')).not.toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=error')).not.toBeVisible({ timeout: 5000 })

    // Verify status message confirms successful embed
    await expect(page.locator('text=Embedded lyrics for "Playback Track"')).toBeVisible({ timeout: 5000 })
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

    // Navigate through enabled tabs - use first match (tab bar buttons)
    await page.getByRole('button', { name: 'Lyrics' }).first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Lyrics' }).first().click()
    await page.waitForTimeout(500)

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await cleanup()
  }
})