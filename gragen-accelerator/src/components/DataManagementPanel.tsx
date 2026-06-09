import { useCallback, useEffect, useState } from 'react'

interface ChromStatus {
  chrom: string
  in_zarr: boolean
  samples?: number
}

interface DataState {
  chroms: ChromStatus[]
  loading: boolean
  error: string | null
  seedingChrom: string | null
  seedStatus: string | null
}

const CHROM_LIST = [
  'chr1','chr2','chr3','chr4','chr5','chr6','chr7','chr8','chr9','chr10',
  'chr11','chr12','chr13','chr14','chr15','chr16','chr17','chr18','chr19','chr20',
  'chr21','chr22','chrX','chrY',
]

export function DataManagementPanel() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<DataState>({
    chroms: [], loading: false, error: null,
    seedingChrom: null, seedStatus: null,
  })

  // Zarr chromosome status comes straight from the backend /meta endpoint
  // (chromosomes_in_store) via the Express proxy. Genome variants live in the
  // IceChunk Zarr store only — there is no per-chromosome Iceberg table.
  const loadStatus = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const res = await fetch('/api/meta')
      const meta = await res.json() as { chromosomes_in_store?: Record<string, { n_samples?: number }> }
      const zarr = meta.chromosomes_in_store ?? {}
      const chroms: ChromStatus[] = CHROM_LIST.map(c => ({
        chrom: c,
        in_zarr: c in zarr,
        samples: zarr[c]?.n_samples,
      }))
      setState(s => ({ ...s, chroms, loading: false }))
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: String(err) }))
    }
  }, [])

  useEffect(() => { if (open) loadStatus() }, [open, loadStatus])

  // Launch the out-of-container ingest job (EXECUTE JOB SERVICE on
  // GRAGEN_INGEST_POOL, 16 workers) via the SEED_CHROMOSOME stored proc. The
  // proc returns immediately (ASYNC); the job ingests the chromosome's 1000G
  // VCF into the Zarr store and restarts the backend on completion.
  const seedChrom = useCallback(async (chrom: string) => {
    setState(s => ({ ...s, seedingChrom: chrom, seedStatus: `Launching ingest job for ${chrom}…` }))
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `CALL GRAGEN_DB.GRAGEN.SEED_CHROMOSOME('${chrom}')`,
          database: 'GRAGEN_DB', schema: 'GRAGEN',
        }),
      })
      const json = await res.json() as { data?: Record<string, unknown>[] }
      const raw = json.data?.[0]?.['SEED_CHROMOSOME'] ?? json.data?.[0]?.['seed_chromosome']
      const result = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown> ?? {})
      setState(s => ({
        ...s, seedingChrom: null,
        seedStatus: result.status === 'seeding'
          ? `✓ ${chrom} ingest launched (job ${result.job ?? ''}). Runs ~5–15 min on the ingest pool; the backend auto-restarts on completion. Click Refresh Status when done.`
          : `Status: ${JSON.stringify(result).slice(0, 120)}`,
      }))
    } catch (err) {
      setState(s => ({ ...s, seedingChrom: null, seedStatus: `Error: ${err}` }))
    }
  }, [])

  const zCount = state.chroms.filter(c => c.in_zarr).length

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
          {zCount > 0 ? `${zCount} chrom${zCount === 1 ? '' : 's'} in Zarr` : 'click to expand'} {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          {state.loading && <div style={{ color: 'var(--text-secondary)' }}>Loading status…</div>}
          {state.error && <div style={{ color: 'var(--red)' }}>{state.error}</div>}

          {state.chroms.length > 0 && (
            <div style={{ overflowY: 'auto', maxHeight: 220 }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 90px 70px',
                gap: 2, marginBottom: 4, fontWeight: 600,
                color: 'var(--text-secondary)', fontSize: 10,
              }}>
                <span>Chrom</span><span>Zarr</span><span></span>
              </div>
              {state.chroms.map(c => (
                <div key={c.chrom} style={{
                  display: 'grid', gridTemplateColumns: '1fr 90px 70px',
                  gap: 2, alignItems: 'center', padding: '2px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{c.chrom}</span>
                  <span style={{ color: c.in_zarr ? 'var(--green)' : 'var(--text-secondary)', fontSize: 10 }}>
                    {c.in_zarr ? `✓ ${c.samples ? `(${(c.samples/1000).toFixed(0)}k)` : ''}` : '—'}
                  </span>
                  <span>
                    {!c.in_zarr && c.chrom !== 'chrY' && (
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
            <div style={{ marginTop: 6, padding: '4px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {state.seedStatus}
            </div>
          )}

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
