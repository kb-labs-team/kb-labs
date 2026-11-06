import { useState } from 'react'
import DOMPurify from 'dompurify'
import { UIButton } from '@kb-labs/studio-ui-kit';interface Props {
  data: unknown
  editable?: boolean
  onEdit?: (v: unknown) => void
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  pre:     'background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px;overflow:auto;font-size:12px;line-height:1.5;font-family:monospace;margin:8px 0',
  code:    'background:#f0f0f0;border-radius:3px;padding:1px 4px;font-size:0.9em;font-family:monospace',
  link:    'color:var(--link)',
  h1:      'margin:0 0 12px;font-size:17px;font-weight:700;scroll-margin-top:64px',
  h2:      'margin:16px 0 8px;font-size:15px;font-weight:700;scroll-margin-top:64px',
  h3:      'margin:14px 0 6px;font-size:14px;font-weight:600;scroll-margin-top:64px',
  h4:      'margin:12px 0 4px;font-size:13px;font-weight:600;scroll-margin-top:64px',
  ul:      'margin:6px 0;padding-left:20px',
  ol:      'margin:6px 0;padding-left:20px',
  li:      'margin:2px 0',
  hr:      'border:none;border-top:1px solid var(--border-primary);margin:12px 0',
  p:       'margin:6px 0;line-height:1.6',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
}

function anchorLink(id: string, text: string): string {
  return `<a href="#${id}" onclick="event.preventDefault();document.getElementById('${id}')?.scrollIntoView({behavior:'smooth'})" style="${S.link};cursor:pointer">${text}</a>`
}

function externalLink(url: string, text: string): string {
  // Only allow web links; javascript:, data:, and other schemes must not reach
  // the generated anchor even though the surrounding markdown is escaped.
  if (!/^https?:\/\//i.test(url)) return text
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="${S.link}">${text}</a>`
}

function heading(level: 1 | 2 | 3 | 4, text: string): string {
  const id = slugify(text)
  const style = S[`h${level}`]
  return `<h${level} id="${id}" style="${style}">${text}</h${level}>`
}

function listItems(block: string, ordered: boolean): string {
  const itemRe = ordered ? /^[ \t]*\d+\. / : /^[ \t]*[-*+] /
  const items = block.trim().split('\n')
    .map(line => `<li style="${S.li}">${line.replace(itemRe, '')}</li>`)
    .join('')
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag} style="${S[tag]}">${items}</${tag}>`
}

// ── Converter ─────────────────────────────────────────────────────────────────

function mdToHtml(md: string): string {
  // 1. Stash fenced code blocks (preserve verbatim, skip further processing)
  const codeBlocks: string[] = []
  let html = md.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length
    codeBlocks.push(`<pre style="${S.pre}">${escapeHtml(code.replace(/\n$/, ''))}</pre>`)
    return `\x00CODE${idx}\x00`
  })

  // 2. Escape remaining HTML
  html = escapeHtml(html)

  // 3. Inline code
  html = html.replace(/`([^`]+)`/g, (_, c) => `<code style="${S.code}">${c}</code>`)

  // 4. Links (decode &amp; back in href, then route anchor vs external)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, rawHref) => {
    const url = rawHref.replace(/&amp;/g, '&')
    return url.startsWith('#') ? anchorLink(url.slice(1), text) : externalLink(url, text)
  })

  // 5. Headings (h4 first to avoid partial matches)
  html = html.replace(/^#### (.+)$/gm, (_, t) => heading(4, t))
  html = html.replace(/^### (.+)$/gm,  (_, t) => heading(3, t))
  html = html.replace(/^## (.+)$/gm,   (_, t) => heading(2, t))
  html = html.replace(/^# (.+)$/gm,    (_, t) => heading(1, t))

  // 6. Emphasis
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>')

  // 7. Lists
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, block => listItems(block, false))
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm,  block => listItems(block, true))

  // 8. Horizontal rule
  html = html.replace(/^---$/gm, `<hr style="${S.hr}"/>`)

  // 9. Paragraphs (skip blocks that are already block-level HTML or code placeholders)
  html = html.replace(/\n{2,}/g, '\n\n')
  html = html.split('\n\n').map(block => {
    const trimmed = block.trim()
    if (!trimmed) {return ''}
    if (/^(\x00CODE\d+\x00|<(h[1-6]|ul|ol|pre|hr|blockquote))/.test(trimmed)) {return trimmed}
    return `<p style="${S.p}">${trimmed.replace(/\n/g, '<br/>')}</p>`
  }).join('\n')

  // 10. Restore code blocks
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)] ?? '')

  return html
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MarkdownViewer({ data, editable, onEdit }: Props) {
  const text = typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data, null, 2)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(text)

  if (editing && editable) {
    return (
      <div>
        <textarea
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          style={{
            width: '100%', minHeight: 200, fontFamily: 'monospace', fontSize: 13,
            padding: 12, border: '1px solid var(--border-primary)', borderRadius: 6,
            background: 'var(--bg-primary)', color: 'var(--text-primary)',
            resize: 'vertical', boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <UIButton size="small" variant="primary" onClick={() => { onEdit?.(editValue); setEditing(false) }}>Save</UIButton>
          <UIButton size="small" variant="default" onClick={() => { setEditValue(text); setEditing(false) }}>Cancel</UIButton>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      {editable && (
        <UIButton size="small" variant="text" style={{ float: 'right' }} onClick={() => setEditing(true)}>
          Edit
        </UIButton>
      )}
      <div
        style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(mdToHtml(text)) }}
      />
    </div>
  )
}
