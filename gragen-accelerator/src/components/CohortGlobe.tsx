import { Suspense, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, useTexture, Stars } from '@react-three/drei'
import * as THREE from 'three'

// 1000G population geographic coordinates [lon, lat]
const POP_COORDS: Record<string, [number, number]> = {
  // AFR
  YRI: [3.4, 6.5], LWK: [36.8, 0.4], GWD: [-15.3, 13.5], MSL: [-13.2, 8.5],
  ESN: [8.1, 7.4], ASW: [-90.2, 29.9], ACB: [-59.5, 13.2],
  // AMR
  MXL: [-116.9, 32.5], PUR: [-66.1, 18.4], CLM: [-75.5, 6.2], PEL: [-77.0, -9.2],
  // EAS
  CHB: [116.4, 39.9], JPT: [139.7, 35.7], CHS: [113.3, 23.1], CDX: [100.2, 22.0], KHV: [105.8, 21.0],
  // EUR
  CEU: [9.0, 47.0], TSI: [11.2, 43.8], FIN: [27.0, 65.0], GBR: [-1.5, 52.0], IBS: [-3.7, 40.4],
  // SAS
  GIH: [72.9, 21.2], PJL: [74.0, 31.5], BEB: [90.4, 23.7], STU: [81.0, 8.0], ITU: [80.3, 11.1],
}

const SUPERPOP_COLORS: Record<string, [number, number, number]> = {
  AFR: [245, 158, 11], AMR: [16, 185, 129], EAS: [59, 130, 246], EUR: [139, 92, 246], SAS: [239, 68, 68],
}
const SUPERPOP_LABELS: Record<string, string> = {
  AFR: 'African', AMR: 'Admixed American', EAS: 'East Asian', EUR: 'European', SAS: 'South Asian',
}
function rgbHex([r, g, b]: [number, number, number]) {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

const GLOBE_R = 2

// lat/lon → point on a sphere of radius r (aligned with equirectangular texture)
function latLonToVec3(lat: number, lon: number, r: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}

interface PopStat { population: string; superpopulation: string; sex: string; cnt: number }
interface Props { popStats: PopStat[] }
interface PopPoint {
  pop: string; sp: string; lat: number; lon: number
  count: number; male: number; female: number; color: [number, number, number]
}

// Earth sphere with the bundled Blue Marble texture
function Earth() {
  const tex = useTexture('/earth-blue-marble.jpg')
  return (
    <mesh>
      <sphereGeometry args={[GLOBE_R, 64, 64]} />
      <meshStandardMaterial map={tex} roughness={1} metalness={0} />
    </mesh>
  )
}

// A glowing column rising radially from a population's location, height ∝ count
function PopColumn({ p, maxCount, onHover }: {
  p: PopPoint; maxCount: number; onHover: (e: ThreeEvent<PointerEvent> | null, p: PopPoint | null) => void
}) {
  const base = useMemo(() => latLonToVec3(p.lat, p.lon, GLOBE_R), [p.lat, p.lon])
  const dir = useMemo(() => base.clone().normalize(), [base])
  const height = 0.25 + (p.count / maxCount) * 1.6
  const mid = useMemo(() => base.clone().add(dir.clone().multiplyScalar(height / 2)), [base, dir, height])
  const tip = useMemo(() => base.clone().add(dir.clone().multiplyScalar(height)), [base, dir, height])
  const quat = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    return q
  }, [dir])
  const col = useMemo(() => new THREE.Color(p.color[0] / 255, p.color[1] / 255, p.color[2] / 255), [p.color])
  const capRef = useRef<THREE.Mesh>(null)
  useFrame(() => {
    if (capRef.current) capRef.current.scale.setScalar(1 + Math.sin(Date.now() * 0.004 + p.lon) * 0.18)
  })
  return (
    <group
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; onHover(e, p) }}
      onPointerOut={() => { document.body.style.cursor = 'default'; onHover(null, null) }}
    >
      <mesh position={[mid.x, mid.y, mid.z]} quaternion={quat}>
        <cylinderGeometry args={[0.025, 0.025, height, 8]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.8} transparent opacity={0.9} />
      </mesh>
      <mesh ref={capRef} position={[tip.x, tip.y, tip.z]}>
        <sphereGeometry args={[0.06 + (p.count / maxCount) * 0.08, 12, 12]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.6} roughness={0.2} />
      </mesh>
    </group>
  )
}

function GlobeGroup({ points, maxCount, autoRotate, onHover }: {
  points: PopPoint[]; maxCount: number; autoRotate: boolean
  onHover: (e: ThreeEvent<PointerEvent> | null, p: PopPoint | null) => void
}) {
  const ref = useRef<THREE.Group>(null)
  useFrame((_, dt) => { if (autoRotate && ref.current) ref.current.rotation.y += dt * 0.15 })
  return (
    <group ref={ref}>
      <Suspense fallback={<mesh><sphereGeometry args={[GLOBE_R, 32, 32]} /><meshStandardMaterial color="#0a2a4a" /></mesh>}>
        <Earth />
      </Suspense>
      {/* subtle atmosphere */}
      <mesh>
        <sphereGeometry args={[GLOBE_R * 1.02, 48, 48]} />
        <meshBasicMaterial color="#4aa3ff" transparent opacity={0.06} side={THREE.BackSide} />
      </mesh>
      {points.map(p => <PopColumn key={p.pop} p={p} maxCount={maxCount} onHover={onHover} />)}
    </group>
  )
}

export function CohortGlobe({ popStats }: Props) {
  const [autoRotate, setAutoRotate] = useState(true)
  const [hover, setHover] = useState<{ x: number; y: number; p: PopPoint } | null>(null)

  const { points, maxCount, totalSamples } = useMemo(() => {
    const byPop: Record<string, { sp: string; total: number; male: number; female: number }> = {}
    for (const s of popStats) {
      if (!byPop[s.population]) byPop[s.population] = { sp: s.superpopulation, total: 0, male: 0, female: 0 }
      byPop[s.population].total += s.cnt
      const isMale = s.sex === 'male' || s.sex === '1' || s.sex === 'M'
      if (isMale) byPop[s.population].male += s.cnt
      else byPop[s.population].female += s.cnt
    }
    const pts: PopPoint[] = Object.entries(byPop)
      .filter(([pop]) => POP_COORDS[pop])
      .map(([pop, d]) => ({
        pop, sp: d.sp, lon: POP_COORDS[pop][0], lat: POP_COORDS[pop][1],
        count: d.total, male: d.male, female: d.female,
        color: SUPERPOP_COLORS[d.sp] ?? [150, 150, 150],
      }))
    return {
      points: pts,
      maxCount: Math.max(...pts.map(p => p.count), 1),
      totalSamples: pts.reduce((s, p) => s + p.count, 0),
    }
  }, [popStats])

  const onHover = (e: ThreeEvent<PointerEvent> | null, p: PopPoint | null) => {
    if (e && p) setHover({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, p })
    else setHover(null)
  }

  return (
    <div
      style={{ width: '100%', height: '100%', minHeight: 480, flex: 1, position: 'relative', background: '#03060f', borderRadius: 8, overflow: 'hidden' }}
      onMouseEnter={() => setAutoRotate(false)}
      onMouseLeave={() => { setAutoRotate(true); setHover(null) }}
    >
      <Canvas camera={{ position: [0, 0, 6], fov: 45 }} gl={{ antialias: true }}>
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 3, 5]} intensity={1.4} />
        <pointLight position={[-5, -2, -3]} intensity={0.4} color="#4aa3ff" />
        <Stars radius={120} depth={50} count={2500} factor={4} fade speed={0.3} />
        <GlobeGroup points={points} maxCount={maxCount} autoRotate={autoRotate} onHover={onHover} />
        <OrbitControls enablePan={false} enableDamping dampingFactor={0.08} minDistance={3.2} maxDistance={12} />
      </Canvas>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16,
        background: 'rgba(0,0,0,0.75)', padding: '8px 12px', borderRadius: 8,
        display: 'flex', flexDirection: 'column', gap: 4, backdropFilter: 'blur(8px)',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#ccc', marginBottom: 2 }}>
          {totalSamples.toLocaleString()} samples · {points.length} populations
        </div>
        {Object.entries(SUPERPOP_COLORS).map(([sp, color]) => (
          <div key={sp} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: rgbHex(color) }} />
            <span style={{ fontSize: 10, color: '#ccc' }}>{SUPERPOP_LABELS[sp]}</span>
          </div>
        ))}
      </div>

      {/* Title */}
      <div style={{
        position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
        fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.85)',
        pointerEvents: 'none', whiteSpace: 'nowrap',
      }}>
        🌍 1000 Genomes Sample Origins — 3D Globe
      </div>

      {/* Hover tooltip (follows cursor) */}
      {hover && (
        <div style={{
          position: 'fixed', left: hover.x + 14, top: hover.y - 10, zIndex: 1000,
          background: 'rgba(0,0,0,0.9)', border: `1px solid ${rgbHex(hover.p.color)}66`,
          padding: '8px 12px', borderRadius: 8, fontSize: 11, pointerEvents: 'none',
          color: '#fff', minWidth: 150, backdropFilter: 'blur(8px)',
        }}>
          <div style={{ fontWeight: 700, color: rgbHex(hover.p.color), marginBottom: 4, fontSize: 13 }}>{hover.p.pop}</div>
          <div style={{ color: '#aaa', marginBottom: 4 }}>{SUPERPOP_LABELS[hover.p.sp]}</div>
          <div>Samples: <strong>{hover.p.count}</strong></div>
          <div>♂ {hover.p.male} · ♀ {hover.p.female}</div>
          <div style={{ color: '#666', fontSize: 9, marginTop: 4 }}>
            {hover.p.lat.toFixed(1)}°, {hover.p.lon.toFixed(1)}°
          </div>
        </div>
      )}

      {/* Instruction */}
      <div style={{
        position: 'absolute', bottom: 16, right: 16, fontSize: 9,
        color: 'rgba(255,255,255,0.3)', pointerEvents: 'none',
      }}>
        drag to rotate · scroll to zoom · hover columns for details
      </div>
    </div>
  )
}
