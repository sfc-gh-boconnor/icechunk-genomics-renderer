/**
 * DNAHelix3D — Three.js animated DNA double helix
 * Shows chr22 variants as glowing spheres along the helix
 * Color by variant type, size by allele frequency
 * Auto-rotates, supports orbit controls, click for details
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Stars, Text, Sphere, Tube, Billboard } from '@react-three/drei'
import * as THREE from 'three'
import type { Variant } from '../types'
import { VTYPE_LABELS } from '../types'

// Variant type colors (emissive for glow effect)
const TYPE_COLORS = {
  0: '#40c4ff', // SNP  - electric blue
  1: '#00ff80', // INS  - neon green
  2: '#ff4080', // DEL  - hot pink
  3: '#ffa020', // MNP  - amber
} as Record<number, string>

const TYPE_EMISSIVE = {
  0: '#0070aa',
  1: '#008040',
  2: '#aa0040',
  3: '#aa6000',
} as Record<number, string>

interface VariantPoint {
  pos: number
  af: number
  type: number
  t: number  // normalized position [0, 1] along helix
}

// Double helix geometry
function Helix({
  turns = 8,
  radius = 1.2,
  height = 10,
  color,
  phaseOffset = 0,
}: {
  turns: number
  radius: number
  height: number
  color: string
  phaseOffset: number
}) {
  const points = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 300; i++) {
      const t = i / 300
      const angle = t * turns * Math.PI * 2 + phaseOffset
      pts.push(new THREE.Vector3(
        radius * Math.cos(angle),
        t * height - height / 2,
        radius * Math.sin(angle)
      ))
    }
    return pts
  }, [turns, radius, height, phaseOffset])

  const curve = useMemo(() => new THREE.CatmullRomCurve3(points), [points])

  return (
    <Tube args={[curve, 300, 0.04, 6, false]}>
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.4}
        roughness={0.3}
        metalness={0.8}
        transparent
        opacity={0.85}
      />
    </Tube>
  )
}

// Base pair rungs connecting the two strands
function BaseRungs({ turns = 8, radius = 1.2, height = 10 }: { turns: number; radius: number; height: number }) {
  const rungs = useMemo(() => {
    const r: { start: THREE.Vector3; end: THREE.Vector3; key: number }[] = []
    for (let i = 0; i <= turns * 4; i++) {
      const t = i / (turns * 4)
      const angle = t * turns * Math.PI * 2
      const y = t * height - height / 2
      r.push({
        key: i,
        start: new THREE.Vector3(radius * Math.cos(angle), y, radius * Math.sin(angle)),
        end:   new THREE.Vector3(radius * Math.cos(angle + Math.PI), y, radius * Math.sin(angle + Math.PI)),
      })
    }
    return r
  }, [turns, radius, height])

  return (
    <>
      {rungs.map(rung => {
        const curve = new THREE.LineCurve3(rung.start, rung.end)
        return (
          <Tube key={rung.key} args={[curve, 2, 0.02, 4, false]}>
            <meshStandardMaterial color="#334466" emissive="#112244" emissiveIntensity={0.3} transparent opacity={0.5} />
          </Tube>
        )
      })}
    </>
  )
}

// Variant spheres positioned along the helix
function VariantSpheres({
  variants,
  turns,
  radius,
  height,
  onHover,
  onClick,
}: {
  variants: VariantPoint[]
  turns: number
  radius: number
  height: number
  onHover: (v: VariantPoint | null) => void
  onClick: (v: VariantPoint) => void
}) {
  return (
    <>
      {variants.map((v, i) => {
        const angle = v.t * turns * Math.PI * 2
        const y = v.t * height - height / 2
        const r = radius + 0.15 + v.af * 0.4  // offset outward, size by AF
        const sz = 0.05 + v.af * 0.15
        const color = TYPE_COLORS[v.type] ?? TYPE_COLORS[0]
        const emissive = TYPE_EMISSIVE[v.type] ?? TYPE_EMISSIVE[0]

        return (
          <Sphere
            key={i}
            args={[sz, 8, 8]}
            position={[r * Math.cos(angle), y, r * Math.sin(angle)]}
            onPointerOver={() => onHover(v)}
            onPointerOut={() => onHover(null)}
            onClick={() => onClick(v)}
          >
            <meshStandardMaterial
              color={color}
              emissive={emissive}
              emissiveIntensity={0.8 + v.af * 1.2}
              roughness={0.2}
              metalness={0.5}
            />
          </Sphere>
        )
      })}
    </>
  )
}

// Particle cloud of variants (for performance with many variants)
function VariantParticles({ variants, turns, radius, height }: {
  variants: VariantPoint[], turns: number, radius: number, height: number
}) {
  const positions = useMemo(() => {
    const pos = new Float32Array(variants.length * 3)
    variants.forEach((v, i) => {
      const angle = v.t * turns * Math.PI * 2
      const y = v.t * height - height / 2
      const r = radius + 0.2 + v.af * 0.5
      pos[i * 3]     = r * Math.cos(angle)
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = r * Math.sin(angle)
    })
    return pos
  }, [variants, turns, radius, height])

  const colors = useMemo(() => {
    const col = new Float32Array(variants.length * 3)
    variants.forEach((v, i) => {
      const hex = TYPE_COLORS[v.type] ?? '#40c4ff'
      const c = new THREE.Color(hex)
      col[i * 3]     = c.r
      col[i * 3 + 1] = c.g
      col[i * 3 + 2] = c.b
    })
    return col
  }, [variants])

  const sizes = useMemo(() => {
    const sz = new Float32Array(variants.length)
    variants.forEach((v, i) => { sz[i] = 3 + v.af * 12 })
    return sz
  }, [variants])

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    return g
  }, [positions, colors, sizes])

  return (
    <points geometry={geo}>
      <pointsMaterial
        vertexColors
        size={0.08}
        sizeAttenuation
        transparent
        opacity={0.9}
        depthWrite={false}
      />
    </points>
  )
}

// Rotating group wrapper
function RotatingGroup({ children, autoRotate }: { children: React.ReactNode, autoRotate: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, delta) => {
    if (autoRotate && groupRef.current) {
      groupRef.current.rotation.y += delta * 0.4
    }
  })
  return <group ref={groupRef}>{children}</group>
}

// Main scene
function DNAScene({
  variants,
  autoRotate,
  onHover,
  onClick,
}: {
  variants: VariantPoint[]
  autoRotate: boolean
  onHover: (v: VariantPoint | null) => void
  onClick: (v: VariantPoint) => void
}) {
  const TURNS = 8
  const RADIUS = 1.2
  const HEIGHT = 12

  // Use particle system for >500 variants, interactive spheres for ≤500
  const useSpheres = variants.length <= 500

  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[5, 5, 5]} intensity={1.5} color="#4488ff" />
      <pointLight position={[-5, -5, 5]} intensity={0.8} color="#ff4488" />
      <pointLight position={[0, 0, -8]} intensity={0.5} color="#ffffff" />
      <Stars radius={80} depth={50} count={3000} factor={4} saturation={0.5} fade speed={0.5} />

      <RotatingGroup autoRotate={autoRotate}>
        <Helix turns={TURNS} radius={RADIUS} height={HEIGHT} color="#4488ff" phaseOffset={0} />
        <Helix turns={TURNS} radius={RADIUS} height={HEIGHT} color="#ff4488" phaseOffset={Math.PI} />
        <BaseRungs turns={TURNS} radius={RADIUS} height={HEIGHT} />
        {useSpheres
          ? <VariantSpheres variants={variants} turns={TURNS} radius={RADIUS} height={HEIGHT} onHover={onHover} onClick={onClick} />
          : <VariantParticles variants={variants} turns={TURNS} radius={RADIUS} height={HEIGHT} />
        }
      </RotatingGroup>

      <OrbitControls enableDamping dampingFactor={0.05} minDistance={3} maxDistance={25} />
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Main exported component
// ──────────────────────────────────────────────────────────────────────────────
interface Props {
  variants: Variant[]
  chrom: string
  startPos: number
  endPos: number
}

export function DNAHelix3D({ variants, chrom, startPos, endPos }: Props) {
  const [autoRotate, setAutoRotate] = useState(true)
  const [hoveredVariant, setHoveredVariant] = useState<VariantPoint | null>(null)
  const [selectedVariant, setSelectedVariant] = useState<VariantPoint | null>(null)

  const regionSize = endPos - startPos

  // Normalize variants to [0,1] along helix
  const helixVariants = useMemo((): VariantPoint[] => {
    if (!variants.length) return []
    // Sample up to 2000 for performance
    const step = Math.ceil(variants.length / 2000)
    return variants
      .filter((_, i) => i % step === 0)
      .map(v => ({
        pos:  v.pos,
        af:   Math.min(1, Math.max(0, v.value)),
        type: v.type ?? 0,
        t:    (v.pos - startPos) / regionSize,
      }))
      .filter(v => v.t >= 0 && v.t <= 1)
  }, [variants, startPos, regionSize])

  // Count by type
  const typeCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const v of variants) {
      const t = v.type ?? 0
      counts[t] = (counts[t] ?? 0) + 1
    }
    return counts
  }, [variants])

  if (!variants.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, background: '#030608' }}>
        <div style={{ fontSize: 48 }}>🧬</div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, textAlign: 'center' }}>
          Fetch variants in the Genome Browser first,<br />then switch to 3D DNA Helix view.
        </div>
      </div>
    )
  }

  const activeVariant = hoveredVariant ?? selectedVariant

  return (
    <div style={{ flex: 1, position: 'relative', background: '#030608' }}>
      {/* Header */}
      <div style={{ position: 'absolute', top: 12, left: 16, zIndex: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 0 20px rgba(64,136,255,0.8)' }}>
          🧬 DNA Helix — {chrom}:{startPos.toLocaleString()}–{endPos.toLocaleString()}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
          {variants.length.toLocaleString()} variants · {helixVariants.length.toLocaleString()} shown · height = allele frequency
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          {Object.entries(TYPE_COLORS).map(([t, color]) => (
            <span key={t} style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block', boxShadow: `0 0 6px ${color}` }} />
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {VTYPE_LABELS[Number(t)] ?? 'SNP'} ({(typeCounts[Number(t)] ?? 0).toLocaleString()})
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}>
        <button
          onClick={() => setAutoRotate(r => !r)}
          style={{
            background: autoRotate ? 'rgba(64,136,255,0.2)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${autoRotate ? 'rgba(64,136,255,0.5)' : 'rgba(255,255,255,0.15)'}`,
            color: '#fff', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
          }}
        >
          {autoRotate ? '⏸ Pause' : '▶ Rotate'}
        </button>
      </div>

      {/* Three.js Canvas */}
      <Canvas
        camera={{ position: [0, 0, 10], fov: 50 }}
        style={{ width: '100%', height: '100%' }}
        gl={{ antialias: true, alpha: false }}
      >
        <DNAScene
          variants={helixVariants}
          autoRotate={autoRotate}
          onHover={setHoveredVariant}
          onClick={setSelectedVariant}
        />
      </Canvas>

      {/* Hover/click tooltip */}
      {activeVariant && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,8,20,0.92)',
          border: `1px solid ${TYPE_COLORS[activeVariant.type] ?? '#40c4ff'}55`,
          padding: '10px 16px', borderRadius: 8, fontSize: 12,
          color: '#e8f4ff', pointerEvents: 'none', zIndex: 10,
          display: 'flex', gap: 24, alignItems: 'center',
          backdropFilter: 'blur(10px)',
          boxShadow: `0 0 20px ${TYPE_COLORS[activeVariant.type] ?? '#40c4ff'}33`,
        }}>
          <div>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>POSITION</span>
            <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13 }}>{activeVariant.pos.toLocaleString()}</div>
          </div>
          <div>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>TYPE</span>
            <div style={{ fontWeight: 700, color: TYPE_COLORS[activeVariant.type] ?? '#40c4ff' }}>
              {VTYPE_LABELS[activeVariant.type] ?? 'SNP'}
            </div>
          </div>
          <div>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>ALLELE FREQ</span>
            <div style={{ fontWeight: 700 }}>{(activeVariant.af * 100).toFixed(2)}%</div>
          </div>
          {!hoveredVariant && (
            <button onClick={() => setSelectedVariant(null)}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 16 }}>×</button>
          )}
        </div>
      )}

      {/* Instruction hint */}
      <div style={{ position: 'absolute', bottom: 12, right: 12, fontSize: 9, color: 'rgba(255,255,255,0.2)', zIndex: 5 }}>
        drag to rotate · scroll to zoom · click spheres for details
      </div>
    </div>
  )
}
