import { useCallback, useEffect, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import { OrthographicView } from '@deck.gl/core'
import {
  type Sample, type SampleMetrics, type Variant, type DensityBin,
  type VariantResult, type MetaResult, type ClinVarVariant, type ClinVarResult,
  SUPERPOP_COLORS, SUPERPOP_LABELS, VARIANT_COLORS, CHROMOSOMES, CHROM_LENGTHS,
  CLINSIG_LABELS, CLINSIG_COLORS,
} from '../types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPos(pos: number): string {
  if (pos >= 1_000_000) return `${(pos / 1_000_000).toFixed(2)} Mb`
  if (pos >= 1_000)     return `${(pos / 1_000).toFixed(1)} kb`
  return String(pos)
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

// ── Chat panel (mirrors IceChunk pattern) ─────────────────────────────────────

interface ChatMessage { role: 'user' | 'assistant'; content: string; thinking?: string }

function ChatPanel({ contextMessage }: { contextMessage: string | null }) {
  const [history, setHistory]   = useState<ChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const bottomRef               = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contextMessage) setInput(contextMessage)
  }, [contextMessage])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const send = useCallback(async () => {
    const msg = input.trim()
    if (!msg || loading) return
    setInput('')
    setLoading(true)
    const userMsg: ChatMessage = { role: 'user', content: msg }
    setHistory(h => [...h, userMsg])
    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
    setHistory(h => [...h, assistantMsg])

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          history: history.map(h => ({ role: h.role, content: h.content })),
        }),
      })
      const reader = res.body?.getReader()
      if (!reader) return
      const dec = new TextDecoder()
      let buf = '', currentEvent = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue }
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>
            if (currentEvent === 'token') {
              setHistory(h => {
                const copy = [...h]
                copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + (parsed.text as string ?? '') }
                return copy
              })
            }
          } catch { /* skip */ }
        }
      }
    } finally { setLoading(false) }
  }, [input, history, loading])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
        🧬 Genomics Agent
      </div>
      <div style={{ flex: 1, overflowY: 'auto', marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {history.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            Ask about cohort QC, variant statistics, or population genetics across the 3,202 samples.
          </div>
        )}
        {history.map((msg, i) => (
          <div key={i} style={{
            background: msg.role === 'user' ? 'var(--bg-secondary)' : 'transparent',
            padding: '6px 8px', borderRadius: 6, fontSize: 12,
            color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
          }}>
            <span style={{ fontWeight: 600, color: msg.role === 'user' ? 'var(--accent)' : 'var(--text-secondary)', marginRight: 6 }}>
              {msg.role === 'user' ? 'You' : '🧬'}
            </span>
            {msg.content || (loading && i === history.length - 1 ? '…' : '')}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask about the genomics data…"
          style={{
            flex: 1, resize: 'none', height: 60, padding: '6px 8px',
            fontSize: 11, borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg-secondary)', color: 'var(--text-primary)',
          }}
        />
        <button
          className="btn primary small"
          onClick={send}
          disabled={loading || !input.trim()}
          style={{ alignSelf: 'flex-end', padding: '6px 14px' }}
        >
          Send
        </button>
      </div>
    </div>
  )
}

// ── Variant density bar chart (SVG) ──────────────────────────────────────────

function DensityChart({ density, chrom, start, end, onRegionClick }: {
  density: DensityBin[]
  chrom: string
  start: number
  end: number
  onRegionClick?: (s: number, e: number) => void
}) {
  const maxCount = Math.max(...density.map(d => d.count), 1)
  const width = 700, height = 120, padL = 10, padR = 10, padT = 10, padB = 20
  const rangeSize = end - start
  const toX = (pos: number) => padL + ((pos - start) / rangeSize) * (width - padL - padR)

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height + padT + padB}`} style={{ display: 'block' }}>
      {density.map((bin, i) => {
        const x = toX(bin.pos)
        const binW = Math.max(1, toX(bin.pos + (density[1]?.pos ?? (start + 10_000)) - density[0]!.pos) - x)
        const barH = (bin.count / maxCount) * height
        return (
          <rect
            key={i} x={x} y={padT + height - barH} width={binW} height={barH}
            fill="#29B5E8" opacity={0.8}
            style={{ cursor: onRegionClick ? 'pointer' : 'default' }}
            onClick={() => onRegionClick?.(bin.pos, bin.pos + (rangeSize / density.length) * 5)}
          />
        )
      })}
      {/* x-axis ticks */}
      {[start, Math.round((start + end) / 2), end].map((pos, i) => (
        <text key={i} x={toX(pos)} y={padT + height + padB - 4} fontSize={9} fill="#888" textAnchor="middle">
          {formatPos(pos)}
        </text>
      ))}
    </svg>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

type ViewMode = 'scatter' | 'browser'

interface Tooltip {
  x: number; y: number
  content: Record<string, string | number | null>
}

export default function GenomicsViewer({ onAgentContext }: { onAgentContext?: (msg: string) => void }) {
  const [view,    setView]    = useState<ViewMode>('scatter')
  const [meta,    setMeta]    = useState<MetaResult | null>(null)

  // ── Cohort scatter state ──────────────────────────────────────────────────
  const [cohortData,     setCohortData]     = useState<SampleMetrics[]>([])
  const [cohortLoading,  setCohortLoading]  = useState(false)
  const [cohortError,    setCohortError]    = useState<string | null>(null)
  const [selectedSuperpops, setSelectedSuperpops] = useState<Set<string>>(new Set())
  const [hoveredSample,  setHoveredSample]  = useState<SampleMetrics | null>(null)
  const [scatterTooltip, setScatterTooltip] = useState<Tooltip | null>(null)

  // ── Genome browser state ──────────────────────────────────────────────────
  const [sampleId,  setSampleId]  = useState('HG00096')
  const [chrom,     setChrom]     = useState('chr1')
  const [startPos,  setStartPos]  = useState(1_000_000)
  const [endPos,    setEndPos]    = useState(5_000_000)
  const [varResult, setVarResult] = useState<VariantResult | null>(null)
  const [browsing,  setBrowsing]  = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)

  // ── ClinVar overlay state ─────────────────────────────────────────────────
  const [showClinVar,    setShowClinVar]    = useState(false)
  const [clinVarResult,  setClinVarResult]  = useState<ClinVarResult | null>(null)
  const [clinVarLoading, setClinVarLoading] = useState(false)
  const [clinVarError,   setClinVarError]   = useState<string | null>(null)
  const [clinVarTooltip, setClinVarTooltip] = useState<Tooltip | null>(null)
  const [varTooltip, setVarTooltip] = useState<Tooltip | null>(null)
  const [sampleMeta, setSampleMeta] = useState<SampleMetrics | null>(null)

  // ── Save to table state ───────────────────────────────────────────────────
  const [tableName,  setTableName]  = useState('')
  const [saving,     setSaving]     = useState(false)
  const [saveResult, setSaveResult] = useState<{ table: string; row_count: number } | null>(null)
  const [saveError,  setSaveError]  = useState<string | null>(null)

  // ── Load meta on mount ────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/meta')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { if (d?.sample_count != null) setMeta(d as MetaResult) })
      .catch(console.error)
  }, [])

  // ── Load cohort QC data from SAMPLE_METRICS Snowflake table ───────────────
  const loadCohortData = useCallback(async () => {
    setCohortLoading(true)
    setCohortError(null)
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `SELECT sample_id, population, superpopulation, sex,
                       mean_coverage, pct_duplicates, pct_mapped,
                       total_variants, snp_count, titv_ratio, het_hom_ratio
                FROM GRAGEN_DB.GRAGEN.SAMPLE_METRICS
                WHERE mean_coverage IS NOT NULL
                ORDER BY superpopulation, sample_id`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const json = await res.json() as { data?: Record<string, unknown>[]; error?: string }
      if (json.error) { setCohortError(json.error); return }
      const rows = (json.data ?? []).map(r => ({
        sample_id:      String(r.SAMPLE_ID ?? r.sample_id ?? ''),
        sex:            String(r.SEX ?? r.sex ?? ''),
        population:     String(r.POPULATION ?? r.population ?? ''),
        pop_name:       '',
        superpopulation: String(r.SUPERPOPULATION ?? r.superpopulation ?? ''),
        superpop_name:  '',
        mean_coverage:  r.MEAN_COVERAGE  != null ? Number(r.MEAN_COVERAGE)  : undefined,
        pct_duplicates: r.PCT_DUPLICATES != null ? Number(r.PCT_DUPLICATES) : undefined,
        pct_mapped:     r.PCT_MAPPED     != null ? Number(r.PCT_MAPPED)     : undefined,
        total_variants: r.TOTAL_VARIANTS != null ? Number(r.TOTAL_VARIANTS) : undefined,
        snp_count:      r.SNP_COUNT      != null ? Number(r.SNP_COUNT)      : undefined,
        titv_ratio:     r.TITV_RATIO     != null ? Number(r.TITV_RATIO)     : undefined,
        het_hom_ratio:  r.HET_HOM_RATIO  != null ? Number(r.HET_HOM_RATIO)  : undefined,
      })) as SampleMetrics[]
      setCohortData(rows)
    } catch (err) {
      setCohortError(String(err))
    } finally {
      setCohortLoading(false)
    }
  }, [])

  // Auto-load cohort data when scatter view opens
  useEffect(() => {
    if (view === 'scatter' && cohortData.length === 0 && !cohortLoading) {
      loadCohortData()
    }
  }, [view, cohortData.length, cohortLoading, loadCohortData])

  // ── Fetch variants ────────────────────────────────────────────────────────
  const fetchVariants = useCallback(async () => {
    setBrowsing(true)
    setBrowseError(null)
    setVarResult(null)
    try {
      const res = await fetch('/api/direct/variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sampleId, chrom, start: startPos, end: endPos }),
      })
      const data = await res.json() as VariantResult & { detail?: string }
      if (!res.ok) { setBrowseError(data.detail ?? 'Unknown error'); return }
      setVarResult(data)
    } catch (err) {
      setBrowseError(String(err))
    } finally {
      setBrowsing(false)
    }
  }, [sampleId, chrom, startPos, endPos])

  // Fetch ClinVar overlay when showClinVar is toggled on or region changes
  const fetchClinVar = useCallback(async () => {
    if (!showClinVar) return
    setClinVarLoading(true)
    setClinVarError(null)
    try {
      const res = await fetch('/api/direct/clinvar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chrom, start: startPos, end: endPos }),
      })
      const data = await res.json() as ClinVarResult & { detail?: string }
      if (!res.ok) { setClinVarError(data.detail ?? 'Unknown error'); return }
      setClinVarResult(data)
    } catch (err) {
      setClinVarError(String(err))
    } finally {
      setClinVarLoading(false)
    }
  }, [showClinVar, chrom, startPos, endPos])

  // Load sample metadata when sample changes
  useEffect(() => {
    fetch(`/api/direct/metrics/${encodeURIComponent(sampleId)}`)
      .then(r => r.json())
      .then(d => setSampleMeta(d as SampleMetrics))
      .catch(() => setSampleMeta(null))
  }, [sampleId])

  // ── Save variants to table ────────────────────────────────────────────────
  const handleSave = async () => {
    if (!tableName.trim()) return
    setSaving(true); setSaveResult(null); setSaveError(null)
    try {
      const res = await fetch('/api/save-variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_name: tableName.trim(),
          sample_id:  sampleId,
          chrom, start_pos: startPos, end_pos: endPos,
        }),
      })
      const body = await res.json() as { table?: string; row_count?: number; error?: string }
      if (!res.ok) { setSaveError(body.error ?? 'Error'); return }
      setSaveResult({ table: body.table!, row_count: body.row_count ?? 0 })
    } catch (err) {
      setSaveError(String(err))
    } finally { setSaving(false) }
  }

  // ── DeckGL cohort scatter layer ───────────────────────────────────────────
  const visibleSamples = cohortData.filter(s =>
    s.mean_coverage != null && s.titv_ratio != null &&
    (selectedSuperpops.size === 0 || selectedSuperpops.has(s.superpopulation))
  )

  // Compute axis ranges
  const coverages  = visibleSamples.map(s => s.mean_coverage!)
  const titvs      = visibleSamples.map(s => s.titv_ratio!)
  const minCov = Math.min(...coverages, 0),   maxCov = Math.max(...coverages, 100)
  const minTitv = Math.min(...titvs, 1.5),    maxTitv = Math.max(...titvs, 2.5)

  const scatterData = visibleSamples.map(s => ({
    ...s,
    x: (s.mean_coverage! - minCov) / (maxCov - minCov) * 1000 - 500,
    y: (s.titv_ratio!    - minTitv) / (maxTitv - minTitv) * 600 - 300,
  }))

  const scatterLayer = new ScatterplotLayer({
    id: 'cohort-scatter',
    data: scatterData,
    getPosition: (d: typeof scatterData[0]) => [d.x, d.y, 0] as [number, number, number],
    getFillColor: (d: typeof scatterData[0]) => {
      const c = SUPERPOP_COLORS[d.superpopulation] ?? [150, 150, 150]
      return hoveredSample?.sample_id === d.sample_id ? [255, 255, 255] : [...c, 200] as [number, number, number, number]
    },
    getRadius: 5,
    radiusUnits: 'pixels',
    pickable: true,
    onHover: (info: { object?: typeof scatterData[0]; x?: number; y?: number }) => {
      if (info.object) {
        setHoveredSample(info.object)
        setScatterTooltip({
          x: info.x ?? 0, y: info.y ?? 0,
          content: {
            Sample: info.object.sample_id,
            Population: info.object.pop_name || info.object.population,
            Superpopulation: SUPERPOP_LABELS[info.object.superpopulation] ?? info.object.superpopulation,
            Coverage: info.object.mean_coverage != null ? `${info.object.mean_coverage}×` : 'N/A',
            'Ti/Tv': info.object.titv_ratio ?? 'N/A',
            'Dup %': info.object.pct_duplicates != null ? `${info.object.pct_duplicates}%` : 'N/A',
          },
        })
      } else {
        setHoveredSample(null)
        setScatterTooltip(null)
      }
    },
    onClick: (info: { object?: typeof scatterData[0] }) => {
      if (info.object) {
        setSampleId(info.object.sample_id)
        setView('browser')
      }
    },
    updateTriggers: { getFillColor: [hoveredSample?.sample_id, selectedSuperpops] },
  })

  // ── Variant scatter layer (zoomed-in genome browser) ─────────────────────
  const variants = varResult?.variants ?? []
  const regionSize = endPos - startPos
  const varScatterData = variants.map(v => ({
    ...v,
    x: ((v.pos - startPos) / regionSize) * 1000 - 500,
    y: Math.random() * 100 - 50, // jitter for visibility
  }))
  const varLayer = new ScatterplotLayer({
    id: 'variants',
    data: varScatterData,
    getPosition: (d: typeof varScatterData[0]) => [d.x, d.y, 0] as [number, number, number],
    getFillColor: (d: typeof varScatterData[0]) => [...(VARIANT_COLORS[d.type] ?? [150, 150, 150]), 220] as [number, number, number, number],
    getRadius: 4,
    radiusUnits: 'pixels',
    pickable: true,
    onHover: (info: { object?: typeof varScatterData[0]; x?: number; y?: number }) => {
      if (info.object) {
        setVarTooltip({
          x: info.x ?? 0, y: info.y ?? 0,
          content: {
            POS: info.object.pos,
            REF: info.object.ref,
            ALT: info.object.alts.join(','),
            Type: info.object.type,
            QUAL: info.object.qual ?? 'N/A',
            AF: info.object.af != null ? info.object.af.toFixed(4) : 'N/A',
          },
        })
      } else {
        setVarTooltip(null)
      }
    },
  })

  // ── ClinVar overlay DeckGL layer ──────────────────────────────────────────
  // Separate ScatterplotLayer on top of the 1000G variants, coloured by
  // clinical significance. Larger radius for high-confidence pathogenic calls.
  const clinVarVariants: ClinVarVariant[] = clinVarResult?.variants ?? []
  const clinVarScatterData = clinVarVariants.map(v => ({
    ...v,
    x: ((v.pos - startPos) / regionSize) * 1000 - 500,
    y: 60 + (v.clinsig >= 3 ? 20 : 0),  // pathogenic floats above benign
  }))
  const clinVarLayer = new ScatterplotLayer({
    id: 'clinvar',
    data: clinVarScatterData,
    visible: showClinVar && clinVarScatterData.length > 0,
    getPosition: (d: typeof clinVarScatterData[0]) => [d.x, d.y, 0] as [number, number, number],
    getFillColor: (d: typeof clinVarScatterData[0]) => {
      const c = CLINSIG_COLORS[d.clinsig] ?? [140, 140, 140]
      return [...c, 230] as [number, number, number, number]
    },
    // Pathogenic variants rendered larger for visibility
    getRadius: (d: typeof clinVarScatterData[0]) => d.clinsig >= 3 ? 7 : 5,
    radiusUnits: 'pixels',
    pickable: true,
    onHover: (info: { object?: typeof clinVarScatterData[0]; x?: number; y?: number }) => {
      if (info.object) {
        const v = info.object
        setClinVarTooltip({
          x: info.x ?? 0, y: info.y ?? 0,
          content: {
            '🧬 ClinVar':  `ID ${v.allele_id}`,
            POS:           v.pos,
            Significance:  v.clinsig_label,
            'Review stars': '⭐'.repeat(Math.max(1, v.revstat + 1)),
            'ClinVar link': `clinvar.ncbi.nlm.nih.gov/variation/${v.allele_id}`,
          },
        })
      } else {
        setClinVarTooltip(null)
      }
    },
    updateTriggers: { visible: [showClinVar] },
  })

  // ── Tooltip component ─────────────────────────────────────────────────────
  const Tooltip = ({ tip }: { tip: Tooltip }) => (
    <div style={{
      position: 'absolute', left: tip.x + 12, top: tip.y - 10, zIndex: 100,
      background: 'rgba(20,20,30,0.95)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '8px 12px', pointerEvents: 'none',
      fontSize: 11, color: 'var(--text-primary)', whiteSpace: 'nowrap',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    }}>
      {Object.entries(tip.content).map(([k, v]) => (
        <div key={k}>
          <span style={{ color: 'var(--text-secondary)', marginRight: 6 }}>{k}:</span>
          <span style={{ fontWeight: 600 }}>{String(v)}</span>
        </div>
      ))}
    </div>
  )

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>

      {/* ── Left sidebar ─────────────────────────────────────────────── */}
      <div style={{ width: 280, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflowY: 'auto', flexShrink: 0 }}>

        {/* Header */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
            🧬 GRAGEN Accelerator
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            1000 Genomes · DRAGEN 3.7.6 · hg38
            {meta?.sample_count != null && ` · ${meta.sample_count.toLocaleString()} samples`}
          </div>
        </div>

        {/* View toggle */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6 }}>
          <button
            className={`btn small ${view === 'scatter' ? 'primary' : 'secondary'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            onClick={() => setView('scatter')}
          >📊 Cohort QC</button>
          <button
            className={`btn small ${view === 'browser' ? 'primary' : 'secondary'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            onClick={() => setView('browser')}
          >🔬 Genome Browser</button>
        </div>

        {/* Scatter controls */}
        {view === 'scatter' && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Superpopulation Filter</div>
            {Object.entries(SUPERPOP_LABELS).map(([code, name]) => {
              const color = SUPERPOP_COLORS[code] ?? [150, 150, 150]
              const count = cohortData.filter(s => s.superpopulation === code).length
              const active = selectedSuperpops.size === 0 || selectedSuperpops.has(code)
              return (
                <label key={code} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: 'pointer', opacity: active ? 1 : 0.4 }}>
                  <input
                    type="checkbox"
                    checked={selectedSuperpops.size === 0 || selectedSuperpops.has(code)}
                    onChange={() => {
                      setSelectedSuperpops(prev => {
                        const next = new Set(prev.size === 0 ? Object.keys(SUPERPOP_LABELS) : prev)
                        if (next.has(code)) next.delete(code); else next.add(code)
                        return next.size === Object.keys(SUPERPOP_LABELS).length ? new Set() : next
                      })
                    }}
                    style={{ accentColor: `rgb(${color.join(',')})` }}
                  />
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: `rgb(${color.join(',')})`, flexShrink: 0 }} />
                  <span style={{ fontSize: 11 }}>{name} ({code})</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-secondary)' }}>{count}</span>
                </label>
              )
            })}
            <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-secondary)' }}>
              {visibleSamples.length.toLocaleString()} / {cohortData.length.toLocaleString()} samples shown
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn secondary small" style={{ fontSize: 11, width: '100%', justifyContent: 'center' }} onClick={loadCohortData} disabled={cohortLoading}>
                {cohortLoading ? 'Loading…' : 'Refresh QC Data'}
              </button>
            </div>
            {cohortError && <div style={{ marginTop: 6, fontSize: 10, color: 'var(--red)' }}>⚠ {cohortError}</div>}
          </div>
        )}

        {/* Genome browser controls */}
        {view === 'browser' && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Sample</div>
            <input
              className="bbox-input"
              value={sampleId}
              onChange={e => setSampleId(e.target.value.trim())}
              placeholder="e.g. HG00096"
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, marginBottom: 10 }}
            />
            {sampleMeta && (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>
                {sampleMeta.superpopulation && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: `rgb(${(SUPERPOP_COLORS[sampleMeta.superpopulation] ?? [150,150,150]).join(',')})`, flexShrink: 0 }} />
                    {SUPERPOP_LABELS[sampleMeta.superpopulation] ?? sampleMeta.superpopulation}
                  </span>
                )}
                {sampleMeta.population && <span>{sampleMeta.population} · </span>}
                {sampleMeta.sex && <span>{sampleMeta.sex === '1' ? '♂' : '♀'}</span>}
                {sampleMeta.mean_coverage && <div>Coverage: {sampleMeta.mean_coverage}×</div>}
                {sampleMeta.titv_ratio    && <div>Ti/Tv: {sampleMeta.titv_ratio}</div>}
                {sampleMeta.total_variants && <div>Variants: {sampleMeta.total_variants.toLocaleString()}</div>}
              </div>
            )}

            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Region</div>
            <select
              value={chrom}
              onChange={e => setChrom(e.target.value)}
              style={{ width: '100%', marginBottom: 6, padding: '4px 8px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11 }}
            >
              {CHROMOSOMES.map(c => <option key={c} value={c}>{c} ({(CHROM_LENGTHS[c] / 1e6).toFixed(0)} Mb)</option>)}
            </select>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>Start</div>
                <input
                  className="bbox-input"
                  type="number"
                  value={startPos}
                  onChange={e => setStartPos(Math.max(0, parseInt(e.target.value) || 0))}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>End</div>
                <input
                  className="bbox-input"
                  type="number"
                  value={endPos}
                  onChange={e => setEndPos(Math.max(startPos + 1, parseInt(e.target.value) || endPos))}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 8 }}>
              Region: {formatPos(endPos - startPos)} · {chrom}:{formatPos(startPos)}-{formatPos(endPos)}
            </div>

            {/* Quick region buttons */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {[
                { label: '1 Mb', size: 1_000_000 }, { label: '5 Mb', size: 5_000_000 },
                { label: '10 Mb', size: 10_000_000 }, { label: 'Full chr', size: CHROM_LENGTHS[chrom] ?? 200_000_000 },
              ].map(({ label, size }) => (
                <button
                  key={label}
                  className="btn secondary small"
                  style={{ fontSize: 10, padding: '2px 8px' }}
                  onClick={() => { setStartPos(0); setEndPos(size) }}
                >{label}</button>
              ))}
            </div>

            <button
              className="btn primary small"
              style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              onClick={fetchVariants}
              disabled={browsing}
            >
              {browsing ? '⏳ Loading…' : '🔍 Fetch Variants'}
            </button>

            {browseError && <div style={{ fontSize: 10, color: 'var(--red)', marginBottom: 6 }}>⚠ {browseError}</div>}

            {varResult && (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {varResult.count.toLocaleString()} variants {varResult.truncated ? '(truncated)' : ''} · {varResult.density ? 'density view' : 'individual'}
              </div>
            )}

            {/* ClinVar overlay toggle */}
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={showClinVar}
                    onChange={e => {
                      setShowClinVar(e.target.checked)
                      if (e.target.checked && !clinVarResult) fetchClinVar()
                    }}
                    style={{ accentColor: '#e53935' }}
                  />
                  🏥 ClinVar Overlay
                </label>
                {showClinVar && (
                  <button
                    className="btn secondary small"
                    style={{ fontSize: 10, padding: '2px 8px', marginLeft: 'auto' }}
                    onClick={fetchClinVar}
                    disabled={clinVarLoading}
                  >
                    {clinVarLoading ? '⏳' : '↺ Refresh'}
                  </button>
                )}
              </div>
              {clinVarError && <div style={{ fontSize: 10, color: 'var(--red)' }}>⚠ {clinVarError}</div>}
              {showClinVar && clinVarResult && (
                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {clinVarResult.count.toLocaleString()} ClinVar variants
                  {clinVarResult.variants.filter(v => v.clinsig >= 3).length > 0 && (
                    <span style={{ color: '#e53935', marginLeft: 6 }}>
                      ● {clinVarResult.variants.filter(v => v.clinsig === 4).length} Pathogenic
                      / {clinVarResult.variants.filter(v => v.clinsig === 3).length} Likely Path.
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Save to table */}
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Save to Snowflake Table</div>
              <input
                className="bbox-input"
                value={tableName}
                onChange={e => setTableName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                placeholder="TABLE_NAME"
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, marginBottom: 6 }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
                GRAGEN_DB.GRAGEN · {sampleId} · {chrom}:{formatPos(startPos)}-{formatPos(endPos)}
              </div>
              <button
                className="btn primary small"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={handleSave}
                disabled={saving || !tableName.trim()}
              >
                {saving ? 'Saving…' : '↓ Save to Table'}
              </button>
              {saveResult && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--green)' }}>
                  ✓ {saveResult.row_count.toLocaleString()} rows → {saveResult.table}
                </div>
              )}
              {saveError && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red)' }}>⚠ {saveError}</div>}
            </div>
          </div>
        )}

        {/* Agent chat panel */}
        <div style={{ flex: 1, minHeight: 200, borderTop: '1px solid var(--border)' }}>
          <ChatPanel contextMessage={null} />
        </div>
      </div>

      {/* ── Main view area ────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>

        {/* ── Cohort QC scatter ─────────────────────────────────────── */}
        {view === 'scatter' && (
          <div style={{ flex: 1, position: 'relative' }}>
            {cohortLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(10,10,20,0.8)', zIndex: 10, fontSize: 14, color: 'var(--text-secondary)' }}>
                Loading cohort QC data…
              </div>
            )}
            {!cohortLoading && cohortData.length === 0 && !cohortError && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                  No data in SAMPLE_METRICS table yet.
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 400, textAlign: 'center' }}>
                  Run <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>python scripts/load_metrics.py</code> to populate QC metrics for all 3,202 samples.
                </div>
                <button className="btn primary small" onClick={loadCohortData}>Retry</button>
              </div>
            )}
            {visibleSamples.length > 0 && (
              <DeckGL
                views={new OrthographicView({ id: 'scatter' })}
                initialViewState={{ target: [0, 0, 0], zoom: 0.6 }}
                controller={true}
                layers={[scatterLayer]}
                style={{ width: '100%', height: '100%' }}
              >
                {/* Axis labels overlay */}
                <div style={{
                  position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
                  fontSize: 11, color: 'var(--text-secondary)', pointerEvents: 'none',
                }}>
                  Mean Coverage (×)
                </div>
                <div style={{
                  position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%) rotate(-90deg)',
                  fontSize: 11, color: 'var(--text-secondary)', pointerEvents: 'none',
                }}>
                  Ti/Tv Ratio
                </div>
                <div style={{
                  position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
                  fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', pointerEvents: 'none',
                }}>
                  Cohort QC — {visibleSamples.length.toLocaleString()} samples · Click a dot to open in Genome Browser
                </div>
              </DeckGL>
            )}
            {scatterTooltip && <Tooltip tip={scatterTooltip} />}
          </div>
        )}

        {/* ── Genome browser ──────────────────────────────────────────── */}
        {view === 'browser' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, gap: 12, overflowY: 'auto' }}>
            {/* Header */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                {sampleId} · {chrom}:{formatPos(startPos)}-{formatPos(endPos)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {sampleMeta?.superpopulation && (
                  <span style={{ marginRight: 10 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: `rgb(${(SUPERPOP_COLORS[sampleMeta.superpopulation] ?? [150,150,150]).join(',')})`, marginRight: 4 }} />
                    {SUPERPOP_LABELS[sampleMeta.superpopulation]}
                  </span>
                )}
                {sampleMeta?.population && <span>{sampleMeta.population} · </span>}
                {!varResult && !browsing && <span>Select a region and click Fetch Variants</span>}
                {browsing && <span>Fetching variants…</span>}
                {varResult && <span>{varResult.count.toLocaleString()} variants{varResult.truncated ? ' (capped at 100k)' : ''}</span>}
              </div>
            </div>

            {/* Variant type legend */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {Object.entries(VARIANT_COLORS).filter(([k]) => k !== 'REF').map(([type, color]) => {
                const count = varResult?.variants.filter(v => v.type === type).length ?? 0
                return (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: `rgb(${color.join(',')})`, flexShrink: 0 }} />
                    <span>{type}</span>
                    {varResult && <span style={{ color: 'var(--text-secondary)' }}>({count.toLocaleString()})</span>}
                  </div>
                )
              })}
            </div>

            {/* Density chart */}
            {varResult?.density && varResult.density.length > 0 && (
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  Variant Density (click a bar to zoom in)
                </div>
                <DensityChart
                  density={varResult.density}
                  chrom={chrom}
                  start={startPos}
                  end={endPos}
                  onRegionClick={(s, e) => {
                    setStartPos(s)
                    setEndPos(e)
                    fetchVariants()
                  }}
                />
              </div>
            )}

            {/* Individual variants scatter (zoomed in) */}
            {(varResult?.variants.length ?? 0) > 0 && (
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '12px 16px', position: 'relative' }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  Individual Variants (hover for details)
                </div>
                <div style={{ height: 200, position: 'relative' }}>
                  <DeckGL
                    views={new OrthographicView({ id: 'variants' })}
                    initialViewState={{ target: [0, 0, 0], zoom: 0.5 }}
                    controller={true}
                    layers={[varLayer, clinVarLayer]}
                    style={{ width: '100%', height: '100%' }}
                  />
                  {varTooltip    && <Tooltip tip={varTooltip} />}
                  {clinVarTooltip && <Tooltip tip={clinVarTooltip} />}
                </div>
                {/* ClinVar legend */}
                {showClinVar && clinVarScatterData.length > 0 && (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                    {[4,3,2,1,0,5].map(sig => {
                      const c = CLINSIG_COLORS[sig] ?? [140,140,140]
                      const n = clinVarVariants.filter(v => v.clinsig === sig).length
                      if (!n) return null
                      return (
                        <div key={sig} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: `rgb(${c.join(',')})`, flexShrink: 0 }} />
                          <span style={{ color: 'var(--text-secondary)' }}>{CLINSIG_LABELS[sig]} ({n})</span>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-secondary)', marginTop: 4 }}>
                  <span>{chrom}:{startPos.toLocaleString()}</span>
                  <span>{chrom}:{endPos.toLocaleString()}</span>
                </div>
              </div>
            )}

            {/* Variant table (first 50) */}
            {(varResult?.variants.length ?? 0) > 0 && (
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  Variants (first {Math.min(50, varResult!.variants.length)})
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {['POS', 'REF', 'ALT', 'TYPE', 'QUAL', 'AF'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {varResult!.variants.slice(0, 50).map((v, i) => {
                        const color = VARIANT_COLORS[v.type] ?? [150, 150, 150]
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{v.pos.toLocaleString()}</td>
                            <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{v.ref}</td>
                            <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{v.alts.join(',')}</td>
                            <td style={{ padding: '3px 8px' }}>
                              <span style={{ background: `rgb(${color.join(',')})`, color: '#fff', padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{v.type}</span>
                            </td>
                            <td style={{ padding: '3px 8px' }}>{v.qual ?? '.'}</td>
                            <td style={{ padding: '3px 8px' }}>{v.af != null ? v.af.toFixed(4) : '.'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!varResult && !browsing && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
                Select a sample + region and click <strong style={{ margin: '0 6px' }}>Fetch Variants</strong> to begin.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
