import { useCallback, useEffect, useState } from 'react'

interface ChromStatus {
  chrom: string
  in_zarr: boolean
  in_iceberg: boolean
  samples?: number
}

interface DataState {
  chroms: ChromStatus[]
  loading: boolean
  error: string | null
  seedingChrom: string | null
  seedStatus: string | null
  materializeStatus: string | null
  materializing: boolean
}

const CHROM_LIST = [
  'chr1','chr2','chr3','chr4','chr5','chr6','chr7','chr8','chr9','chr10',
  'chr11','chr12','chr13','chr14','chr15','chr16','chr17','chr18','chr19','chr20',
  'chr21','chr22','chrX','chrY',
]

function ClinVarRefresh() {
  const [status, setStatus] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const refresh = useCallback(async () => {
    setRunning(true)
    setStatus('Starting ClinVar refresh from NCBI…')
    try {
      // Step 1: Seed ClinVar into Zarr via EXECUTE JOB SERVICE
      const r1 = await fetch('/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `SELECT GRAGEN_DB.GRAGEN.GRAGEN_SEED_CLINVAR(ARRAY_CONSTRUCT('chr22')) AS result`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const j1 = await r1.json() as { data?: Record<string,unknown>[] }
      const raw1 = j1.data?.[0]?.['RESULT']
      const res1 = typeof raw1 === 'string' ? JSON.parse(raw1) : (raw1 as Record<string,unknown> ?? {})
      setStatus(`✓ ClinVar seed job started (${res1.status ?? 'running'}) — downloads from NCBI FTP. Takes ~2 min. Then cache to Iceberg when done.`)
    } catch (err) {
      setStatus(`Error: ${err}`)
    } finally {
      setRunning(false)
    }
  }, [])

  const cacheToIceberg = useCallback(async () => {
    setRunning(true)
    setStatus('Caching ClinVar from Zarr → Iceberg…')
    try {
      const r = await fetch('/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `CALL GRAGEN_DB.GRAGEN.MATERIALIZE_ICEBERG_TABLES(ARRAY_CONSTRUCT('chr22'))`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const j = await r.json() as { data?: Record<string,unknown>[] }
      setStatus(`✓ ClinVar cached to Iceberg. ${JSON.stringify(j.data?.[0] ?? {}).slice(0, 80)}`)
    } catch (err) {
      setStatus(`Error: ${err}`)
    } finally {
      setRunning(false)
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        className="btn secondary small"
        style={{ width: '100%', justifyContent: 'center', fontSize: 10 }}
        onClick={refresh}
        disabled={running}
      >
        {running ? '⏳ Running…' : '⬇ Refresh from NCBI FTP'}
      </button>
      <button
        className="btn secondary small"
        style={{ width: '100%', justifyContent: 'center', fontSize: 10 }}
        onClick={cacheToIceberg}
        disabled={running}
      >
        ❄️ Cache ClinVar → Iceberg
      </button>
      {status && (
        <div style={{ fontSize: 9, color: 'var(--text-secondary)', padding: '3px 0', lineHeight: 1.4 }}>
          {status}
        </div>
      )}
    </div>
  )
}

export function DataManagementPanel() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<DataState>({
    chroms: [], loading: false, error: null,
    seedingChrom: null, seedStatus: null, materializeStatus: null, materializing: false,
  })

  const loadStatus = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `SELECT PARSE_JSON(GRAGEN_DB.GRAGEN.GRAGEN_META()) AS meta`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const json = await res.json() as { data?: Record<string, unknown>[] }
      const row = json.data?.[0]
      let meta: Record<string, unknown> = {}
      if (row) {
        const raw = row['META'] ?? row['meta']
        meta = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown> ?? {})
      }
      const zarr = (meta.chromosomes_in_store ?? {}) as Record<string, { n_samples?: number }>

      // Check Iceberg
      const iceRes = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `SELECT DISTINCT CHROM FROM GRAGEN_DB.GRAGEN.CHR22_VARIANTS LIMIT 50`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const iceJson = await iceRes.json() as { data?: Record<string, unknown>[] }
      const icebergChroms = new Set((iceJson.data ?? []).map(r => String(r['CHROM'] ?? r['chrom'] ?? '')))

      const chroms: ChromStatus[] = CHROM_LIST.map(c => ({
        chrom: c,
        in_zarr: c in zarr,
        in_iceberg: icebergChroms.has(c) || icebergChroms.has(c.replace('chr','')),
        samples: zarr[c]?.n_samples,
      }))

      setState(s => ({ ...s, chroms, loading: false }))
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: String(err) }))
    }
  }, [])

  useEffect(() => { if (open) loadStatus() }, [open, loadStatus])

  const seedChrom = useCallback(async (chrom: string) => {
    setState(s => ({ ...s, seedingChrom: chrom, seedStatus: `Starting seed for ${chrom}…` }))
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `SELECT GRAGEN_DB.GRAGEN.GRAGEN_SEED_GENOMICS(ARRAY_CONSTRUCT('${chrom}')) AS result`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const json = await res.json() as { data?: Record<string, unknown>[] }
      const raw = json.data?.[0]?.['RESULT']
      const result = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string,unknown> ?? {})
      setState(s => ({
        ...s, seedingChrom: null,
        seedStatus: result.status === 'seeding'
          ? `✓ Seeding ${chrom} started — this takes ~5 minutes. Refresh status when done.`
          : `Status: ${JSON.stringify(result).slice(0, 80)}`,
      }))
    } catch (err) {
      setState(s => ({ ...s, seedingChrom: null, seedStatus: `Error: ${err}` }))
    }
  }, [])

  const cacheToIceberg = useCallback(async () => {
    const zChroms = state.chroms.filter(c => c.in_zarr).map(c => c.chrom)
    if (!zChroms.length) { setState(s => ({ ...s, materializeStatus: 'No chromosomes in Zarr to cache' })); return }
    setState(s => ({ ...s, materializing: true, materializeStatus: `Caching ${zChroms.join(', ')} to Iceberg…` }))
    try {
      const chromsStr = zChroms.map(c => `'${c}'`).join(',')
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `CALL GRAGEN_DB.GRAGEN.MATERIALIZE_ICEBERG_TABLES(ARRAY_CONSTRUCT(${chromsStr}))`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const json = await res.json() as { data?: Record<string, unknown>[] }
      const r = json.data?.[0]
      setState(s => ({ ...s, materializing: false, materializeStatus: r ? `✓ ${JSON.stringify(r).slice(0,120)}` : '✓ Materialization complete' }))
      loadStatus()
    } catch (err) {
      setState(s => ({ ...s, materializing: false, materializeStatus: `Error: ${err}` }))
    }
  }, [state.chroms, loadStatus])

  const zCount = state.chroms.filter(c => c.in_zarr).length
  const iCount = state.chroms.filter(c => c.in_iceberg).length

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          width: '100%', textAlign: 'left', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          color: 'var(--text-primary)', fontSize: 11, fontWeight: 600,
        }}
      >
        <span>💾 Data Management</span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {zCount > 0 ? `${zCount} Zarr · ${iCount} Iceberg` : 'click to expand'} {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          {state.loading && <div style={{ color: 'var(--text-secondary)' }}>Loading status…</div>}
          {state.error && <div style={{ color: 'var(--red)' }}>{state.error}</div>}

          {state.chroms.length > 0 && (
            <div style={{ overflowY: 'auto', maxHeight: 200 }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 50px 50px 70px',
                gap: 2, marginBottom: 4, fontWeight: 600,
                color: 'var(--text-secondary)', fontSize: 10,
              }}>
                <span>Chrom</span><span>Zarr</span><span>Iceberg</span><span></span>
              </div>
              {state.chroms.map(c => (
                <div key={c.chrom} style={{
                  display: 'grid', gridTemplateColumns: '1fr 50px 50px 70px',
                  gap: 2, alignItems: 'center', padding: '2px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{c.chrom}</span>
                  <span style={{ color: c.in_zarr ? 'var(--green)' : 'var(--text-secondary)', fontSize: 10 }}>
                    {c.in_zarr ? `✓ ${c.samples ? `(${(c.samples/1000).toFixed(0)}k)` : ''}` : '—'}
                  </span>
                  <span style={{ color: c.in_iceberg ? 'var(--green)' : 'var(--text-secondary)', fontSize: 10 }}>
                    {c.in_iceberg ? '✓' : '—'}
                  </span>
                  <span>
                    {!c.in_zarr && (
                      <button
                        className="btn secondary small"
                        style={{ fontSize: 9, padding: '2px 4px' }}
                        onClick={() => seedChrom(c.chrom)}
                        disabled={state.seedingChrom !== null}
                      >
                        {state.seedingChrom === c.chrom ? '…' : '⬇ Seed'}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Seed status */}
          {state.seedStatus && (
            <div style={{ marginTop: 6, padding: '4px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
              {state.seedStatus}
            </div>
          )}

          {/* Cache to Iceberg */}
          {zCount > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 }}>
                Cache Zarr data → Iceberg for SQL analytics &amp; Cortex Analyst
              </div>
              <button
                className="btn primary small"
                style={{ width: '100%', justifyContent: 'center', fontSize: 10 }}
                onClick={cacheToIceberg}
                disabled={state.materializing}
              >
                {state.materializing ? '⏳ Materializing…' : '❄️ Cache to Iceberg'}
              </button>
              {state.materializeStatus && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
                  {state.materializeStatus}
                </div>
              )}
            </div>
          )}

          {/* ClinVar section */}
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>🧬 ClinVar (NCBI)</div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Refresh clinical variant annotations from NCBI FTP. Data changes weekly.
            </div>
            <ClinVarRefresh />
          </div>

          <button
            className="btn secondary small"
            style={{ marginTop: 8, width: '100%', justifyContent: 'center', fontSize: 10 }}
            onClick={loadStatus}
          >
            ↻ Refresh Status
          </button>
        </div>
      )}
    </div>
  )
}
