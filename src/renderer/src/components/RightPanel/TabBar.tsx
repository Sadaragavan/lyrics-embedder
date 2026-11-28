import { Layers, List, Search } from 'lucide-react'

type TabId = 'lyrics' | 'text' | 'find'

interface TabBarProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  hasTrack: boolean
}

/**
 * Single tab bar for Lyrics | Text | Find.
 */
export function TabBar({ activeTab, onTabChange, hasTrack }: TabBarProps) {
  const tabs: { id: TabId; label: string; icon: React.ReactNode; shortcut: string; disabled?: boolean }[] = [
    { id: 'lyrics', label: 'Lyrics', icon: <List className="h-3 w-3" />, shortcut: 'Ctrl+1' },
    { id: 'text', label: 'Text', icon: <Layers className="h-3 w-3" />, shortcut: 'Ctrl+2', disabled: !hasTrack },
    { id: 'find', label: 'Find', icon: <Search className="h-3 w-3" />, shortcut: 'Ctrl+3', disabled: !hasTrack }
  ]

  return (
    <div
      className="inline-flex overflow-hidden rounded border border-zinc-700 bg-zinc-800"
      role="group"
      aria-label="Workspace mode"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={activeTab === tab.id}
          onClick={() => onTabChange(tab.id)}
          disabled={tab.disabled}
          title={`${tab.label} (${tab.shortcut})${tab.disabled ? ' — no track focused' : ''}`}
          className={`${index > 0 ? 'border-l border-zinc-700 ' : ''}flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium ${
            activeTab === tab.id
              ? 'bg-zinc-700 text-zinc-100'
              : tab.disabled
                ? 'text-zinc-600 cursor-not-allowed'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}