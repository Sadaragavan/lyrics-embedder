import { ChevronDown } from 'lucide-react'

interface LayerTabsProps {
  activeLayer: 'primary' | 'translation' | 'romanization'
  onLayerChange: (layer: 'primary' | 'translation' | 'romanization') => void
  showTranslationLayer: boolean
  showRomanizationLayer: boolean
  onShowTranslationLayerChange: (value: boolean) => void
  onShowRomanizationLayerChange: (value: boolean) => void
}

const layerTabs = [
  { key: 'primary', label: 'Primary' },
  { key: 'translation', label: 'Translation' },
  { key: 'romanization', label: 'Romanization' }
] as const

export function LayerTabs({
  activeLayer,
  onLayerChange,
  showTranslationLayer,
  showRomanizationLayer,
  onShowTranslationLayerChange,
  onShowRomanizationLayerChange
}: LayerTabsProps) {
  return (
    <div className="flex shrink-0 border-b border-zinc-800 bg-zinc-900 px-2 py-1">
      <div className="flex items-center gap-1">
        {layerTabs.map((tab) => {
          const isActive = activeLayer === tab.key
          const isTranslation = tab.key === 'translation'
          const isRomanization = tab.key === 'romanization'
          const shouldShow = isTranslation ? showTranslationLayer : isRomanization ? showRomanizationLayer : true

          if (!shouldShow) return null

          return (
            <button
              key={tab.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onLayerChange(tab.key)}
              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded ${
                isActive
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
        <div className="flex items-center gap-1 ml-2">
          {showTranslationLayer && (
            <button
              type="button"
              aria-pressed={showTranslationLayer}
              onClick={() => onShowTranslationLayerChange(false)}
              title="Hide translation layer"
              className="rounded-full border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
          {showRomanizationLayer && (
            <button
              type="button"
              aria-pressed={showRomanizationLayer}
              onClick={() => onShowRomanizationLayerChange(false)}
              title="Hide romanization layer"
              className="rounded-full border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}