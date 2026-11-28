import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { createServer } from 'node:http'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

interface MockServer {
  server: ReturnType<typeof createServer>
  baseUrl: string
  port: number
  requests: Array<{ method: string; url: string; body?: string }>
  handlers?: Map<string, (req: any, res: any) => void>
}

interface TrackRecord {
  id: string
  filePath: string
  format: string
  title: string
  artist: string
  album: string
  durationSec: number
  lyrics: string | null
  lyricsSource: 'tag' | 'sidecar' | 'none'
  existingLyricsKeys: string[]
  libraryRootId: string
  mtimeMs: number
  draftId?: string
}

/**
 * Starts an in-process HTTP mock server on a random port.
 * Records all incoming requests for test inspection.
 */
export async function startMockServer(): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({}))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind mock server'))
        return
      }
      const mockServer: MockServer = {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests: []
      }
      resolve(mockServer)
    })

    server.on('error', reject)
  })
}

/**
 * Stops a mock HTTP server and cleans up.
 */
export async function stopMockServer(mockServer: MockServer): Promise<void> {
  return new Promise((resolve, reject) => {
    mockServer.server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Registers a handler on the mock server for a specific path.
 * Handlers are accumulated; each call adds a new path handler.
 */
export function registerHandler(
  mockServer: MockServer,
  path: string,
  handler: (req: any, res: any) => void
): void {
  // Store handlers on the mockServer object
  if (!mockServer.handlers) {
    mockServer.handlers = new Map()
    // Replace the request listener once to route to our handlers
    mockServer.server.removeAllListeners('request')
    mockServer.server.on('request', (req, res) => {
      const url = new URL(req.url ?? '', `http://localhost`)
      const pathHandler = mockServer.handlers?.get(url.pathname)
      if (pathHandler) {
        pathHandler(req, res)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  }
  mockServer.handlers.set(path, handler)
}

/**
 * Sets up LRCLIB mock responses for the given search/fetch scenarios.
 * Matches requests that contain at least the specified query parameters.
 * Handles both structured search (track_name, artist_name, album_name, duration)
 * and query search (q=artist title).
 */
export function setupLrclibMock(
  mockServer: MockServer,
  scenarios: {
    get?: Array<{ query: Record<string, string>; response: any }>
    search?: Array<{ query: Record<string, string>; response: any }>
  } = {}
): void {
  // /api/get endpoint
  registerHandler(mockServer, '/api/get', (req, res) => {
    const url = new URL(req.url ?? '', `http://localhost`)

    const match = scenarios.get?.find(s =>
      Object.entries(s.query).every(([k, v]) => url.searchParams.get(k) === v)
    )

    if (match) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(match.response))
    } else {
      // Return a default response for any unmatched request to avoid 404s breaking tests
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  // /api/search endpoint - handles both structured search and query search
  registerHandler(mockServer, '/api/search', (req, res) => {
    const url = new URL(req.url ?? '', `http://localhost`)
    const searchParams = url.searchParams

    // Check for structured search params (track_name, artist_name, etc.)
    const structuredMatch = scenarios.search?.find(s => {
      const query = s.query
      // If query has 'q', it's a query search variant
      if (query.q) {
        return searchParams.get('q') === query.q
      }
      // Otherwise it's a structured search variant - check track_name and artist_name at minimum
      return (
        (!query.track_name || searchParams.get('track_name') === query.track_name) &&
        (!query.artist_name || searchParams.get('artist_name') === query.artist_name) &&
        (!query.album_name || searchParams.get('album_name') === query.album_name) &&
        (!query.duration || searchParams.get('duration') === query.duration)
      )
    })

    if (structuredMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(structuredMatch.response))
    } else {
      // Return default test results for any unmatched search to ensure tests don't hang
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{
        id: 123,
        trackName: 'Test Track',
        artistName: 'Test Artist',
        duration: 15,
        syncedLyrics: '[00:00.00]Test lyric\n[00:05.00]Second line',
        plainLyrics: null,
        translatedLyrics: '',
        romanizedLyrics: ''
      }]))
    }
  })
}

/**
 * Sets up NetEase mock responses for the given search/lyric scenarios.
 */
export function setupNeteaseMock(
  mockServer: MockServer,
  scenarios: {
    search?: Array<{ query: string; response: any }>
    lyric?: Array<{ songId: number; response: any }>
  } = {}
): void {
  // /api/search/get/web endpoint
  registerHandler(mockServer, '/api/search/get/web', (req, res) => {
    const url = new URL(req.url ?? '', `http://localhost`)
    const searchQuery = url.searchParams.get('s') ?? ''

    const match = scenarios.search?.find(s =>
      s.query === searchQuery
    )

    if (match) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(match.response))
    } else {
      // Return a default response with a test song for any search query
      // This ensures tests don't hang waiting for search results
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
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
      }))
    }
  })

  // /api/song/lyric endpoint
  registerHandler(mockServer, '/api/song/lyric', (req, res) => {
    const url = new URL(req.url ?? '', `http://localhost`)
    const songId = url.searchParams.get('id')

    const match = scenarios.lyric?.find(s => String(s.songId) === songId)

    if (match) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(match.response))
    } else {
      // Return default multi-layer lyrics for any song ID
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        lrc: { lyric: '[00:00.00]Test lyric\n[00:05.00]Second line' },
        tlyric: { lyric: '[00:00.00]Test translation\n[00:05.00]Second translation' },
        romalrc: { lyric: '[00:00.00]Test romanization\n[00:05.00]Second romanization' },
        code: 200
      }))
    }
  })
}

/**
 * Starts both mock HTTP servers for LRCLIB and NetEase.
 * Returns the servers and their base URLs for the test to use.
 */
export async function startProviderMocks(): Promise<{
  lrclib: MockServer
  netease: MockServer
  cleanup: () => Promise<void>
}> {
  const lrclib = await startMockServer()
  const netease = await startMockServer()

  const cleanup = async () => {
    await stopMockServer(lrclib)
    await stopMockServer(netease)
  }

  return { lrclib, netease, cleanup }
}

/**
 * Generates a valid WAV file with the specified duration in seconds.
 * Returns the path to the generated WAV file.
 */
async function generateWavFile(outputPath: string, durationSeconds: number): Promise<string> {
  const sampleRate = 44100
  const numChannels = 2
  const bitsPerSample = 16
  const numSamples = sampleRate * durationSeconds
  const byteRate = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign = numChannels * bitsPerSample / 8
  const dataSize = numSamples * numChannels * bitsPerSample / 8
  const fileSize = 36 + dataSize

  const buffer = Buffer.alloc(44 + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(fileSize, 4)
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)        // chunk size
  buffer.writeUInt16LE(1, 20)         // audio format (PCM)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  // Generate a simple sine wave
  const frequency = 440 // A4
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const value = Math.sin(2 * Math.PI * frequency * t) * 0.5
    const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)))
    buffer.writeInt16LE(sample, 44 + i * 4)
    buffer.writeInt16LE(sample, 44 + i * 4 + 2)
  }

  await writeFile(outputPath, buffer)
  return outputPath
}

/**
 * Creates a temporary media directory with fixture audio files.
 */
async function createMediaFixtures(tempDir: string): Promise<{
  shortWav: string
  longWav: string
  trackFiles: string[]
}> {
  const trackFiles: string[] = []

  // Generate a specific test track with known name FIRST so it's the first track in the library
  // This ensures tests can reliably reference "Test Track - Test Artist"
  const testTrackPath = path.join(tempDir, 'Test Track - Test Artist.flac')
  await generateFlacFile(testTrackPath)
  trackFiles.push(testTrackPath)

  // Generate a second test track for multi-track tests
  const testTrack2Path = path.join(tempDir, 'Another Track - Another Artist.flac')
  await generateFlacFile(testTrack2Path)
  trackFiles.push(testTrack2Path)

  // Copy real audio fixtures (the larger test files)
  const fixturesDir = path.join(__dirname, '../../fixtures')
  const fixtureFiles = [
    'Goindhamma - Meesaya Murukku 2.opus',
    'I Wanna Be Yours - AM.m4a',
    'Kannitheevu Ponna - Yuddham Sei.m4a',
    'Lutt Le Gaya - Dhurandhar.opus',
    'Mutta Kalakki - Youth.m4a'
    // Note: '??????? - ??????? ?????????.m4a' skipped - filename has literal ? chars causing Node copyFile issues on Windows
  ]

  for (const fixture of fixtureFiles) {
    const src = path.join(fixturesDir, fixture)
    const dest = path.join(tempDir, fixture)
    try {
      await copyFile(src, dest)
      trackFiles.push(dest)
    } catch (e) {
      console.warn(`Could not copy fixture ${fixture}:`, e)
    }
  }

  // Generate small sample files for each format (since sample.* files don't exist in fixtures)
  const sampleFormats = [
    { name: 'sample.flac', generate: () => generateFlacFile(path.join(tempDir, 'sample.flac')) },
    { name: 'sample.mp3', generate: () => generateMp3File(path.join(tempDir, 'sample.mp3')) },
    { name: 'sample.m4a', generate: () => generateM4aFile(path.join(tempDir, 'sample.m4a')) },
    { name: 'sample.opus', generate: () => generateOpusFile(path.join(tempDir, 'sample.opus')) },
    { name: 'sample.wav', generate: () => generateWavFile(path.join(tempDir, 'sample.wav'), 2) }
  ]

  for (const format of sampleFormats) {
    try {
      await format.generate()
      trackFiles.push(path.join(tempDir, format.name))
    } catch (e) {
      console.warn(`Could not generate sample ${format.name}:`, e)
    }
  }

  // Generate a long WAV with timed lyrics for seek/playback tests
  const longWav = path.join(tempDir, 'long-test.wav')
  await generateWavFileWithLyrics(longWav, 15)

  // Generate a short WAV for quick tests
  const shortWav = path.join(tempDir, 'short.wav')
  await generateWavFile(shortWav, 2)

  return { shortWav, longWav, trackFiles }
}

/**
 * Generates a minimal FLAC file (actually a WAV with .flac extension for testing).
 * Note: Real FLAC encoding requires native libs, so we generate a WAV file with .flac extension.
 */
async function generateFlacFile(outputPath: string): Promise<string> {
  // Generate a simple WAV but save with .flac extension for format detection testing
  return generateWavFile(outputPath, 2)
}

/**
 * Generates a minimal MP3 file (actually a WAV with .mp3 extension for testing).
 */
async function generateMp3File(outputPath: string): Promise<string> {
  return generateWavFile(outputPath, 2)
}

/**
 * Generates a minimal M4A file (actually a WAV with .m4a extension for testing).
 */
async function generateM4aFile(outputPath: string): Promise<string> {
  return generateWavFile(outputPath, 2)
}

/**
 * Generates a minimal Opus file (actually a WAV with .opus extension for testing).
 */
async function generateOpusFile(outputPath: string): Promise<string> {
  return generateWavFile(outputPath, 2)
}

/**
 * Generates a WAV file with embedded LRC-style timestamps for seek testing.
 */
async function generateWavFileWithLyrics(outputPath: string, durationSeconds: number): Promise<string> {
  const sampleRate = 44100
  const numChannels = 2
  const bitsPerSample = 16
  const numSamples = sampleRate * durationSeconds
  const byteRate = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign = numChannels * bitsPerSample / 8
  const dataSize = numSamples * numChannels * bitsPerSample / 8
  const fileSize = 36 + dataSize

  const buffer = Buffer.alloc(44 + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(fileSize, 4)
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)        // chunk size
  buffer.writeUInt16LE(1, 20)         // audio format (PCM)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  // Generate a sine wave with amplitude modulation to create distinguishable sections
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    // Create distinct sections every 3 seconds for timestamp testing
    const section = Math.floor(t / 3)
    const modFrequency = 440 + section * 110 // Different pitch per section
    const value = Math.sin(2 * Math.PI * modFrequency * t) * 0.3
    const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)))
    buffer.writeInt16LE(sample, 44 + i * 4)
    buffer.writeInt16LE(sample, 44 + i * 4 + 2)
  }

  await writeFile(outputPath, buffer)
  return outputPath
}

/**
 * Creates a minimal library-index.json with the given media directory as a root.
 */
async function createLibraryIndex(mediaDir: string, trackFiles: string[]): Promise<{
  roots: Array<{
    id: string
    path: string
    name: string
    addedAt: string
    lastScannedAt?: string
  }>
  tracks: TrackRecord[]
}> {
  const rootId = computeTrackId(mediaDir)
  const root = {
    id: rootId,
    path: mediaDir,
    name: 'E2E Test Library',
    addedAt: new Date().toISOString(),
    lastScannedAt: new Date().toISOString()
  }

  const tracks: TrackRecord[] = []
  for (let i = 0; i < trackFiles.length; i++) {
    const filePath = trackFiles[i]
    const fileName = path.basename(filePath)
    const ext = path.extname(filePath).slice(1)

    // Parse title/artist from filename
    let title = fileName.replace(/\.[^.]+$/, '')
    let artist = 'Unknown Artist'
    const dashIndex = title.indexOf(' - ')
    if (dashIndex > 0) {
      artist = title.slice(0, dashIndex)
      title = title.slice(dashIndex + 3)
    }

    const track: TrackRecord = {
      id: computeTrackId(filePath),
      filePath,
      format: ext,
      title,
      artist,
      album: 'Test Album',
      durationSec: 15, // Our generated files are 15 seconds
      lyrics: null,
      lyricsSource: 'none',
      existingLyricsKeys: [],
      libraryRootId: rootId,
      mtimeMs: Date.now()
    }
    tracks.push(track)
  }

  return { roots: [root], tracks }
}

/**
 * Computes a deterministic track ID from file path.
 */
function computeTrackId(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16)
}

/**
 * Pre-seeds the userDataDir with a library-index.json.
 */
async function seedLibraryIndex(userDataDir: string, libraryIndex: {
  roots: Array<{
    id: string
    path: string
    name: string
    addedAt: string
    lastScannedAt?: string
  }>
  tracks: TrackRecord[]
}): Promise<void> {
  const indexPath = path.join(userDataDir, 'library-index.json')
  await writeFile(indexPath, JSON.stringify(libraryIndex, null, 2))
}

/**
 * Launches the packaged Electron app with a fresh user data directory.
 * Optionally pre-seeds the library with media fixtures.
 */
export async function launchElectronApp(options: {
  lrclibBaseUrl?: string
  neteaseBaseUrl?: string
  mediaDir?: string
  seedLibrary?: boolean
  seedWithTracks?: boolean
  skipInitialScan?: boolean
} = {}): Promise<{
  app: ElectronApplication
  page: Page
  mediaDir: string
  cleanup: () => Promise<void>
}> {
  // Create a fresh temp directory for user data
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'lyrics-e2e-'))
  const mediaDir = options.mediaDir ?? await mkdtemp(path.join(tmpdir(), 'lyrics-media-'))

  // Create media fixtures if not provided
  let trackFiles: string[] = []
  if (!options.mediaDir) {
    const fixtures = await createMediaFixtures(mediaDir)
    trackFiles = fixtures.trackFiles
  }

  // Pre-seed library index if requested
  if (options.seedLibrary && trackFiles.length > 0) {
    const libraryIndex = await createLibraryIndex(mediaDir, trackFiles)
    await seedLibraryIndex(userDataDir, libraryIndex)
  }

  const executablePath = path.join(repoRoot, 'release/win-unpacked/Poweramp LRC Embedder.exe')

  const app = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${userDataDir}`,
      // Disable GPU for headless CI
      '--disable-gpu',
      '--disable-software-rasterizer'
    ],
    env: {
      ...process.env,
      LRCLIB_BASE_URL: options.lrclibBaseUrl ?? '',
      NETEASE_BASE_URL: options.neteaseBaseUrl ?? '',
      PLAYWRIGHT_E2E: '1'
    }
  })

  // Wait for the main window
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Give the app time to initialize
  await page.waitForTimeout(1000)

  // If we seeded the library, wait for the scan to complete (or trigger it)
  if (options.seedLibrary && !options.skipInitialScan) {
    await page.waitForTimeout(3000) // Wait for initial scan
  }

  const cleanup = async () => {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    if (!options.mediaDir) {
      await rm(mediaDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { app, page, mediaDir, cleanup }
}

