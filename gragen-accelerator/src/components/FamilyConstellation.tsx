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
const GREY: [number, number, number] = [120, 130, 145]
function rgbHex([r, g, b]: [number, number, number]) {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

interface Trio {
  child: string
  father: string
  mother: string
  childSex: string            // 'male' | 'female'
  sp: string                  // superpopulation or '' 
  center: [number, number, number]
}

// Local-space offsets of the three members around a family's center.
const FATHER_OFF = new THREE.Vector3(-0.42, 0.34, 0)
const MOTHER_OFF = new THREE.Vector3(0.42, 0.34, 0)
const CHILD_OFF = new THREE.Vector3(0, -0.42, 0)

// One family: father (cube ♂) + mother (sphere ♀) joined by a couple bar,
// child dropped below on a stalk. Colored by the child's superpopulation.
function FamilyGlyph({ trio, onHover, onPick }: {
  trio: Trio
  onHover: (t: Trio | null) => void
  onPick: (sampleId: string) => void
}) {
  const col = useMemo(() => {
    const c = SUPERPOP_COLORS[trio.sp] ?? GREY
    return new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255)
  }, [trio.sp])

  const [cx, cy, cz] = trio.center
  const f = useMemo(() => FATHER_OFF.clone(), [])
  const m = useMemo(() => MOTHER_OFF.clone(), [])
  const ch = useMemo(() => CHILD_OFF.clone(), [])

  // couple bar (father↔mother) + sib drop (midpoint→child)
  const lineGeo = useMemo(() => {
    const mid = f.clone().add(m).multiplyScalar(0.5)
    const pts = [f, m, mid, ch]
    const g = new THREE.BufferGeometry()
    const arr = new Float32Array([
      f.x, f.y, f.z, m.x, m.y, m.z,        // couple bar
      mid.x, mid.y, mid.z, ch.x, ch.y, ch.z, // sib drop
    ])
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    return g
  }, [f, m, ch])

  const childIsMale = trio.childSex?.toLowerCase().startsWith('m')

  return (
    <group
      position={[cx, cy, cz]}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; onHover(trio) }}
      onPointerOut={() => { document.body.style.cursor = 'default'; onHover(null) }}
    >
      {/* connectors */}
      <lineSegments geometry={lineGeo}>
        <lineBasicMaterial color={col} transparent opacity={0.5} />
      </lineSegments>

      {/* father — cube (♂) */}
      <mesh position={f} onClick={(e) => { e.stopPropagation(); onPick(trio.father) }}>
        <boxGeometry args={[0.26, 0.26, 0.26]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.5} roughness={0.3} metalness={0.4} />
      </mesh>
      {/* mother — sphere (♀) */}
      <mesh position={m} onClick={(e) => { e.stopPropagation(); onPick(trio.mother) }}>
        <sphereGeometry args={[0.16, 20, 20]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.5} roughness={0.3} metalness={0.4} />
      </mesh>
      {/* child — smaller, shape encodes sex */}
      <mesh position={ch} onClick={(e) => { e.stopPropagation(); onPick(trio.child) }}>
        {childIsMale
          ? <boxGeometry args={[0.2, 0.2, 0.2]} />
          : <sphereGeometry args={[0.12, 18, 18]} />}
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.2} roughness={0.2} metalness={0.3} />
      </mesh>
    </group>
  )
}

function ConstellationGroup({ trios, autoRotate, onHover, onPick }: {
  trios: Trio[]
  autoRotate: boolean
  onHover: (t: Trio | null) => void
  onPick: (sampleId: string) => void
}) {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (autoRotate && groupRef.current) groupRef.current.rotation.y += dt * 0.12
  })
  return (
    <group ref={groupRef}>
      {trios.map(t => (
        <FamilyGlyph key={t.child} trio={t} onHover={onHover} onPick={onPick} />
      ))}
    </group>
  )
}

interface Props {
  onPickSample: (sampleId: string) => void
}

export function FamilyConstellation({ onPickSample }: Props) {
  const [trios, setTrios] = useState<Trio[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<Trio | null>(null)
  const [autoRotate, setAutoRotate] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: `SELECT p.SAMPLE_ID, p.FATHER_ID, p.MOTHER_ID, p.SEX, m.SUPERPOPULATION
                    FROM GRAGEN_DB.GRAGEN.SAMPLE_PEDIGREE p
                    LEFT JOIN GRAGEN_DB.GRAGEN.SAMPLE_METRICS m ON m.SAMPLE_ID = p.SAMPLE_ID
                   WHERE p.FATHER_ID <> '0' AND p.MOTHER_ID <> '0'`,
            database: 'GRAGEN_DB', schema: 'GRAGEN',
          }),
        })
        const json = await res.json() as { data?: Record<string, unknown>[]; detail?: string }
        if (!res.ok) throw new Error(json.detail ?? 'query failed')
        const rows = json.data ?? []
        // Phyllotaxis spiral: each family on a golden-angle spiral so they pack
        // densely without overlapping (trios are independent components).
        const GOLDEN = Math.PI * (3 - Math.sqrt(5))
        const SPACING = 1.25
        const built: Trio[] = rows.map((r, i) => {
          const radius = SPACING * Math.sqrt(i + 0.5)
          const theta = i * GOLDEN
          const z = (Math.sin(i * 0.7) ) * 1.4    // gentle depth so it reads 3D
          return {
            child: String(r.SAMPLE_ID ?? r.sample_id ?? ''),
            father: String(r.FATHER_ID ?? r.father_id ?? ''),
            mother: String(r.MOTHER_ID ?? r.mother_id ?? ''),
            childSex: String(r.SEX ?? r.sex ?? ''),
            sp: String(r.SUPERPOPULATION ?? r.superpopulation ?? ''),
            center: [radius * Math.cos(theta), radius * Math.sin(theta), z],
          }
        })
        if (!cancelled) setTrios(built)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const spCounts = useMemo(() => {
    const c: Record<string, number> = {}
    trios.forEach(t => { const k = t.sp || 'NA'; c[k] = (c[k] ?? 0) + 1 })
    return c
  }, [trios])

  return (
    <div style={{ flex: 1, position: 'relative', background: '#030608' }}>
      {/* Header */}
      <div style={{ position: 'absolute', top: 12, left: 16, zIndex: 10, pointerEvents: 'none' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 0 20px rgba(68,136,255,0.9)' }}>
          👪 Family Constellation
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
          {loading ? 'Loading pedigree…' : `${trios.length.toLocaleString()} parent–offspring trios · 1000 Genomes`}
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
          cube ♂ · sphere ♀ · small node = child · color = superpopulation
        </div>
      </div>

      {/* Legend */}
      <div style={{ position: 'absolute', top: 12, right: 16, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {Object.entries(SUPERPOP_COLORS).map(([sp, c]) => (
          <div key={sp} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: rgbHex(c) }} />
            <span style={{ color: '#ccc' }}>{SUPERPOP_LABELS[sp]}</span>
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>{spCounts[sp] ?? 0}</span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <button
        onClick={() => setAutoRotate(r => !r)}
        style={{
          position: 'absolute', bottom: 14, left: 16, zIndex: 10,
          background: 'rgba(2,4,12,0.8)', border: '1px solid rgba(255,255,255,0.15)',
          color: '#cfe', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
        }}
      >
        {autoRotate ? '⏸ Pause' : '▶ Rotate'}
      </button>

      {error && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: 'var(--red)', fontSize: 12, zIndex: 10 }}>
          {error}
        </div>
      )}

      <Canvas camera={{ position: [0, 0, 38], fov: 55 }} style={{ background: '#030608' }}>
        <ambientLight intensity={0.4} />
        <pointLight position={[20, 20, 20]} intensity={1.4} color={0x88bbff} />
        <pointLight position={[-20, -20, 10]} intensity={0.8} color={0xaa66ff} />
        <Stars radius={120} depth={60} count={3500} factor={5} saturation={0.4} fade speed={0.3} />
        <fog attach="fog" args={[0x020408, 45, 95]} />
        <Suspense fallback={null}>
          <ConstellationGroup trios={trios} autoRotate={autoRotate} onHover={setHover} onPick={onPickSample} />
        </Suspense>
        <OrbitControls enableDamping dampingFactor={0.08} minDistance={6} maxDistance={90} />
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
              {SUPERPOP_LABELS[hover.sp] ?? 'Unknown population'}
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
    </div>
  )
}
