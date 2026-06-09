import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  content: string
}

// Detect and render Vega-Lite chart specs embedded in agent responses
function VegaChart({ spec }: { spec: object }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    import('vega-embed').then(({ default: embed }) => {
      embed(ref.current!, spec as never, {
        theme: 'dark',
        actions: false,
        renderer: 'svg',
        config: {
          background: 'transparent',
          view: { fill: 'transparent' },
          axis: { labelColor: '#ccc', titleColor: '#ccc', gridColor: '#333', domainColor: '#555' },
          legend: { labelColor: '#ccc', titleColor: '#ccc' },
          title: { color: '#eee' },
        },
      }).catch(console.error)
    })
  }, [spec])

  return (
    <div
      ref={ref}
      style={{ margin: '8px 0', maxWidth: '100%', overflow: 'hidden', borderRadius: 6 }}
    />
  )
}

// Extract Vega-Lite specs from markdown content
function parseContent(content: string): Array<{ type: 'text' | 'chart'; value: string | object }> {
  const parts: Array<{ type: 'text' | 'chart'; value: string | object }> = []
  // Match JSON blocks that look like Vega-Lite specs
  const vegaPattern = /```(?:json|vega-lite)?\n?(\{[\s\S]*?"(?:\$schema|mark|layer|encoding)"[\s\S]*?\})\n?```/g
  let last = 0
  let m: RegExpExecArray | null

  while ((m = vegaPattern.exec(content)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', value: content.slice(last, m.index) })
    }
    try {
      const spec = JSON.parse(m[1])
      parts.push({ type: 'chart', value: spec })
    } catch {
      parts.push({ type: 'text', value: m[0] })
    }
    last = m.index + m[0].length
  }

  if (last < content.length) {
    parts.push({ type: 'text', value: content.slice(last) })
  }

  return parts.length ? parts : [{ type: 'text', value: content }]
}

const mdComponents = {
  // Style markdown elements to match dark theme
  p: ({ children }: { children?: React.ReactNode }) => (
    <p style={{ margin: '4px 0', lineHeight: 1.5 }}>{children}</p>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 style={{ fontSize: 14, fontWeight: 700, margin: '8px 0 4px', color: 'var(--accent)' }}>{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 style={{ fontSize: 13, fontWeight: 700, margin: '6px 0 3px', color: 'var(--accent)' }}>{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 style={{ fontSize: 12, fontWeight: 700, margin: '5px 0 2px' }}>{children}</h3>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul style={{ paddingLeft: 16, margin: '4px 0' }}>{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol style={{ paddingLeft: 16, margin: '4px 0' }}>{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li style={{ margin: '2px 0' }}>{children}</li>
  ),
  code: ({ inline, children }: { inline?: boolean; children?: React.ReactNode }) =>
    inline
      ? <code style={{ background: 'rgba(255,255,255,0.1)', padding: '1px 4px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace' }}>{children}</code>
      : <pre style={{ background: 'rgba(255,255,255,0.07)', padding: '8px', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', overflowX: 'auto', margin: '4px 0' }}><code>{children}</code></pre>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div style={{ overflowX: 'auto', margin: '6px 0' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th style={{ border: '1px solid #444', padding: '3px 8px', background: 'rgba(255,255,255,0.1)', textAlign: 'left' }}>{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td style={{ border: '1px solid #333', padding: '3px 8px' }}>{children}</td>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong style={{ color: '#e0e0ff' }}>{children}</strong>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 8, margin: '4px 0', opacity: 0.85 }}>{children}</blockquote>
  ),
}

export function AgentMessage({ content }: Props) {
  if (!content) return null

  const parts = parseContent(content)

  return (
    <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' }}>
      {parts.map((part, i) =>
        part.type === 'chart' ? (
          <VegaChart key={i} spec={part.value as object} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            components={mdComponents as never}
          >
            {String(part.value)}
          </ReactMarkdown>
        )
      )}
    </div>
  )
}
