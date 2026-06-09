import { useRef, useMemo, useState, Suspense } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Text, Sphere, Line, Stars } from '@react-three/drei'
import * as THREE from 'three'
import type { Variant } from '../types'
import { VTYPE_LABELS } from '../types'

// Colors per variant type
const TYPE_COLORS_HEX: Record<number, string> = {
  0: '#40c4ff',  // SNP - electric blue
  1: '#00ff80',  // INS - neon green
  2: '#ff4080',  // DEL - hot pink
  3: '#ffa000',  // MNP - amber
}
const TYPE_COLORS_3: Record<number, [number,number,number]> = {
  0: [0.25, 0.77, 1.0],
  1: [0.0, 1.0, 0.5],
  2: [1.0, 0.25, 0.5],
  3: [1.0, 0.63, 0.0],
}

interface Props {
  variants: Variant[]
  chrom: string
  startPos: number
  endPos: number
}

// A single nucleotide base pair on the helix
function BasePair({ t, color }: { t: number; color: string }) {
  const r = 1.4
  const pitch = 2.0
  const x1 = Math.cos(t * Math.PI * 2) * r
  const z1 = Math.sin(t * Math.PI * 2) * r
  const x2 = Math.cos(t * Math.PI * 2 + Math.PI) * r
  const z2 = Math.sin(t * Math.PI * 2 + Math.PI) * r
  const y = t * pitch - pitch * 5

  const pts = useMemo(() => [
    new THREE.Vector3(x1, y, z1),
    new THREE.Vector3(x2, y, z2),
  ], [x1, y, z1, x2, z2])

  return (
    <group>
      <Line points={pts} color={color} lineWidth={1} transparent opacity={0.3} />
      <Sphere args={[0.08, 8, 8]} position={[x1, y, z1]}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </Sphere>
      <Sphere args={[0.08, 8, 8]} position={[x2, y, z2]}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </Sphere>
    </group>
  )
}

// The DNA helix backbone
function HelixBackbone({ count = 60 }: { count?: number }) {
  const r = 1.4
  const pitch = 2.0
  const totalHeight = pitch * 10

  const strand1Pts = useMemo(() => {
    const pts = []
    for (let i = 0; i <= count; i++) {
      const t = i / count
      pts.push(new THREE.Vector3(
        Math.cos(t * Math.PI * 4) * r,
        t * totalHeight - totalHeight / 2,
        Math.sin(t * Math.PI * 4) * r,
      ))
    }
    return pts
  }, [count, totalHeight])

  const strand2Pts = useMemo(() => {
    const pts = []
    for (let i = 0; i <= count; i++) {
      const t = i / count
      pts.push(new THREE.Vector3(
        Math.cos(t * Math.PI * 4 + Math.PI) * r,
        t * totalHeight - totalHeight / 2,
        Math.sin(t * Math.PI * 4 + Math.PI) * r,
      ))
    }
    return pts
  }, [count, totalHeight])

  return (
    <group>
      <Line points={strand1Pts} color="#4488ff" lineWidth={3} transparent opacity={0.7} />
      <Line points={strand2Pts} color="#44aaff" lineWidth={3} transparent opacity={0.7} />
      {/* Base pairs */}
      {Array.from({ length: 20 }, (_, i) => (
        <BasePair key={i} t={i / 20} color={i % 4 === 0 ? '#44ff88' : i % 4 === 1 ? '#ff4444' : i % 4 === 2 ? '#ffaa44' : '#4488ff'} />
      ))}
    </group>
  )
}

// Variant sphere positioned on the helix
function VariantSphere({
  variant, index, total, hovered, setHovered
}: {
  variant: Variant & { pos: number, value: number, type: number }
  index: number
  total: number
  hovered: number | null
  setHovered: (i: number | null) => void
}) {
  const ref = useRef<THREE.Mesh>(null)
  const t = index / total
  const r = 1.4 + variant.value * 0.8 + 0.3  // push outward + af
  const angle = t * Math.PI * 8  // 4 full turns
  const y = t * 20 - 10

  const x = Math.cos(angle) * r
  const z = Math.sin(angle) * r
  const color = TYPE_COLORS_3[variant.type ?? 0] ?? TYPE_COLORS_3[0]
  const radius = 0.05 + variant.value * 0.25  // size = allele frequency
  const isHovered = hovered === index

  useFrame((_, delta) => {
    if (!ref.current) return
    if (isHovered) {
      ref.current.scale.setScalar(1 + Math.sin(Date.now() * 0.005) * 0.2)
    } else {
      ref.current.scale.lerp(new THREE.Vector3(1, 1, 1), delta * 5)
    }
  })

  return (
    <mesh
      ref={ref}
      position={[x, y, z]}
      onPointerEnter={(e) => { e.stopPropagation(); setHovered(index) }}
      onPointerLeave={() => setHovered(null)}
    >
      <sphereGeometry args={[radius, 12, 12]} />
      <meshStandardMaterial
        color={new THREE.Color(...color)}
        emissive={new THREE.Color(...color)}
        emissiveIntensity={isHovered ? 2.0 : (0.5 + variant.value * 1.5)}
        transparent
        opacity={0.85 + variant.value * 0.15}
        roughness={0.1}
        metalness={0.3}
      />
    </mesh>
  )
}

// Glow rings for high-AF variants
function GlowRing({ variant, index, total }: {
  variant: Variant & { pos: number, value: number, type: number }, index: number, total: number
}) {
  const ref = useRef<THREE.Mesh>(null)
  const t = index / total
  const r = 1.4 + variant.value * 0.8 + 0.3
  const angle = t * Math.PI * 8
  const y = t * 20 - 10
  const x = Math.cos(angle) * r
  const z = Math.sin(angle) * r
  const color = TYPE_COLORS_3[variant.type ?? 0] ?? TYPE_COLORS_3[0]

  useFrame(() => {
    if (!ref.current) return
    ref.current.rotation.y += 0.02
    const s = 1 + Math.sin(Date.now() * 0.003 + index) * 0.15
    ref.current.scale.setScalar(s)
  })

  if (variant.value < 0.1) return null

  return (
    <mesh ref={ref} position={[x, y, z]}>
      <torusGeometry args={[0.3 + variant.value * 0.3, 0.015, 8, 32]} />
      <meshStandardMaterial
        color={new THREE.Color(...color)}
        emissive={new THREE.Color(...color)}
        emissiveIntensity={1.5}
        transparent
        opacity={0.4}
      />
    </mesh>
  )
}

// The animated helix group
function HelixGroup({ variants, autoRotate }: {
  variants: Array<Variant & { pos: number, value: number, type: number }>,
  autoRotate: boolean
}) {
  const groupRef = useRef<THREE.Group>(null)
  const [hovered, setHovered] = useState<number | null>(null)

  useFrame((_, delta) => {
    if (!groupRef.current || !autoRotate) return
    groupRef.current.rotation.y += delta * 0.3
  })

  // Sample max 300 variants for performance, prioritizing high-AF
  const sample = useMemo(() => {
    const sorted = [...variants].sort((a, b) => b.value - a.value)
    const step = Math.max(1, Math.floor(sorted.length / 300))
    return sorted.filter((_, i) => i % step === 0).slice(0, 300)
  }, [variants])

  return (
    <group ref={groupRef}>
      <HelixBackbone count={80} />
      {/* Variant spheres */}
      {sample.map((v, i) => (
        <VariantSphere
          key={i} variant={v} index={i} total={sample.length}
          hovered={hovered} setHovered={setHovered}
        />
      ))}
      {/* Glow rings for top variants */}
      {sample.slice(0, 30).map((v, i) => (
        <GlowRing key={`ring-${i}`} variant={v} index={i} total={30} />
      ))}
    </group>
  )
}

export function DNAHelixView({ variants, chrom, startPos, endPos }: Props) {
  const [autoRotate, setAutoRotate] = useState(true)

  const variantsWithData = useMemo(() =>
    variants
      .filter(v => v.pos != null && v.value != null)
      .map(v => ({ ...v, pos: v.pos ?? 0, value: v.value ?? 0, type: v.type ?? 0 })),
    [variants]
  )

  const typeCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const v of variantsWithData) {
      counts[v.type] = (counts[v.type] ?? 0) + 1
    }
    return counts
  }, [variantsWithData])

  if (!variantsWithData.length) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#050810', gap: 12 }}>
        <div style={{ fontSize: 48, filter: 'drop-shadow(0 0 20px #4488ff)' }}>🧬</div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
          Fetch variants in the Genome Browser tab first, then return here to see the 3D helix.
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, position: 'relative', background: 'linear-gradient(180deg, #020510 0%, #050820 100%)' }}>
      {/* Header */}
      <div style={{ position: 'absolute', top: 12, left: 16, zIndex: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 0 15px rgba(64,196,255,0.7)', marginBottom: 6 }}>
          🧬 {chrom}:{startPos.toLocaleString()}–{endPos.toLocaleString()}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(typeCounts).map(([type, count]) => (
            <span key={type} style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
                background: TYPE_COLORS_HEX[Number(type)] ?? '#fff',
                boxShadow: `0 0 8px ${TYPE_COLORS_HEX[Number(type)] ?? '#fff'}`,
              }} />
              <span style={{ color: 'rgba(255,255,255,0.7)' }}>
                {VTYPE_LABELS[Number(type)] ?? 'SNP'} ({count.toLocaleString()})
              </span>
            </span>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
          Sphere size = allele frequency · {Math.min(300, variantsWithData.length)} variants shown
        </div>
      </div>

      {/* Controls */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, display: 'flex', gap: 6 }}>
        <button
          onClick={() => setAutoRotate(r => !r)}
          style={{
            background: autoRotate ? 'rgba(64,196,255,0.15)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${autoRotate ? 'rgba(64,196,255,0.4)' : 'rgba(255,255,255,0.15)'}`,
            color: '#ddd', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
            backdropFilter: 'blur(8px)',
          }}
        >
          {autoRotate ? '⏸ Pause' : '▶ Rotate'}
        </button>
      </div>

      <Canvas
        camera={{ position: [0, 0, 12], fov: 50 }}
        style={{ width: '100%', height: '100%' }}
      >
        {/* Lighting */}
        <ambientLight intensity={0.3} />
        <pointLight position={[10, 10, 10]} intensity={1.5} color="#4488ff" />
        <pointLight position={[-10, -10, -10]} intensity={0.8} color="#ff4480" />
        <pointLight position={[0, 15, 0]} intensity={0.6} color="#ffffff" />

        {/* Star field */}
        <Stars radius={60} depth={30} count={2000} factor={2} fade speed={0.5} />

        {/* DNA Helix */}
        <Suspense fallback={null}>
          <HelixGroup variants={variantsWithData} autoRotate={autoRotate} />
        </Suspense>

        {/* Orbit controls */}
        <OrbitControls
          enablePan={false}
          minDistance={5}
          maxDistance={25}
          autoRotate={false}
        />
      </Canvas>

      {/* Footer hint */}
      <div style={{
        position: 'absolute', bottom: 12, right: 16, fontSize: 9,
        color: 'rgba(255,255,255,0.25)', pointerEvents: 'none',
      }}>
        drag to orbit · scroll to zoom · hover sphere for variant detail
      </div>
    </div>
  )
}
