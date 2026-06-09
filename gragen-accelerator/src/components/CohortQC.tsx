import { useEffect, useRef, useState } from 'react'
import type { SampleMetrics } from '../types'
import { SUPERPOP_LABELS } from '../types'

// CSS color strings for superpopulations
const SUPERPOP_COLORS: Record<string, string> = {
  AFR: '#f59e0b', AMR: '#10b981', EAS: '#3b82f6', EUR: '#8b5cf6', SAS: '#ef4444',
}

interface Props {
  data: SampleMetrics[]
  loading: boolean
  error: string | null
  onSelectSample: (s: SampleMetrics) => void
}

// Stats helpers
function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0 }
function median(arr: number[]): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Simple sparkline using SVG
function Sparkline({ values, color = '#4f8ef7', height = 28 }: { values: number[], color?: string, height?: number }) {
  if (!values.length) return null
  const w = 80
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${height - ((v - min) / range) * (height - 2) - 1}`).join(' ')
  return (
    <svg width={w} height={height} style={{ display: 'block' }}>
      <polyline fill="none" stroke={color} strokeWidth={1.5} points={pts} />
    </svg>
  )
}

// Horizontal bar chart for population breakdown
function PopBar({ data, total }: { data: Record<string, number>, total: number }) {
  const sorted = Object.entries(data).sort(([,a],[,b]) => b - a)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {sorted.map(([sp, count]) => (
        <div key={sp} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 28, fontSize: 9, color: SUPERPOP_COLORS[sp] ?? '#aaa', fontWeight: 600, flexShrink: 0 }}>{sp}</div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.05)', borderRadius: 3, height: 14, position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${(count / total) * 100}%`,
              background: SUPERPOP_COLORS[sp] ?? '#4f8ef7',
              borderRadius: 3, opacity: 0.8,
              transition: 'width 0.4s ease',
            }} />
          </div>
          <div style={{ width: 32, fontSize: 9, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0 }}>{count}</div>
        </div>
      ))}
    </div>
  )
}

// Mini scatter plot using canvas (no DeckGL overhead, much faster)
function QCScatter({ data, xKey, yKey, xLabel, yLabel, onSelect }:
  { data: SampleMetrics[], xKey: keyof SampleMetrics, yKey: keyof SampleMetrics, xLabel: string, yLabel: string, onSelect: (s: SampleMetrics) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number, y: number, s: SampleMetrics } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width, H = canvas.height
    const pad = { l: 30, r: 10, t: 10, b: 24 }
    const xs = data.map(d => d[xKey] as number ?? 0).filter(Number.isFinite)
    const ys = data.map(d => d[yKey] as number ?? 0).filter(Number.isFinite)
    const xMin = Math.min(...xs), xMax = Math.max(...xs)
    const yMin = Math.min(...ys), yMax = Math.max(...ys)
    const xR = xMax - xMin || 1, yR = yMax - yMin || 1

    const toX = (v: number) => pad.l + ((v - xMin) / xR) * (W - pad.l - pad.r)
    const toY = (v: number) => H - pad.b - ((v - yMin) / yR) * (H - pad.t - pad.b)

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(255,255,255,0.03)'
    ctx.fillRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b)

    // Draw dots
    for (const d of data) {
      const x = d[xKey] as number, y = d[yKey] as number
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const color = SUPERPOP_COLORS[d.superpopulation] ?? '#666'
      ctx.beginPath()
      ctx.arc(toX(x), toY(y), 2.5, 0, Math.PI * 2)
      ctx.fillStyle = color + 'bb'
      ctx.fill()
    }

    // Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(xLabel, W / 2, H - 4)
    ctx.save()
    ctx.translate(10, H / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(yLabel, 0, 0)
    ctx.restore()
  }, [data, xKey, yKey, xLabel, yLabel])

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !data.length) return
    const rect = canvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width)
    const my = (e.clientY - rect.top) * (canvas.height / rect.height)
    const W = canvas.width, H = canvas.height
    const pad = { l: 30, r: 10, t: 10, b: 24 }
    const xs = data.map(d => d[xKey] as number ?? 0).filter(Number.isFinite)
    const ys = data.map(d => d[yKey] as number ?? 0).filter(Number.isFinite)
    const xMin = Math.min(...xs), xMax = Math.max(...xs)
    const yMin = Math.min(...ys), yMax = Math.max(...ys)
    const xR = xMax - xMin || 1, yR = yMax - yMin || 1
    const toX = (v: number) => pad.l + ((v - xMin) / xR) * (W - pad.l - pad.r)
    const toY = (v: number) => H - pad.b - ((v - yMin) / yR) * (H - pad.t - pad.b)
    let best: SampleMetrics | null = null, bestD = 10
    for (const d of data) {
      const x = d[xKey] as number, y = d[yKey] as number
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const dx = toX(x) - mx, dy = toY(y) - my
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < bestD) { bestD = dist; best = d }
    }
    setHover(best ? { x: e.clientX - rect.left + 8, y: e.clientY - rect.top - 8, s: best } : null)
  }

  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={320} height={160}
        style={{ width: '100%', height: 160, cursor: 'crosshair', borderRadius: 6, border: '1px solid var(--border)' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => hover && onSelect(hover.s)}
      />
      {hover && (
        <div style={{
          position: 'absolute', left: hover.x, top: hover.y,
          background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(255,255,255,0.15)',
          padding: '5px 8px', borderRadius: 5, fontSize: 10,
          pointerEvents: 'none', zIndex: 10, whiteSpace: 'nowrap',
        }}>
          <div style={{ fontWeight: 600, color: SUPERPOP_COLORS[hover.s.superpopulation] ?? '#fff' }}>
            {hover.s.sample_id} ({hover.s.population})
          </div>
          <div>{xLabel}: <strong>{(hover.s[xKey] as number)?.toFixed(2)}</strong></div>
          <div>{yLabel}: <strong>{(hover.s[yKey] as number)?.toFixed(3)}</strong></div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 9 }}>Click to open in Genome Browser</div>
        </div>
      )}
    </div>
  )
}

export function CohortQC({ data, loading, error, onSelectSample }: Props) {
  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
      Loading cohort QC data…
    </div>
  )
  if (error) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--red)', fontSize: 12 }}>
      ⚠ {error}
    </div>
  )
  if (!data.length) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 12 }}>
      No samples loaded. Check SAMPLE_METRICS table.
    </div>
  )

  // Aggregate stats
  const bySP: Record<string, SampleMetrics[]> = {}
  for (const s of data) {
    if (!bySP[s.superpopulation]) bySP[s.superpopulation] = []
    bySP[s.superpopulation].push(s)
  }

  const spCounts: Record<string, number> = {}
  for (const [sp, ss] of Object.entries(bySP)) spCounts[sp] = ss.length

  const coverages = data.map(d => d.mean_coverage).filter((v): v is number => typeof v === 'number')
  const titvs    = data.map(d => d.titv_ratio).filter((v): v is number => typeof v === 'number')
  const hethoms  = data.map(d => d.het_hom_ratio).filter((v): v is number => typeof v === 'number')

  // Per-superpop summaries
  const spStats = Object.entries(bySP).sort(([a],[b]) => a.localeCompare(b)).map(([sp, ss]) => ({
    sp,
    n: ss.length,
    label: SUPERPOP_LABELS[sp] ?? sp,
    cov:  mean(ss.map(s => s.mean_coverage).filter((v): v is number => typeof v === 'number')),
    titv: mean(ss.map(s => s.titv_ratio).filter((v): v is number => typeof v === 'number')),
    hhr:  mean(ss.map(s => s.het_hom_ratio).filter((v): v is number => typeof v === 'number')),
    male: ss.filter(s => s.sex === 'male').length,
    female: ss.filter(s => s.sex === 'female').length,
  }))

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── KPI row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[
          { label: 'Samples', value: data.length.toLocaleString(), sub: `${Object.keys(bySP).length} populations` },
          { label: 'Mean Coverage', value: `${mean(coverages).toFixed(1)}×`, sub: `median ${median(coverages).toFixed(1)}×` },
          { label: 'Mean Ti/Tv', value: mean(titvs).toFixed(3), sub: 'SNP quality metric' },
          { label: 'Mean Het/Hom', value: mean(hethoms).toFixed(2), sub: 'heterozygosity ratio' },
        ].map(k => (
          <div key={k.label} style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3 }}>{k.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)', letterSpacing: '-0.5px' }}>{k.value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* ── Population breakdown ── */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>Samples by Superpopulation</div>
          <PopBar data={spCounts} total={data.length} />
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {spStats.map(s => (
              <div key={s.sp} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                <span style={{ color: SUPERPOP_COLORS[s.sp] ?? '#aaa', fontWeight: 600 }}>{s.label}</span>
                <span style={{ color: 'var(--text-secondary)' }}>♂{s.male} ♀{s.female} · {s.cov.toFixed(1)}× cov · TiTv {s.titv.toFixed(3)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Per-pop QC table ── */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>QC Metrics by Population</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '2px 4px' }}>Pop</th>
                <th style={{ textAlign: 'right', padding: '2px 4px' }}>N</th>
                <th style={{ textAlign: 'right', padding: '2px 4px' }}>Cov</th>
                <th style={{ textAlign: 'right', padding: '2px 4px' }}>TiTv</th>
                <th style={{ textAlign: 'right', padding: '2px 4px' }}>Het/Hom</th>
              </tr>
            </thead>
            <tbody>
              {spStats.map(s => (
                <tr key={s.sp} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '3px 4px', color: SUPERPOP_COLORS[s.sp] ?? '#aaa', fontWeight: 600 }}>{s.sp}</td>
                  <td style={{ padding: '3px 4px', textAlign: 'right', color: 'var(--text-secondary)' }}>{s.n}</td>
                  <td style={{ padding: '3px 4px', textAlign: 'right' }}>{s.cov.toFixed(1)}×</td>
                  <td style={{ padding: '3px 4px', textAlign: 'right' }}>{s.titv.toFixed(3)}</td>
                  <td style={{ padding: '3px 4px', textAlign: 'right' }}>{s.hhr.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Scatter plots ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Coverage vs Ti/Tv — click to open sample</div>
          <QCScatter data={data} xKey="mean_coverage" yKey="titv_ratio" xLabel="Coverage (×)" yLabel="Ti/Tv" onSelect={onSelectSample} />
          <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(SUPERPOP_COLORS).map(([sp, color]) => (
              <span key={sp} style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
                {SUPERPOP_LABELS[sp] ?? sp}
              </span>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Coverage vs Het/Hom — click to open sample</div>
          <QCScatter data={data} xKey="mean_coverage" yKey="het_hom_ratio" xLabel="Coverage (×)" yLabel="Het/Hom" onSelect={onSelectSample} />
          <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(SUPERPOP_COLORS).map(([sp, color]) => (
              <span key={sp} style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
                {sp}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
