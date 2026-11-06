export function LinkViewer({ data, label }: { data: unknown; label?: string }) {
  const url = typeof data === 'string' ? data : null

  if (!url) {
    return (
      <span style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 12 }}>—</span>
    )
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 12px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 6,
        fontSize: 13,
        color: 'var(--link)',
        textDecoration: 'none',
        fontWeight: 500,
      }}
    >
      {label ?? url}
      <span style={{ fontSize: 11, opacity: 0.6 }}>↗</span>
    </a>
  )
}
