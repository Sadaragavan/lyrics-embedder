import { useEffect, useRef, useState } from 'react'

interface PopoverProps {
  label: string
  title: string
  icon: React.ReactNode
  disabled?: boolean
  children: (close: () => void) => React.ReactNode
  align?: 'left' | 'right'
}

export function Popover({ label, title, icon, disabled, children, align = 'left' }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {icon}
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 w-64 space-y-1.5 rounded-md border border-zinc-700 bg-zinc-900 p-2 shadow-xl shadow-black/50 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

// Need to import ChevronDown
import { ChevronDown } from 'lucide-react'