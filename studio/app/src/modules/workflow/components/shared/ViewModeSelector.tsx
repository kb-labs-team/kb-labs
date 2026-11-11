/**
 * Generic view mode selector — segmented control for switching between views.
 * Used on both runs list page and run detail page.
 */

interface ViewDef {
  label: string
  icon?: string
}

interface ViewModeSelectorProps<T extends string> {
  views: Record<T, ViewDef>
  current: T
  onChange: (mode: T) => void
}

export function ViewModeSelector<T extends string>({
  views,
  current,
  onChange,
}: ViewModeSelectorProps<T>) {
  const entries = Object.entries(views) as [T, ViewDef][]

  return (
    <div style={{
      display: 'flex',
      gap: 0,
      border: '1px solid var(--border-primary)',
      borderRadius: 6,
      overflow: 'hidden',
    }}>
      {entries.map(([key, def]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          style={{
            padding: '5px 16px',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            border: 'none',
            background: current === key ? 'var(--link)' : 'var(--bg-secondary)',
            color: current === key ? 'var(--text-inverse)' : 'var(--text-secondary)',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          {def.label}
        </button>
      ))}
    </div>
  )
}
