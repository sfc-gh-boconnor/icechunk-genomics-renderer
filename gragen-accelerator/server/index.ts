import express, { Request, Response } from 'express'
import path from 'path'
import { spawnSync } from 'child_process'
import https from 'https'
import fs from 'fs'
import zlib from 'zlib'

const app = express()
app.use(express.json({ limit: '10mb' }))

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)
  next()
})

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const DIST = path.join(__dirname, '../dist')

const GRAGEN_SERVICE_URL = process.env.GRAGEN_SERVICE_URL || 'http://gragen-service:8080'
const SF_HOST      = process.env.SNOWFLAKE_HOST      ?? ''
const SF_DATABASE  = process.env.SNOWFLAKE_DATABASE  ?? 'GRAGEN_DB'
const SF_SCHEMA    = process.env.SNOWFLAKE_SCHEMA    ?? 'GRAGEN'
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE ?? 'XSMALL'
const isSpcs = !!(process.env.SNOWFLAKE_HOST || fs.existsSync('/snowflake/session/token'))

function getServiceToken(): string {
  if (process.env.SNOWFLAKE_TOKEN) return process.env.SNOWFLAKE_TOKEN
  try {
    const t = fs.readFileSync('/snowflake/session/token', 'utf8').trim()
    if (t) return t
  } catch { /* file not present */ }
  return ''
}

// ── Snowflake SQL REST API (mirrors IceChunk implementation) ──────────────────

async function snowSqlSpcs(
  sql: string,
  database: string | undefined,
  schema: string | undefined,
  _userAuthHeader?: string,
): Promise<unknown[]> {
  const host = SF_HOST ||
    (process.env.SNOWFLAKE_ACCOUNT
      ? `${process.env.SNOWFLAKE_ACCOUNT.toLowerCase().replace(/_/g, '-')}.snowflakecomputing.com`
      : '')
  if (!host) throw new Error('Neither SNOWFLAKE_HOST nor SNOWFLAKE_ACCOUNT is set')

  const db  = database ?? SF_DATABASE
  const sch = schema   ?? SF_SCHEMA
  const wh  = SF_WAREHOUSE
  const authToken = getServiceToken()
  if (!authToken) throw new Error('No service token')

  const body = JSON.stringify({ statement: sql, database: db, schema: sch, warehouse: wh, timeout: 300 })

  return new Promise((resolve, reject) => {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'identity',
      'Authorization': `Bearer ${authToken}`,
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
      'User-Agent': 'gragen-accelerator/1.0',
    }

    type PartitionResult = { cols: string[]; rows: unknown[]; handle?: string; partitions: number; status: number }

    function fetchPartition(path: string, knownCols?: string[]): Promise<PartitionResult> {
      return new Promise((res, rej) => {
        const method = path === '/api/v2/statements' ? 'POST' : 'GET'
        const opts = { hostname: host, path, method, headers: baseHeaders }
        const request = https.request(opts, httpRes => {
          const chunks: Buffer[] = []
          httpRes.on('data', (chunk: Buffer) => chunks.push(chunk))
          httpRes.on('end', () => {
            const raw = Buffer.concat(chunks)
            const encoding = httpRes.headers['content-encoding']
            const httpStatus = httpRes.statusCode ?? 200
            const parseResponse = (text: string) => {
              try {
                if (httpStatus < 200 || (httpStatus >= 300 && httpStatus !== 202)) {
                  rej(new Error(`SF API HTTP ${httpStatus}: ${text.slice(0, 200)}`)); return
                }
                const json = JSON.parse(text)
                if (json.message && json.sqlState && json.sqlState !== '00000') {
                  rej(new Error(json.message)); return
                }
                const cols: string[] = json.resultSetMetaData?.rowType
                  ? json.resultSetMetaData.rowType.map((c: { name: string }) => c.name)
                  : (knownCols ?? [])
                const rows = (json.data ?? []).map((row: string[]) => {
                  const obj: Record<string, unknown> = {}
                  cols.forEach((c, i) => { obj[c] = row[i] })
                  return obj
                })
                res({ cols, rows, handle: json.statementHandle, partitions: json.resultSetMetaData?.partitionInfo?.length ?? 1, status: httpStatus })
              } catch { rej(new Error(`SF API parse error: ${text.slice(0, 400)}`)) }
            }
            if (encoding === 'gzip' || encoding === 'deflate') {
              zlib.gunzip(raw, (err, dec) => {
                if (err) { rej(new Error(`SF API decompress error: ${err.message}`)); return }
                parseResponse(dec.toString('utf8'))
              })
            } else { parseResponse(raw.toString('utf8')) }
          })
        })
        request.on('error', rej)
        if (method === 'POST') request.write(body)
        request.end()
      })
    }

    fetchPartition('/api/v2/statements').then(async (first) => {
      let current: PartitionResult = first
      if (current.status === 202 && current.handle) {
        for (let i = 0; i < 90; i++) {
          await new Promise(r => setTimeout(r, 2000))
          current = await fetchPartition(`/api/v2/statements/${current.handle}`, current.cols)
          if (current.status !== 202) break
        }
        if (current.status === 202) { reject(new Error('SF API: statement still executing after 3 min')); return }
      }
      const { cols, rows: firstRows, handle, partitions } = current
      console.log(`SF API: ${partitions} partition(s), handle=${handle?.slice(0, 12) ?? 'none'}`)
      if (!handle || !partitions || partitions <= 1) { resolve(firstRows); return }
      const remaining = await Promise.all(
        Array.from({ length: partitions - 1 }, (_, i) => fetchPartition(`/api/v2/statements/${handle}?partition=${i + 1}`, cols))
      )
      const allRows: unknown[] = [...firstRows]
      remaining.forEach(part => allRows.push(...part.rows))
      resolve(allRows)
    }).catch(reject)
  })
}

function snowSqlLocal(sql: string, database?: string, schema?: string): unknown[] {
  const db  = (database ?? SF_DATABASE).replace(/[^A-Za-z0-9_]/g, '')
  const sch = (schema   ?? SF_SCHEMA  ).replace(/[^A-Za-z0-9_]/g, '')
  const result = spawnSync('snow', ['sql', '-c', 'internal-marketplace', '-q', sql, '--database', db, '--schema', sch, '--format', 'json'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'snow sql failed')
  const out = result.stdout?.trim()
  if (!out) return []
  const start = out.indexOf('[')
  if (start === -1) return []
  return JSON.parse(out.slice(start))
}

async function runSql(sql: string, database?: string, schema?: string, userAuthHeader?: string): Promise<unknown[]> {
  if (isSpcs) return snowSqlSpcs(sql, database, schema, userAuthHeader)
  return snowSqlLocal(sql, database, schema)
}

// ── CARTO tile proxy ────────────────────────────────────────────────────────
const tileCache = new Map<string, { data: Buffer; ts: number }>()
const TILE_TTL = 60 * 60 * 1000
app.get('/api/tiles/:z/:x/:y', (req: Request, res: Response) => {
  const z = String(req.params.z), x = String(req.params.x), y = String(req.params.y)
  const key = `${z}/${x}/${y}`
  const cached = tileCache.get(key)
  if (cached && Date.now() - cached.ts < TILE_TTL) {
    res.setHeader('Content-Type', 'image/png'); res.send(cached.data); return
  }
  const sub = ['a', 'b', 'c', 'd'][(parseInt(z) + parseInt(x) + parseInt(y)) % 4]
  https.get(`https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`, tileRes => {
    const chunks: Buffer[] = []
    tileRes.on('data', chunk => chunks.push(chunk as Buffer))
    tileRes.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (tileCache.size >= 2000) { const oldest = [...tileCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]; tileCache.delete(oldest[0]) }
      tileCache.set(key, { data: buf, ts: Date.now() })
      res.setHeader('Content-Type', 'image/png'); res.send(buf)
    })
  }).on('error', err => { console.error('Tile fetch error', err.message); res.status(502).send('Tile fetch failed') })
})

// ── SQL proxy (SELECT only) ───────────────────────────────────────────────────
const ALLOWED_SQL = /^\s*(SELECT|SHOW|DESCRIBE|DESC|WITH|CALL)\b/i
app.post('/api/query', async (req: Request, res: Response) => {
  const { sql, database, schema } = req.body as { sql?: string; database?: string; schema?: string }
  if (!sql) { res.status(400).json({ error: 'Missing sql' }); return }
  const trimmed = sql.trim()
  if (!ALLOWED_SQL.test(trimmed)) { res.status(400).json({ error: 'Only SELECT/SHOW/DESCRIBE/WITH/CALL allowed' }); return }
  try {
    const rows = await runSql(trimmed, database, schema)
    res.json({ data: rows })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Direct proxy to gragen-service ─────────────────────────────────────────────
async function proxyToService(path: string, body: unknown, res: Response) {
  try {
    const upstream = await fetch(`${GRAGEN_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await upstream.json()
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

app.post('/api/direct/variants', (req: Request, res: Response) => {
  proxyToService('/direct/variants', req.body, res)
})

app.post('/api/direct/clinvar', (req: Request, res: Response) => {
  proxyToService('/direct/clinvar', req.body, res)
})

app.post('/api/direct/seed_clinvar', (req: Request, res: Response) => {
  proxyToService('/seed_clinvar', req.body ?? {}, res)
})

app.get('/api/meta/clinvar', async (_req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${GRAGEN_SERVICE_URL}/meta/clinvar`)
    const data = await upstream.json()
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/direct/cohort_metrics', (req: Request, res: Response) => {
  proxyToService('/direct/cohort_metrics', req.body, res)
})

app.get('/api/direct/metrics/:sample_id', async (req: Request, res: Response) => {
  const sample_id = String(req.params.sample_id)
  try {
    const upstream = await fetch(`${GRAGEN_SERVICE_URL}/direct/metrics/${encodeURIComponent(sample_id)}`)
    const data = await upstream.json()
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/meta', async (_req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${GRAGEN_SERVICE_URL}/meta`)
    const data = await upstream.json()
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/samples', async (req: Request, res: Response) => {
  try {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(req.query).map(([k, v]) => [k, String(v ?? '')])
      )
    ).toString()
    const upstream = await fetch(`${GRAGEN_SERVICE_URL}/samples${qs ? '?' + qs : ''}`)
    const data = await upstream.json()
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Save variants to Snowflake table ─────────────────────────────────────────
app.post('/api/save-variants', async (req: Request, res: Response) => {
  const { table_name, sample_id, chrom, start_pos, end_pos } = req.body as {
    table_name?: string; sample_id?: string; chrom?: string; start_pos?: number; end_pos?: number
  }
  if (!table_name || !sample_id || !chrom) {
    res.status(400).json({ error: 'Missing table_name, sample_id, or chrom' }); return
  }
  const safeName  = table_name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  const safeSample = sample_id.replace(/[^A-Za-z0-9_]/g, '')
  const safeChrom  = chrom.replace(/[^A-Za-z0-9_]/g, '')
  const startExpr = Number(start_pos ?? 0)
  const endExpr   = Number(end_pos   ?? 300_000_000)

  const createSql = `CREATE OR REPLACE TABLE GRAGEN_DB.GRAGEN.${safeName} AS
SELECT f.value:pos::INTEGER          AS pos,
       f.value:ref::VARCHAR          AS ref,
       f.value:alts::VARIANT         AS alts,
       f.value:type::VARCHAR         AS variant_type,
       f.value:qual::FLOAT           AS qual,
       f.value:af::FLOAT             AS allele_freq,
       '${safeSample}'               AS sample_id,
       '${safeChrom}'                AS chrom,
       CURRENT_TIMESTAMP()           AS created_at
FROM (
  SELECT GRAGEN_DB.GRAGEN.GRAGEN_SLICE(
    '${safeSample}', '${safeChrom}', ${startExpr}, ${endExpr}
  ):variants AS v
) t,
LATERAL FLATTEN(input => t.v) f`

  try {
    await runSql(createSql, 'GRAGEN_DB', 'GRAGEN')
    const countRows = await runSql(`SELECT COUNT(*) AS n FROM GRAGEN_DB.GRAGEN.${safeName}`, 'GRAGEN_DB', 'GRAGEN') as Record<string, unknown>[]
    const rowCount = Number(countRows[0]?.N ?? countRows[0]?.n ?? 0)
    res.json({ table: `GRAGEN_DB.GRAGEN.${safeName}`, row_count: rowCount })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/save-variants]', msg)
    res.status(500).json({ error: msg })
  }
})

// ── Cortex Agent chat ─────────────────────────────────────────────────────────
const AGENT_DB     = 'GRAGEN_DB'
const AGENT_SCHEMA = 'GRAGEN'
const AGENT_NAME   = 'GENOMICS_AGENT'

app.post('/api/agent/chat', async (req: Request, res: Response) => {
  const { message, history = [] } = req.body as {
    message?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }
  if (!message) { res.status(400).json({ error: 'Missing message' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const emit = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const host = SF_HOST || ''
  if (!host) { emit('error', { error: 'SNOWFLAKE_HOST not set' }); res.end(); return }

  const authToken = getServiceToken()
  if (!authToken) { emit('error', { error: 'No SPCS service token' }); res.end(); return }

  const messages = [
    ...history.map(h => ({ role: h.role, content: [{ type: 'text', text: h.content }] })),
    { role: 'user', content: [{ type: 'text', text: message }] },
  ]

  const agentUrl = `https://${host}/api/v2/databases/${AGENT_DB}/schemas/${AGENT_SCHEMA}/agents/${AGENT_NAME}:run`

  try {
    const agentRes = await fetch(agentUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Snowflake-Authorization-Token-Type': 'OAUTH',
      },
      body: JSON.stringify({ messages, stream: true }),
    })
    if (!agentRes.ok) {
      const errText = await agentRes.text()
      emit('error', { error: `Cortex Agent API ${agentRes.status}: ${errText.slice(0, 400)}` })
      res.end(); return
    }
    const reader = agentRes.body?.getReader()
    if (!reader) { emit('error', { error: 'No readable body' }); res.end(); return }

    const decoder = new TextDecoder()
    let buffer = '', fullText = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      let currentEvent = ''
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue }
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>
          if (currentEvent === 'response.text.delta') {
            const text = parsed.text as string ?? ''
            if (text) { fullText += text; emit('token', { text }) }
          }
        } catch { /* skip */ }
      }
    }
    emit('result', { text: fullText || 'No response from agent.' })
  } catch (err) {
    emit('error', { error: err instanceof Error ? err.message : String(err) })
  }
  res.end()
})

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '1.0.1' }))
app.get('/healthz',    (_req, res) => res.send('ok'))

// ── Serve React SPA ───────────────────────────────────────────────────────────
app.use(express.static(DIST))
app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')))

app.listen(PORT, () => console.log(`gragen-accelerator listening on port ${PORT}`))
