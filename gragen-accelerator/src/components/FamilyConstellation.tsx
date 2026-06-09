import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, Stars } from '@react-three/drei'
import * as THREE from 'three'

// Superpopulation palette (matches CohortGlobe / CohortMap)
const SUPERPOP_COLORS: Record<string, [number, number, number]> = {
  AFR: [245, 158, 11], AMR: [16, 185, 129], EAS: [59, 130, 246], EUR: [139, 92, 246], SAS: [239, 68, 68],
}
const SUPERPOP_LABELS: Record<string, string> = {
  AFR: 'African', AMR: 'Admixed American', EAS: 'East Asian', EUR: 'European', SAS: 'South Asian',
}
const SUPERPOP_ORDER = ['AFR', 'AMR', 'EAS', 'EUR', 'SAS', 'NA']
const GREY: [number, number, number] = [120, 130, 145]
function rgbHex([r, g, b]: [number, number, number]) {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

type LayoutMode = 'spiral' | 'ancestry' | 'population'
type Vec3 = [number, number, number]

interface Trio {
  child: string
  father: string
  mother: string
  childSex: string            // 'male' | 'female'
  sp: string                  // superpopulation or ''
  pop: string                 // fine population or ''
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

// Decorative single spiral (no meaning — packs densely).
function spiralLayout(list: Trio[]): Map<string, Vec3> {
  const out = new Map<string, Vec3>()
  list.forEach((t, i) => {
    const r = 1.25 * Math.sqrt(i + 0.5)
    const th = i * GOLDEN
    out.set(t.child, [r * Math.cos(th), r * Math.sin(th), Math.sin(i * 0.7) * 1.4])
  })
  return out
}

// Grouped "islands": one cluster per group on a ring, families on a local
// spiral inside each. Distance now means shared group (ancestry / population).
function clusterLayout(list: Trio[], keyOf: (t: Trio) => string, order: string[]): Map<string, Vec3> {
  const groups = new Map<string, Trio[]>()
  for (const t of list) {
    const k = keyOf(t) || 'NA'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(t)
  }
  const keys = order.filter(k => groups.has(k))
  for (const k of groups.keys()) if (!keys.includes(k)) keys.push(k)   // any extras
  const localR = (n: number) => 0.9 * Math.sqrt(Math.max(1, n))
  const maxLocal = Math.max(1, ...keys.map(k => localR(groups.get(k)!.length)))
  const n = keys.length
  const ringR = n <= 1 ? 0 : Math.max(maxLocal * 1.25, (maxLocal + 2.5) / Math.sin(Math.PI / n))
  const out = new Map<string, Vec3>()
  keys.forEach((k, gi) => {
    const ang = n <= 1 ? 0 : (gi / n) * Math.PI * 2
    const gx = ringR * Math.cos(ang), gy = ringR * Math.sin(ang)
    groups.get(k)!.forEach((t, i) => {
      const r = 0.9 * Math.sqrt(i + 0.5)
      const th = i * GOLDEN
      out.set(t.child, [gx + r * Math.cos(th), gy + r * Math.sin(th), Math.sin(i * 0.7) * 0.8])
    })
  })
  return out
}

const FATHER_OFF = new THREE.Vector3(-0.42, 0.34, 0)
const MOTHER_OFF = new THREE.Vector3(0.42, 0.34, 0)
const CHILD_OFF = new THREE.Vector3(0, -0.42, 0)

// One family glyph; smoothly lerps from its current position to `target` so
// layout switches animate. Position is set imperatively (not via prop) so r3f
// doesn't snap it on each render.
function FamilyGlyph({ trio, target, onHover, onPick }: {
  trio: Trio
  target: Vec3
  onHover: (t: Trio | null) => void
  onPick: (sampleId: string) => void
}) {
  const ref = useRef<THREE.Group>(null)
  const tgt = useRef(new THREE.Vector3(target[0], target[1], target[2]))
  tgt.current.set(target[0], target[1], target[2])

  useEffect(() => { if (ref.current) ref.current.position.copy(tgt.current) }, [])   // initial snap
  useFrame(() => { if (ref.current) ref.current.position.lerp(tgt.current, 0.1) })

  const col = useMemo(() => {
    const c = SUPERPOP_COLORS[trio.sp] ?? GREY
    return new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255)
  }, [trio.sp])

  const lineGeo = useMemo(() => {
    const mid = FATHER_OFF.clone().add(MOTHER_OFF).multiplyScalar(0.5)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      FATHER_OFF.x, FATHER_OFF.y, FATHER_OFF.z, MOTHER_OFF.x, MOTHER_OFF.y, MOTHER_OFF.z,
      mid.x, mid.y, mid.z, CHILD_OFF.x, CHILD_OFF.y, CHILD_OFF.z,
    ]), 3))
    return g
  }, [])

  const childIsMale = trio.childSex?.toLowerCase().startsWith('m')

  return (
    <group
      ref={ref}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; onHover(trio) }}
      onPointerOut={() => { document.body.style.cursor = 'default'; onHover(null) }}
    >
      <lineSegments geometry={lineGeo}>
        <lineBasicMaterial color={col} transparent opacity={0.5} />
      </lineSegments>
      <mesh position={FATHER_OFF} onClick={(e) => { e.stopPropagation(); onPick(trio.father) }}>
        <boxGeometry args={[0.26, 0.26, 0.26]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.5} roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={MOTHER_OFF} onClick={(e) => { e.stopPropagation(); onPick(trio.mother) }}>
        <sphereGeometry args={[0.16, 20, 20]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.5} roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={CHILD_OFF} onClick={(e) => { e.stopPropagation(); onPick(trio.child) }}>
        {childIsMale
          ? <boxGeometry args={[0.2, 0.2, 0.2]} />
          : <sphereGeometry args={[0.12, 18, 18]} />}
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.2} roughness={0.2} metalness={0.3} />
      </mesh>
    </group>
  )
}

function ConstellationGroup({ trios, targets, spin, onHover, onPick }: {
  trios: Trio[]
  targets: Map<string, Vec3>
  spin: boolean
  onHover: (t: Trio | null) => void
  onPick: (sampleId: string) => void
}) {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (spin && groupRef.current) groupRef.current.rotation.y += dt * 0.12
  })
  return (
    <group ref={groupRef}>
      {trios.map(t => (
        <FamilyGlyph key={t.child} trio={t} target={targets.get(t.child) ?? [0, 0, 0]} onHover={onHover} onPick={onPick} />
      ))}
    </group>
  )
}

interface Props {
  onPickSample: (sampleId: string) => void
}

const MODE_LABELS: Record<LayoutMode, string> = {
  spiral: '✶ Spiral', ancestry: '🌍 By ancestry', population: '🧬 By population',
}
const MODE_HINT: Record<LayoutMode, string> = {
  spiral: 'decorative packing — distance is not meaningful',
  ancestry: 'clustered by superpopulation — distance = shared ancestry',
  population: 'clustered by 1000G population — nearby families share a population',
}

export function FamilyConstellation({ onPickSample }: Props) {
  const [trios, setTrios] = useState<Trio[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<Trio | null>(null)
  const [mode, setMode] = useState<LayoutMode>('ancestry')
  const [autoRotate, setAutoRotate] = useState(true)
  const [interacting, setInteracting] = useState(false)
  const [hiddenSP, setHiddenSP] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: `SELECT p.SAMPLE_ID, p.FATHER_ID, p.MOTHER_ID, p.SEX,
                         COALESCE(mc.SUPERPOPULATION, mf.SUPERPOPULATION, mm.SUPERPOPULATION) AS SUPERPOPULATION,
                         COALESCE(mc.POPULATION,      mf.POPULATION,      mm.POPULATION)      AS POPULATION
                    FROM GRAGEN_DB.GRAGEN.SAMPLE_PEDIGREE p
                    LEFT JOIN GRAGEN_DB.GRAGEN.SAMPLE_METRICS mc ON mc.SAMPLE_ID = p.SAMPLE_ID
                    LEFT JOIN GRAGEN_DB.GRAGEN.SAMPLE_METRICS mf ON mf.SAMPLE_ID = p.FATHER_ID
                    LEFT JOIN GRAGEN_DB.GRAGEN.SAMPLE_METRICS mm ON mm.SAMPLE_ID = p.MOTHER_ID
                   WHERE p.FATHER_ID <> '0' AND p.MOTHER_ID <> '0'`,
            database: 'GRAGEN_DB', schema: 'GRAGEN',
          }),
        })
        const json = await res.json() as { data?: Record<string, unknown>[]; detail?: string }
        if (!res.ok) throw new Error(json.detail ?? 'query failed')
        const built: Trio[] = (json.data ?? []).map(r => ({
          child: String(r.SAMPLE_ID ?? r.sample_id ?? ''),
          father: String(r.FATHER_ID ?? r.father_id ?? ''),
          mother: String(r.MOTHER_ID ?? r.mother_id ?? ''),
          childSex: String(r.SEX ?? r.sex ?? ''),
          sp: String(r.SUPERPOPULATION ?? r.superpopulation ?? ''),
          pop: String(r.POPULATION ?? r.population ?? ''),
        }))
        if (!cancelled) setTrios(built)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const visible = useMemo(
    () => trios.filter(t => !hiddenSP.has(t.sp || 'NA')),
    [trios, hiddenSP],
  )

  // population group order: by superpopulation then population name, so colors
  // form contiguous arcs around the ring.
  const popOrder = useMemo(() => {
    const seen = new Map<string, string>()   // pop -> sp
    trios.forEach(t => { if (t.pop) seen.set(t.pop, t.sp || 'NA') })
    return [...seen.keys()].sort((a, b) => {
      const sa = SUPERPOP_ORDER.indexOf(seen.get(a)!), sb = SUPERPOP_ORDER.indexOf(seen.get(b)!)
      return sa !== sb ? sa - sb : a.localeCompare(b)
    })
  }, [trios])

  const targets = useMemo(() => {
    if (mode === 'spiral') return spiralLayout(visible)
    if (mode === 'ancestry') return clusterLayout(visible, t => t.sp || 'NA', SUPERPOP_ORDER)
    return clusterLayout(visible, t => t.pop || 'NA', popOrder)
  }, [visible, mode, popOrder])

  const spCounts = useMemo(() => {
    const c: Record<string, number> = {}
    trios.forEach(t => { const k = t.sp || 'NA'; c[k] = (c[k] ?? 0) + 1 })
    return c
  }, [trios])

  const toggleSP = (sp: string) => setHiddenSP(prev => {
    const next = new Set(prev)
    if (next.has(sp)) next.delete(sp); else next.add(sp)
    return next
  })

  const spin = autoRotate && !interacting

  return (
    <div
      style={{ flex: 1, position: 'relative', background: '#030608' }}
      onPointerEnter={() => setInteracting(true)}
      onPointerLeave={() => setInteracting(false)}
    >
      {/* Header */}
      <div style={{ position: 'absolute', top: 12, left: 16, zIndex: 10, pointerEvents: 'none' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 0 20px rgba(68,136,255,0.9)' }}>
          👪 Family Constellation
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
          {loading ? 'Loading pedigree…' : `${visible.length.toLocaleString()} of ${trios.length.toLocaleString()} trios · ${MODE_HINT[mode]}`}
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
          cube ♂ · sphere ♀ · small node = child · color = superpopulation
        </div>
      </div>

      {/* Layout + pause controls */}
      <div style={{ position: 'absolute', top: 64, left: 16, zIndex: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(Object.keys(MODE_LABELS) as LayoutMode[]).map(mk => (
          <button
            key={mk}
            onClick={() => setMode(mk)}
            style={{
              background: mode === mk ? 'rgba(41,181,232,0.25)' : 'rgba(2,4,12,0.8)',
              border: `1px solid ${mode === mk ? '#29B5E8' : 'rgba(255,255,255,0.15)'}`,
              color: mode === mk ? '#bfecff' : '#cde', borderRadius: 6, padding: '4px 10px',
              fontSize: 11, cursor: 'pointer',
            }}
          >{MODE_LABELS[mk]}</button>
        ))}
        <button
          onClick={() => setAutoRotate(r => !r)}
          style={{
            background: autoRotate ? 'rgba(2,4,12,0.8)' : 'rgba(41,181,232,0.25)',
            border: `1px solid ${autoRotate ? 'rgba(255,255,255,0.15)' : '#29B5E8'}`,
            color: autoRotate ? '#cde' : '#bfecff', borderRadius: 6, padding: '4px 10px',
            fontSize: 11, cursor: 'pointer',
          }}
        >{autoRotate ? '⏸ Pause spin' : '▶ Resume spin'}</button>
      </div>

      {/* Legend = superpopulation filter (click to show/hide) */}
      <div style={{ position: 'absolute', top: 12, right: 16, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>Filter ancestry</div>
        {Object.entries(SUPERPOP_COLORS).map(([sp, c]) => {
          const off = hiddenSP.has(sp)
          return (
            <button
              key={sp}
              onClick={() => toggleSP(sp)}
              title={off ? `Show ${SUPERPOP_LABELS[sp]}` : `Hide ${SUPERPOP_LABELS[sp]}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, cursor: 'pointer',
                background: 'none', border: 'none', padding: '1px 0', textAlign: 'left',
                opacity: off ? 0.35 : 1,
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: rgbHex(c), boxShadow: off ? 'none' : `0 0 6px ${rgbHex(c)}` }} />
              <span style={{ color: '#ccc', textDecoration: off ? 'line-through' : 'none' }}>{SUPERPOP_LABELS[sp]}</span>
              <span style={{ color: 'rgba(255,255,255,0.4)' }}>{spCounts[sp] ?? 0}</span>
            </button>
          )
        })}
      </div>

      {error && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: 'var(--red)', fontSize: 12, zIndex: 10 }}>
          {error}
        </div>
      )}

      <Canvas camera={{ position: [0, 0, 48], fov: 55 }} style={{ background: '#030608' }}>
        <ambientLight intensity={0.4} />
        <pointLight position={[20, 20, 20]} intensity={1.4} color={0x88bbff} />
        <pointLight position={[-20, -20, 10]} intensity={0.8} color={0xaa66ff} />
        <Stars radius={140} depth={70} count={3500} factor={5} saturation={0.4} fade speed={0.3} />
        <fog attach="fog" args={[0x020408, 60, 130]} />
        <Suspense fallback={null}>
          <ConstellationGroup trios={visible} targets={targets} spin={spin} onHover={setHover} onPick={onPickSample} />
        </Suspense>
        <OrbitControls enableDamping dampingFactor={0.08} minDistance={6} maxDistance={170} />
      </Canvas>

      {/* Hover card */}
      {hover && (
        <div style={{
          position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 11,
          background: 'rgba(2,4,12,0.92)', backdropFilter: 'blur(12px)',
          border: `1px solid ${rgbHex(SUPERPOP_COLORS[hover.sp] ?? GREY)}`,
          borderRadius: 10, padding: '10px 18px', fontSize: 12, color: '#e8f4ff',
          display: 'flex', gap: 20, alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Family</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>
              {SUPERPOP_LABELS[hover.sp] ?? 'Unknown'}{hover.pop ? ` · ${hover.pop}` : ''}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Father ♂ / Mother ♀</div>
            <div style={{ fontFamily: 'monospace' }}>{hover.father} · {hover.mother}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Child ({hover.childSex || '?'})</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{hover.child}</div>
          </div>
          <div style={{ fontSize: 10, color: 'rgba(120,200,255,0.7)' }}>click a node → open sample</div>
        </div>
      )}

      {/* Hint */}
      <div style={{ position: 'absolute', bottom: 10, right: 12, fontSize: 9, color: 'rgba(255,255,255,0.25)', zIndex: 5 }}>
        spin pauses while you hover · drag to orbit · scroll to zoom
      </div>
    </div>
  )
}
