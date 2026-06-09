import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentMessage } from './AgentMessage'
import { CohortGlobe } from './CohortGlobe'
import { CohortQC } from './CohortQC'
import { DataManagementPanel } from './DataManagementPanel'
import { Variant3DView } from './Variant3DView'
import { DNAHelix } from './DNAHelix'
import { GoslingTracks } from './GoslingTracks'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import { OrthographicView } from '@deck.gl/core'
import {
  type Sample, type SampleMetrics, type Variant, type DensityBin,
  type VariantResult, type MetaResult, type ClinVarVariant, type ClinVarResult,
  type GenomeAnnotation, type AnnoSource,
  SUPERPOP_COLORS, SUPERPOP_LABELS, VARIANT_COLORS, CHROMOSOMES, CHROM_LENGTHS,
  CLINSIG_LABELS, CLINSIG_COLORS, VTYPE_LABELS,
  GWAS_COLOR, SFARI_SCORE_COLORS,
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

function ChatPanel({ contextMessage, onUserMessage }: { contextMessage: { text: string; nonce: number } | null; onUserMessage?: (msg: string) => void }) {
  const [history, setHistory]   = useState<ChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const bottomRef               = useRef<HTMLDivElement>(null)
  const sendRef                 = useRef<(explicit?: string) => void>(() => {})

  useEffect(() => {
    if (contextMessage) sendRef.current(contextMessage.text)
  }, [contextMessage])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const send = useCallback(async (explicit?: string) => {
    const msg = (explicit ?? input).trim()
    if (!msg || loading) return
    onUserMessage?.(msg)
    if (!explicit) setInput('')
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
            if (currentEvent === 'error') {
              const errMsg = (parsed.error as string) ?? 'Agent error'
              setHistory(h => {
                const copy = [...h]
                copy[copy.length - 1] = { ...copy[copy.length - 1], content: `⚠️ ${errMsg}` }
                return copy
              })
            } else if (currentEvent === 'result') {
              const text = (parsed.text as string) ?? ''
              if (text) setHistory(h => {
                const copy = [...h]
                copy[copy.length - 1] = { ...copy[copy.length - 1], content: text }
                return copy
              })
            } else if (currentEvent === 'token') {
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
  }, [input, history, loading, onUserMessage])
  sendRef.current = send

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
            color: 'var(--text-primary)',
          }}>
            <span style={{ fontWeight: 600, color: msg.role === 'user' ? 'var(--accent)' : 'var(--text-secondary)', marginRight: 6 }}>
              {msg.role === 'user' ? 'You' : '🧬'}
            </span>
            {msg.role === 'user'
              ? (msg.content || '…')
              : <AgentMessage content={msg.content || (loading && i === history.length - 1 ? '…' : '')} />
            }
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
          onClick={() => send()}
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

type ViewMode = 'scatter' | 'map' | 'browser' | '3d'

const VIEW_TITLES: Record<ViewMode, string> = {
  scatter: 'Cohort QC',
  map:     'Sample Origins',
  browser: 'Genome Browser',
  '3d':    '3D Genome Viewer',
}

interface Tooltip {
  x: number; y: number
  content: Record<string, string | number | null>
}

export default function GenomicsViewer({ onAgentContext }: { onAgentContext?: (msg: string) => void }) {
  const [view,    setView]    = useState<ViewMode>('scatter')
  const [meta,    setMeta]    = useState<MetaResult | null>(null)

  // ── Cohort scatter state ──────────────────────────────────────────────────
  const [cohortData,     setCohortData]     = useState<SampleMetrics[]>([])
  const [popStats,       setPopStats]       = useState<{population:string;superpopulation:string;sex:string;cnt:number}[]>([])
  const [cohortLoading,  setCohortLoading]  = useState(false)
  const [cohortError,    setCohortError]    = useState<string | null>(null)
  const [selectedSuperpops, setSelectedSuperpops] = useState<Set<string>>(new Set())
  const [hoveredSample,  setHoveredSample]  = useState<SampleMetrics | null>(null)
  const [scatterTooltip, setScatterTooltip] = useState<Tooltip | null>(null)

  // ── Genome browser state ──────────────────────────────────────────────────
  const [sampleId,  setSampleId]  = useState('HG00096')
  const [chrom,     setChrom]     = useState('chr22')
  const [seededChroms, setSeededChroms] = useState<string[]>(['chr22'])
  const [variants3d, setVariants3d] = useState<import('../types').Variant[]>([])
  const [loading3d, setLoading3d] = useState(false)
  const [view3dSub, setView3dSub] = useState<'helix' | 'tracks'>('helix')
  const [agentContext, setAgentContext] = useState<{ text: string; nonce: number } | null>(null)
  // ── 3D-helix annotation overlay (multi-source, queried from Iceberg) ──
  const [annoShow,   setAnnoShow]   = useState(false)
  const [annoSource, setAnnoSource] = useState<AnnoSource>('clinvar')
  const [annotations, setAnnotations] = useState<GenomeAnnotation[]>([])
  const [annoLoading, setAnnoLoading] = useState(false)
  const annoJumpedRef = useRef<string>('')   // guards one auto-jump per source:chrom
  const [clinFilter, setClinFilter] = useState<number[] | null>([4])  // ClinVar default: Pathogenic only
  const [startPos,  setStartPos]  = useState(20_900_000)
  const [endPos,    setEndPos]    = useState(21_100_000)
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
  const [pedigree, setPedigree] = useState<{ father?: string; mother?: string } | null>(null)
  const [acct, setAcct] = useState<string | null>(null)

  // Dynamic account label for the footer (no hardcoded connection name).
  useEffect(() => {
    fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT CURRENT_ACCOUNT() AS A', database: 'GRAGEN_DB', schema: 'GRAGEN' }),
    })
      .then(r => r.json())
      .then((j: { data?: Record<string, unknown>[] }) => {
        const a = j.data?.[0]
        const v = a ? (a.A ?? a.a) : null
        if (v != null) setAcct(String(v))
      })
      .catch(() => { /* leave null */ })
  }, [])

  // ── Save to table state ───────────────────────────────────────────────────
  const [tableName,  setTableName]  = useState('')
  const [saving,     setSaving]     = useState(false)
  const [saveResult, setSaveResult] = useState<{ table: string; row_count: number } | null>(null)
  const [saveError,  setSaveError]  = useState<string | null>(null)

  // ── Load meta on mount + seeded chromosomes ─────────────────────────────────────
  useEffect(() => {
    fetch('/api/meta')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { if (d?.sample_count != null) setMeta(d as MetaResult) })
      .catch(console.error)
    // Load which chromosomes are actually in the Zarr store
    fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT PARSE_JSON(GRAGEN_DB.GRAGEN.GRAGEN_META()):chromosomes_in_store AS c`, database: 'GRAGEN_DB', schema: 'GRAGEN' }),
    }).then(r => r.json()).then((d: { data?: Record<string,unknown>[] }) => {
      const raw = d.data?.[0]?.['C'] ?? d.data?.[0]?.['c']
      if (!raw) return
      const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string,unknown>)
      const chroms = Object.keys(obj).sort()
      if (chroms.length) setSeededChroms(chroms)
    }).catch(console.error)
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
      // Also fetch pop stats for geographic map
      try {
        const ps = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: `SELECT population, superpopulation, sex, COUNT(*) AS cnt FROM GRAGEN_DB.GRAGEN.SAMPLE_METRICS GROUP BY 1,2,3 ORDER BY 2,1`,
            database: 'GRAGEN_DB', schema: 'GRAGEN',
          }),
        })
        const pj = await ps.json() as { data?: Record<string,unknown>[] }
        setPopStats((pj.data ?? []).map(r => ({
          population:     String(r.POPULATION ?? ''),
          superpopulation: String(r.SUPERPOPULATION ?? ''),
          sex:            String(r.SEX ?? ''),
          cnt:            Number(r.CNT ?? 0),
        })))
      } catch { /* ignore */ }
    } catch (err) {
      setCohortError(String(err))
    } finally {
      setCohortLoading(false)
    }
  }, [])

  // Auto-load cohort data when scatter or map view opens
  useEffect(() => {
    if ((view === 'scatter' || view === 'map') && cohortData.length === 0 && !cohortLoading) {
      loadCohortData()
    }
  }, [view, cohortData.length, cohortLoading, loadCohortData])

  // ── Fetch variants ────────────────────────────────────────────────────────
  // Accepts an optional explicit region/sample so programmatic jumps (chat,
  // annotation auto-navigation) fetch the right region without waiting for
  // React state to settle.
  const fetchVariants = useCallback(async (ov?: { chrom?: string; start?: number; end?: number; sample?: string }) => {
    const c = ov?.chrom ?? chrom
    const s = ov?.start ?? startPos
    const e = ov?.end ?? endPos
    const sid = ov?.sample ?? sampleId
    setBrowsing(true)
    setBrowseError(null)
    setVarResult(null)
    try {
      const res = await fetch('/api/direct/variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sid, chrom: c, start: s, end: e }),
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

  // Navigate the viewer to a region: update state AND refetch variants for that
  // exact region so the 3D helix shows matching variants + annotations.
  const goToRegion = useCallback((c: string, s: number, e: number) => {
    setChrom(c); setStartPos(Math.max(0, s)); setEndPos(e)
    fetchVariants({ chrom: c, start: Math.max(0, s), end: e })
  }, [fetchVariants])

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

  // Multi-source annotation loader for the 3D helix. Queries the relevant
  // Snowflake-managed Iceberg table directly via /api/query (no backend rebuild
  // needed to add a source). Maps rows → GenomeAnnotation[] for DNAHelix.
  const loadAnnotations = useCallback(async (src: AnnoSource = annoSource) => {
    setAnnoLoading(true)
    const q = async (sql: string) => {
      const res = await fetch('/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, database: 'GRAGEN_DB', schema: 'GRAGEN' }),
      })
      const j = await res.json() as { data?: Record<string, unknown>[]; error?: string }
      return j.error ? [] : (j.data ?? [])
    }
    const num = (v: unknown) => (v == null ? 0 : Number(v))
    const str = (v: unknown) => (v == null ? '' : String(v))
    try {
      let annos: GenomeAnnotation[] = []
      if (src === 'clinvar') {
        const rows = await q(
          `SELECT POSITION, CLINSIG, DISEASE, GENE, ALLELE_ID
             FROM GRAGEN_DB.GRAGEN.CHR22_CLINVAR
            WHERE CHROM='${chrom}' AND POSITION BETWEEN ${startPos} AND ${endPos}
            ORDER BY POSITION LIMIT 2000`)
        annos = rows.map(r => {
          const sig = num(r.CLINSIG ?? r.clinsig)
          const disease = str(r.DISEASE ?? r.disease)
          const gene = str(r.GENE ?? r.gene)
          const id = num(r.ALLELE_ID ?? r.allele_id)
          return {
            source: 'clinvar' as const,
            pos: num(r.POSITION ?? r.position),
            label: disease || CLINSIG_LABELS[sig] || 'ClinVar',
            sublabel: [gene && `Gene ${gene}`, CLINSIG_LABELS[sig]].filter(Boolean).join(' · '),
            color: CLINSIG_COLORS[sig] ?? [140, 140, 140],
            clinsig: sig,
            link: id ? `clinvar.ncbi.nlm.nih.gov/variation/${id}` : undefined,
          }
        })
      } else if (src === 'gwas') {
        const rows = await q(
          `SELECT POSITION, TRAIT, MAPPED_GENE, RSID, P_VALUE
             FROM GRAGEN_DB.GRAGEN.CHR22_GWAS
            WHERE CHROM='${chrom}' AND POSITION BETWEEN ${startPos} AND ${endPos}
            ORDER BY POSITION LIMIT 2000`)
        annos = rows.map(r => {
          const gene = str(r.MAPPED_GENE ?? r.mapped_gene)
          const rsid = str(r.RSID ?? r.rsid)
          const p = r.P_VALUE ?? r.p_value
          return {
            source: 'gwas' as const,
            pos: num(r.POSITION ?? r.position),
            label: str(r.TRAIT ?? r.trait) || 'GWAS association',
            sublabel: [gene && `Gene ${gene}`, p != null && `p=${p}`].filter(Boolean).join(' · '),
            color: GWAS_COLOR,
            link: rsid ? `ncbi.nlm.nih.gov/snp/${rsid}` : undefined,
          }
        })
      } else {
        // SFARI gene regions overlapping the current window
        const rows = await q(
          `SELECT GENE, START_POS, END_POS, SFARI_SCORE, NOTE
             FROM GRAGEN_DB.GRAGEN.AUTISM_GENES
            WHERE CHROM='${chrom}' AND END_POS>=${startPos} AND START_POS<=${endPos}
            ORDER BY START_POS LIMIT 500`)
        annos = rows.map(r => {
          const s = num(r.START_POS ?? r.start_pos)
          const e = num(r.END_POS ?? r.end_pos)
          const score = str(r.SFARI_SCORE ?? r.sfari_score)
          return {
            source: 'sfari' as const,
            pos: Math.round((s + e) / 2),
            label: str(r.GENE ?? r.gene),
            sublabel: [score && `SFARI ${score}`, str(r.NOTE ?? r.note)].filter(Boolean).join(' · '),
            color: SFARI_SCORE_COLORS[score] ?? [200, 120, 255],
            start: s, end: e,
          }
        })
      }
      // GWAS/SFARI are sparse — if the current region has none, navigate to the
      // nearest region on this chromosome that does (and refetch its variants),
      // so switching source actually shows annotations. Guard prevents loops.
      if (annos.length === 0 && (src === 'gwas' || src === 'sfari')) {
        const key = `${src}:${chrom}`
        if (annoJumpedRef.current !== key) {
          const center = Math.round((startPos + endPos) / 2)
          let region: [number, number] | null = null
          if (src === 'gwas') {
            const r = await q(`SELECT POSITION FROM GRAGEN_DB.GRAGEN.CHR22_GWAS
                                WHERE CHROM='${chrom}' ORDER BY ABS(POSITION-${center}) LIMIT 1`)
            if (r.length) { const p = num(r[0].POSITION ?? r[0].position); region = [p - 150_000, p + 150_000] }
          } else {
            const r = await q(`SELECT START_POS, END_POS FROM GRAGEN_DB.GRAGEN.AUTISM_GENES
                                WHERE CHROM='${chrom}' ORDER BY ABS((START_POS+END_POS)/2-${center}) LIMIT 1`)
            if (r.length) {
              const s = num(r[0].START_POS ?? r[0].start_pos), e = num(r[0].END_POS ?? r[0].end_pos)
              const pad = Math.max(50_000, e - s)
              region = [s - pad, e + pad]
            }
          }
          if (region) {
            annoJumpedRef.current = key
            setAnnoLoading(false)
            goToRegion(chrom, region[0], region[1])   // refetch variants + reload annos via effect
            return
          }
        }
      }
      setAnnotations(annos)
    } catch {
      setAnnotations([])
    } finally {
      setAnnoLoading(false)
    }
  }, [annoSource, chrom, startPos, endPos, goToRegion])

  // Reload annotations when the source, chromosome, or region changes (while visible)
  useEffect(() => {
    if (annoShow) loadAnnotations(annoSource)
  }, [annoShow, annoSource, chrom, startPos, endPos, loadAnnotations])

  // ── Chat-driven UI control ──────────────────────────────────────────────
  // Parses each user message for navigation/annotation intents and drives the
  // viewer accordingly. Returns silently when nothing matches (the agent still
  // answers the question normally).
  const applyChatIntent = useCallback(async (msg: string) => {
    const m = msg.toLowerCase()
    const queryOne = async (sql: string): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, database: 'GRAGEN_DB', schema: 'GRAGEN' }),
        })
        const j = await res.json() as { data?: Record<string, unknown>[] }
        return j.data?.[0] ?? null
      } catch { return null }
    }
    const jumpToLocus = (c: string, center: number, pad = 100_000) => {
      goToRegion(c, Math.max(0, center - pad), center + pad)  // also refetches variants
      setView('3d'); setView3dSub('helix')
    }

    // 1. ClinVar significance filters (imply ClinVar source + show)
    let matchedSig = false
    if (/patho/.test(m))            { setClinFilter(/likely/.test(m) ? [3, 4] : [4]); matchedSig = true }
    else if (/\bvus\b|uncertain/.test(m)) { setClinFilter([2]); matchedSig = true }
    else if (/benign/.test(m))      { setClinFilter([0, 1]); matchedSig = true }
    else if (/conflicting/.test(m)) { setClinFilter([5]); matchedSig = true }
    if (matchedSig) { setAnnoSource('clinvar'); setAnnoShow(true) }

    // 2. Annotation source switches
    if (/\bgwas\b|association|trait/.test(m))      { setAnnoSource('gwas');  setAnnoShow(true) }
    else if (/autism|sfari/.test(m))               { setAnnoSource('sfari'); setAnnoShow(true) }
    else if (/clinvar|disease|clinical/.test(m))   { setAnnoSource('clinvar'); setAnnoShow(true) }

    // 3. Sample switch by sex (1000G: 1=male, 2=female)
    const wantsFemale = /\bfemale\b|\bwoman\b|\bher\b/.test(m)
    const wantsMale   = !wantsFemale && (/\bmale\b|\bman\b|\bhis\b/.test(m))
    if ((wantsFemale || wantsMale) && /sample|someone|person|individual|switch|show/.test(m)) {
      const sexClause = wantsFemale ? `(SEX='2' OR UPPER(SEX)='FEMALE')` : `(SEX='1' OR UPPER(SEX)='MALE')`
      const row = await queryOne(
        `SELECT SAMPLE_ID FROM GRAGEN_DB.GRAGEN.SAMPLE_METRICS
          WHERE ${sexClause} ORDER BY RANDOM() LIMIT 1`)
      const sid = row && String(row.SAMPLE_ID ?? row.sample_id ?? '')
      if (sid) { setSampleId(sid); setView('browser') }
      return
    }

    // 4. Chromosome jump ("go to chr7" / "chromosome 3")
    const chrMatch = m.match(/chr(?:omosome)?\s*([0-9]{1,2}|x|y)\b/)
    if (chrMatch) {
      const c = `chr${chrMatch[1].toUpperCase() === 'X' ? 'X' : chrMatch[1].toUpperCase() === 'Y' ? 'Y' : chrMatch[1]}`
      if (seededChroms.includes(c)) {
        goToRegion(c, 1_000_000, 5_000_000)
        setView('3d'); setView3dSub('helix')
      }
      return
    }

    // 5. Gene jump ("jump to SHANK3", "show me the CHD8 region")
    const geneMatch = msg.match(/(?:jump to|go to|show(?: me)?|navigate to|find|zoom (?:in )?to)\s+(?:the\s+)?(?:gene\s+)?([A-Za-z][A-Za-z0-9]{1,9})\b/)
    if (geneMatch) {
      const gene = geneMatch[1].toUpperCase()
      // Prefer the curated SFARI table (has explicit gene regions)
      const sfari = await queryOne(
        `SELECT CHROM, START_POS, END_POS FROM GRAGEN_DB.GRAGEN.AUTISM_GENES
          WHERE UPPER(GENE)='${gene}' LIMIT 1`)
      if (sfari) {
        const c = String(sfari.CHROM ?? sfari.chrom)
        const s = Number(sfari.START_POS ?? sfari.start_pos)
        const e = Number(sfari.END_POS ?? sfari.end_pos)
        jumpToLocus(c, Math.round((s + e) / 2), Math.max(50_000, Math.round((e - s))))
        setAnnoSource('sfari'); setAnnoShow(true)
        return
      }
      // Fall back to a ClinVar gene hit
      const clin = await queryOne(
        `SELECT CHROM, MIN(POSITION) AS S, MAX(POSITION) AS E
           FROM GRAGEN_DB.GRAGEN.CHR22_CLINVAR
          WHERE UPPER(GENE)='${gene}' GROUP BY CHROM LIMIT 1`)
      if (clin) {
        const c = String(clin.CHROM ?? clin.chrom)
        const s = Number(clin.S ?? clin.s), e = Number(clin.E ?? clin.e)
        if (c && seededChroms.includes(c)) {
          jumpToLocus(c, Math.round((s + e) / 2))
          setAnnoSource('clinvar'); setAnnoShow(true)
        }
      }
    }
  }, [seededChroms, goToRegion])

  // Load sample metadata when sample changes
  useEffect(() => {
    fetch(`/api/direct/metrics/${encodeURIComponent(sampleId)}`)
      .then(r => r.json())
      .then(d => setSampleMeta(d as SampleMetrics))
      .catch(() => setSampleMeta(null))
  }, [sampleId])

  // Load trio pedigree (father/mother) for the current sample from SAMPLE_PEDIGREE
  useEffect(() => {
    setPedigree(null)
    fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sql: `SELECT FATHER_ID, MOTHER_ID FROM GRAGEN_DB.GRAGEN.SAMPLE_PEDIGREE WHERE SAMPLE_ID='${sampleId.replace(/'/g, "''")}' LIMIT 1`,
        database: 'GRAGEN_DB', schema: 'GRAGEN',
      }),
    })
      .then(r => r.json())
      .then((d: { data?: Record<string, unknown>[] }) => {
        const row = d.data?.[0]
        if (!row) return
        const father = (row.FATHER_ID ?? row.father_id) as string | null
        const mother = (row.MOTHER_ID ?? row.mother_id) as string | null
        setPedigree({ father: father || undefined, mother: mother || undefined })
      })
      .catch(() => setPedigree(null))
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
    getFillColor: (d: typeof varScatterData[0]) => [...(VARIANT_COLORS[VTYPE_LABELS[d.type] ?? 'SNP'] ?? [150, 150, 150]), 220] as [number, number, number, number],
    getRadius: 4,
    radiusUnits: 'pixels',
    pickable: true,
    onHover: (info: { object?: typeof varScatterData[0]; x?: number; y?: number }) => {
      if (info.object) {
        setVarTooltip({
          x: info.x ?? 0, y: info.y ?? 0,
          content: {
            POS: info.object.pos,
            Type: VTYPE_LABELS[Number(info.object.type)] ?? String(info.object.type),
            AF: info.object.value != null ? Number(info.object.value).toFixed(4) : 'N/A',
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
    <div className="app">

      {/* ── Sidebar (Snowflake module) ───────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="mark">🧬</div>
          <div>
            <span>GRAGEN</span>
            <small>Genomics Accelerator</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">Explore</div>
          {([
            ['scatter', '📊', 'Cohort QC'],
            ['map',     '🌍', 'Origins'],
            ['browser', '🔬', 'Genome Browser'],
            ['3d',      '🧬', '3D View'],
          ] as [ViewMode, string, string][]).map(([v, ico, label]) => (
            <button
              key={v}
              className={`sidebar-link ${view === v ? 'active' : ''}`}
              onClick={() => setView(v)}
            >
              <span className="ico">{ico}</span> {label}
            </button>
          ))}

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
                {sampleMeta.sex && <span>{(sampleMeta.sex === '1' || sampleMeta.sex === 'male') ? '♂' : '♀'}</span>}
                {sampleMeta.mean_coverage && <div>Coverage: {sampleMeta.mean_coverage}×</div>}
                {sampleMeta.titv_ratio    && <div>Ti/Tv: {sampleMeta.titv_ratio}</div>}
                {sampleMeta.total_variants && <div>Variants: {sampleMeta.total_variants.toLocaleString()}</div>}
              </div>
            )}

            {/* Trio family — clickable mother/father (1000G pedigree) */}
            {pedigree && (pedigree.father || pedigree.mother) ? (
              <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, fontWeight: 700 }}>
                  👪 Trio — compare with parents
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {pedigree.father && (
                    <button
                      className="btn secondary small"
                      style={{ flex: 1, justifyContent: 'center', fontFamily: 'monospace' }}
                      title={`Switch to father ${pedigree.father}`}
                      onClick={() => setSampleId(pedigree.father!)}
                    >♂ {pedigree.father}</button>
                  )}
                  {pedigree.mother && (
                    <button
                      className="btn secondary small"
                      style={{ flex: 1, justifyContent: 'center', fontFamily: 'monospace' }}
                      title={`Switch to mother ${pedigree.mother}`}
                      onClick={() => setSampleId(pedigree.mother!)}
                    >♀ {pedigree.mother}</button>
                  )}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginTop: 5 }}>
                  Click a parent to load their genome for comparison.
                </div>
              </div>
            ) : pedigree ? (
              <div style={{ marginBottom: 12, fontSize: 10, color: 'var(--text-secondary)' }}>
                👤 Founder sample — no parents in the 1000G panel.
              </div>
            ) : null}

            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>Region</div>
            <select
              value={chrom}
              onChange={e => {
                  setChrom(e.target.value)
                  // Reset to known good region for chr22; for others default to start
                  if (e.target.value === 'chr22') {
                    setStartPos(20_900_000)
                    setEndPos(21_100_000)
                  } else {
                    setStartPos(1_000_000)
                    setEndPos(5_000_000)
                  }
                }}
              style={{ width: '100%', marginBottom: 6, padding: '4px 8px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11 }}
            >
              {seededChroms.length > 0
                ? seededChroms.map(c => <option key={c} value={c}>{c} ({((CHROM_LENGTHS[c] ?? 0) / 1e6).toFixed(0)} Mb) ✓ in Zarr</option>)
                : CHROMOSOMES.map(c => <option key={c} value={c}>{c} ({(CHROM_LENGTHS[c] / 1e6).toFixed(0)} Mb)</option>)
              }
              {seededChroms.length > 0 && CHROMOSOMES.filter(c => !seededChroms.includes(c)).map(c =>
                <option key={c} value={c} disabled>{c} — not seeded (use Data Management)</option>
              )}
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
              onClick={() => fetchVariants()}
              disabled={browsing}
            >
              {browsing ? '⏳ Loading…' : '🔍 Fetch Variants'}
            </button>

            {browseError && <div style={{ fontSize: 10, color: 'var(--red)', marginBottom: 6 }}>⚠ {browseError}</div>}

            {varResult && (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {varResult.count?.toLocaleString() ?? 0} variants {varResult.truncated ? '(truncated)' : ''} · {varResult.density ? 'density view' : 'individual'}
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
                  {clinVarResult.count?.toLocaleString() ?? 0} ClinVar variants
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

        {/* ── Data Management ──────────────────────────────────────── */}
          <div className="sidebar-section">Data</div>
          <DataManagementPanel />
        </nav>

        {/* Genomics Agent chat */}
        <div style={{ height: 300, borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <ChatPanel contextMessage={agentContext} onUserMessage={applyChatIntent} />
        </div>

        <div className="sidebar-footer">
          <div className="ctx"><span className="status-dot green" /> GRAGEN_DB.GRAGEN</div>
          <div className="sub">{acct ?? 'Snowflake'}{meta?.sample_count != null ? ` · ${meta.sample_count.toLocaleString()} samples` : ''}</div>
        </div>
      </aside>

      {/* ── Main content ──────────────────────────────────────────────── */}
      <div className="app-content">
        <header className="app-header">
          <h1>{VIEW_TITLES[view]}</h1>
          <div className="app-header-actions">
            <span className="badge blue">1000 Genomes · DRAGEN · hg38</span>
          </div>
        </header>

        <div className="app-main" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>

        {/* ── Cohort QC dashboard ───────────────────────────────── */}
        {view === 'scatter' && (
          <CohortQC
            data={visibleSamples}
            loading={cohortLoading}
            error={cohortError}
            onSelectSample={s => {
              setSampleId(s.sample_id)
              setSampleMeta(s)
              setView('browser')
            }}
          />
        )}
                {/* ── Geographic origins map ─────────────────────────────── */}
        {view === 'map' && (
          <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
              🌍 Sample Geographic Origins — 1000 Genomes Panel
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {popStats.length > 0
                ? `${popStats.reduce((a,b)=>a+b.cnt,0).toLocaleString()} samples · ${new Set(popStats.map(p=>p.population)).size} populations · circle = sample count`
                : 'Loading sample origins…'}
            </div>
            <div style={{ flex: 1, minHeight: 380, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
              {cohortLoading
                ? <div style={{ display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:'var(--text-secondary)' }}>Loading…</div>
                : <CohortGlobe popStats={popStats} />
              }
            </div>
          </div>
        )}

        {/* ── 3D DNA Helix view ─────────────────────────────────────── */}
        {view === '3d' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, overflow: 'hidden' }}>
            {/* Sub-tab selector */}
            <div style={{ display: 'flex', gap: 8, padding: '10px 16px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'var(--bg-secondary)' }}>
              {['helix', 'tracks'].map(sub => (
                <button key={sub}
                  onClick={() => setView3dSub(sub as 'helix' | 'tracks')}
                  className={`btn small ${view3dSub === sub ? 'primary' : 'secondary'}`}
                  style={{ marginBottom: -1 }}
                >
                  {sub === 'helix' ? '🧬 DNA Helix' : '📊 Genomic Tracks'}
                </button>
              ))}
            </div>
            {/* Helix */}
            {view3dSub === 'helix' && (
              <DNAHelix
                variants={varResult?.variants ?? []}
                chrom={chrom}
                startPos={startPos}
                endPos={endPos}
                sampleId={sampleId}
                onExplain={msg => setAgentContext({ text: msg, nonce: Date.now() })}
                annotations={annotations}
                annoSource={annoSource}
                annoShow={annoShow}
                annoLoading={annoLoading}
                onSetAnnoSource={setAnnoSource}
                onToggleAnno={setAnnoShow}
                onRequestAnno={() => loadAnnotations(annoSource)}
                clinFilter={clinFilter}
                onSetClinFilter={setClinFilter}
              />
            )}
            {/* Gosling tracks */}
            {view3dSub === 'tracks' && (
              <GoslingTracks
                variants={varResult?.variants ?? []}
                chrom={chrom}
                startPos={startPos}
                endPos={endPos}
              />
            )}
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
                {varResult && <span>{varResult.count?.toLocaleString() ?? 0} variants{varResult.truncated ? ' (capped at 100k)' : ''}</span>}
              </div>
            </div>

            {/* Variant type legend */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {Object.entries(VARIANT_COLORS).filter(([k]) => k !== 'REF').map(([type, color]) => {
                // Backend sends type as integer; map to string label for comparison
                const typeNum = Object.entries(VTYPE_LABELS).find(([, v]) => v === type)?.[0]
                const count = varResult?.variants.filter(v => String(v.type) === typeNum).length ?? 0
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
                        {['POS', 'TYPE', 'ALLELE FREQ'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)', fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {varResult!.variants.slice(0, 50).map((v, i) => {
                                                const typeLabel = VTYPE_LABELS[v.type] ?? 'SNP'
                        const color = VARIANT_COLORS[typeLabel] ?? [150, 150, 150]
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{v.pos.toLocaleString()}</td>
                            <td style={{ padding: '3px 8px' }}>
                              <span style={{ background: `rgb(${color.join(',')})`, color: '#fff', padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{typeLabel}</span>
                            </td>
                            <td style={{ padding: '3px 8px' }}>{typeof v.value === 'number' ? v.value.toFixed(4) : '.'}</td>
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
    </div>
  )
}
