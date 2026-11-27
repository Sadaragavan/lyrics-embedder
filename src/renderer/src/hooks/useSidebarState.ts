import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const SIDEBAR_WIDTH_KEY = 'lyrics-embedder:sidebar-width'
const SIDEBAR_MIN_WIDTH = 280
const SIDEBAR_MAX_WIDTH = 720

function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_MIN_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)))
}

function readStoredSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (!raw) return 460
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : 460
  } catch {
    return 460
  }
}

/**
 * Manages library sidebar width, visibility, and drag state.
 */
export function useSidebarState() {
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredSidebarWidth())

  const dividerDragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const handleDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      dividerDragRef.current = { startX: event.clientX, startWidth: sidebarWidth }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [sidebarWidth]
  )

  const handleDividerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dividerDragRef.current
    if (!drag) return
    const next = drag.startWidth + (event.clientX - drag.startX)
    setSidebarWidth(clampSidebarWidth(next))
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // Storage can be unavailable (private mode)
    }
  }, [sidebarWidth])

  const handleDividerPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dividerDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return {
    sidebarVisible,
    setSidebarVisible,
    sidebarWidth,
    setSidebarWidth,
    dividerDragRef,
    handleDividerPointerDown,
    handleDividerPointerMove,
    handleDividerPointerUp
  }
}