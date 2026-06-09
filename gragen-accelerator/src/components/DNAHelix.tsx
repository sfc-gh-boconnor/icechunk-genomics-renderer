/**
 * DNAHelix — Three.js animated 3D DNA double helix
 * Shows chr22 variants as glowing spheres along the backbone
 * Color = variant type, size = allele frequency
 */
import { useRef, useMemo, useState, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Stars, Tube, Sphere } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import type { Variant, GenomeAnnotation, AnnoSource } from '../types'
import { VTYPE_LABELS, ANNO_SOURCE_LABELS } from '../types'

const TYPE_COLORS_HEX = ['#00b4ff', '#00ff7f', '#ff2060', '#ffa500']  // SNP, INS, DEL, MNP
const TYPE_COLORS_INT = [0x00b4ff, 0x00ff7f, 0xff2060, 0xffa500]

const HELIX_TURNS = 6
const HELIX_RADIUS = 1.5
const HELIX_HEIGHT = 15

// Base-pair colors: A-T pair (red/blue) and G-C pair (yellow/green)
const BP_PAIRS = [
  [0xff4d6d, 0x4d9bff],  // A-T
  [0xffd23f, 0x3fffa8],  // G-C
]

// One helical strand (tube path)
function HelixStrand({ phase, color }: { phase: number; color: number }) {
  const curve = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 300; i++) {
      const t = i / 300
      const angle = t * HELIX_TURNS * Math.PI * 2 + phase
      pts.push(new THREE.Vector3(
        HELIX_RADIUS * Math.cos(angle),
        t * HELIX_HEIGHT - HELIX_HEIGHT / 2,
        HELIX_RADIUS * Math.sin(angle),
      ))
    }
    return new THREE.CatmullRomCurve3(pts)
  }, [phase])

  return (
    <Tube args={[curve, 300, 0.1, 8, false]}>
      <meshStandardMaterial
        color={color} emissive={color} emissiveIntensity={0.5}
        roughness={0.3} metalness={0.7} transparent opacity={0.95}
      />
    </Tube>
  )
}

// Base-pair ladder rungs between the two strands — each rung is two
// colored halves meeting at the centre (the classic A-T / G-C look).
function BaseRungs() {
  const rungs = useMemo(() => {
    const out: {
      key: number
      c1: THREE.CatmullRomCurve3; c2: THREE.CatmullRomCurve3
      col1: number; col2: number
    }[] = []
    const steps = HELIX_TURNS * 10  // ~10 base pairs per turn (DNA-like)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const angle = t * HELIX_TURNS * Math.PI * 2
      const y = t * HELIX_HEIGHT - HELIX_HEIGHT / 2
      const p1 = new THREE.Vector3(HELIX_RADIUS * Math.cos(angle), y, HELIX_RADIUS * Math.sin(angle))
      const p2 = new THREE.Vector3(HELIX_RADIUS * Math.cos(angle + Math.PI), y, HELIX_RADIUS * Math.sin(angle + Math.PI))
      const mid = p1.clone().lerp(p2, 0.5)
      const [col1, col2] = BP_PAIRS[i % BP_PAIRS.length]
      out.push({
        key: i,
        c1: new THREE.LineCurve3(p1, mid) as unknown as THREE.CatmullRomCurve3,
        c2: new THREE.LineCurve3(mid, p2) as unknown as THREE.CatmullRomCurve3,
        col1, col2,
      })
    }
    return out
  }, [])

  return (
    <>
      {rungs.map(({ key, c1, c2, col1, col2 }) => (
        <group key={key}>
          <Tube args={[c1, 1, 0.05, 6, false]}>
            <meshStandardMaterial color={col1} emissive={col1} emissiveIntensity={0.45} roughness={0.4} metalness={0.2} transparent opacity={0.85} />
          </Tube>
          <Tube args={[c2, 1, 0.05, 6, false]}>
            <meshStandardMaterial color={col2} emissive={col2} emissiveIntensity={0.45} roughness={0.4} metalness={0.2} transparent opacity={0.85} />
          </Tube>
        </group>
      ))}
    </>
  )
}

// Variant position on helix
interface VPoint { pos: number; af: number; type: number; t: number }

// Local-space position of a variant on the helix (matches VariantDot / VariantCloud)
function variantLocalPos(vp: VPoint): THREE.Vector3 {
  const angle = vp.t * HELIX_TURNS * Math.PI * 2
  const y = vp.t * HELIX_HEIGHT - HELIX_HEIGHT / 2
  const r = HELIX_RADIUS + 0.15 + vp.af * 0.5
  return new THREE.Vector3(r * Math.cos(angle), y, r * Math.sin(angle))
}

// ── Genome annotations (ClinVar / GWAS / SFARI) ─────────────────────────────
interface AnnoPoint extends GenomeAnnotation { t: number }

const ANNO_MARKER_R = HELIX_RADIUS + 0.75   // markers float just outside the backbone

function annoLocalPos(t: number): THREE.Vector3 {
  const angle = t * HELIX_TURNS * Math.PI * 2
  const y = t * HELIX_HEIGHT - HELIX_HEIGHT / 2
  return new THREE.Vector3(ANNO_MARKER_R * Math.cos(angle), y, ANNO_MARKER_R * Math.sin(angle))
}

// A single annotation: a glowing marker on a short stalk off the backbone.
// Shape encodes the source: icosahedron=ClinVar, octahedron=GWAS, box=SFARI gene.
function AnnoMarker({ a, onHover }: { a: AnnoPoint; onHover: (c: AnnoPoint | null) => void }) {
  const ref = useRef<THREE.Mesh>(null)
  const angle = a.t * HELIX_TURNS * Math.PI * 2
  const y = a.t * HELIX_HEIGHT - HELIX_HEIGHT / 2
  const outer = annoLocalPos(a.t)
  const baseR = HELIX_RADIUS + 0.1
  const col = useMemo(() => new THREE.Color(a.color[0] / 255, a.color[1] / 255, a.color[2] / 255), [a.color])
  const stalk = useMemo(
    () => new THREE.LineCurve3(
      new THREE.Vector3(baseR * Math.cos(angle), y, baseR * Math.sin(angle)),
      outer,
    ) as unknown as THREE.CatmullRomCurve3,
    [a.t],
  )

  useFrame(() => {
    if (ref.current) ref.current.scale.setScalar(1 + Math.sin(Date.now() * 0.004 + a.t * 12) * 0.14)
  })

  return (
    <group>
      <Tube args={[stalk, 1, 0.02, 5, false]}>
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.4} transparent opacity={0.5} />
      </Tube>
      <mesh
        ref={ref}
        position={[outer.x, outer.y, outer.z]}
        onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; onHover(a) }}
        onPointerOut={() => { document.body.style.cursor = 'default'; onHover(null) }}
      >
        {a.source === 'gwas'
          ? <octahedronGeometry args={[0.18, 0]} />
          : a.source === 'sfari'
            ? <boxGeometry args={[0.26, 0.26, 0.26]} />
            : <icosahedronGeometry args={[0.17, 0]} />}
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.4} roughness={0.2} metalness={0.3} />
      </mesh>
    </group>
  )
}


// Individual variant sphere
function VariantDot({ vp, onClick, onHover }: {
  vp: VPoint
  onClick: () => void
  onHover: (v: VPoint | null) => void
}) {
  const ref = useRef<THREE.Mesh>(null)
  const angle = vp.t * HELIX_TURNS * Math.PI * 2
  const y = vp.t * HELIX_HEIGHT - HELIX_HEIGHT / 2
  const r = HELIX_RADIUS + 0.15 + vp.af * 0.5
  const x = r * Math.cos(angle)
  const z = r * Math.sin(angle)
  const sz = 0.05 + vp.af * 0.18
  const col = TYPE_COLORS_INT[vp.type] ?? TYPE_COLORS_INT[0]

  useFrame(() => {
    if (!ref.current) return
    const s = 1 + Math.sin(Date.now() * 0.002 + vp.t * 20) * 0.05
    ref.current.scale.setScalar(s)
  })

  return (
    <Sphere
      ref={ref}
      args={[sz, 8, 8]}
      position={[x, y, z]}
      onClick={onClick}
      onPointerOver={() => onHover(vp)}
      onPointerOut={() => onHover(null)}
    >
      <meshStandardMaterial
        color={col} emissive={col}
        emissiveIntensity={0.6 + vp.af * 1.5}
        roughness={0.15} metalness={0.4}
      />
    </Sphere>
  )
}

// Points cloud for large variant sets
function VariantCloud({ vpoints, onPick }: { vpoints: VPoint[]; onPick: (i: number) => void }) {
  const { positions, colors } = useMemo(() => {
    const pos = new Float32Array(vpoints.length * 3)
    const col = new Float32Array(vpoints.length * 3)
    const c = new THREE.Color()
    vpoints.forEach((vp, i) => {
      const angle = vp.t * HELIX_TURNS * Math.PI * 2
      const y = vp.t * HELIX_HEIGHT - HELIX_HEIGHT / 2
      const r = HELIX_RADIUS + 0.15 + vp.af * 0.5
      pos[i*3]   = r * Math.cos(angle)
      pos[i*3+1] = y
      pos[i*3+2] = r * Math.sin(angle)
      c.set(TYPE_COLORS_INT[vp.type] ?? TYPE_COLORS_INT[0])
      col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b
    })
    return { positions: pos, colors: col }
  }, [vpoints])

  return (
    <points
      onClick={(e) => { e.stopPropagation(); if (e.index != null) onPick(e.index) }}
      onPointerOver={() => { document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { document.body.style.cursor = 'default' }}
    >
      <bufferGeometry>
        <bufferAttribute args={[positions, 3]} attach="attributes-position" />
        <bufferAttribute args={[colors, 3]} attach="attributes-color" />
      </bufferGeometry>
      <pointsMaterial
        vertexColors size={0.13} sizeAttenuation
        transparent opacity={0.85} depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

// Wrapper that rotates with optional auto-spin
function HelixGroup({
  groupRef, vpoints, annos, autoRotate, onHover, onSelect, onExplain, onAnnoHover,
}: {
  groupRef: React.RefObject<THREE.Group>,
  vpoints: VPoint[], annos: AnnoPoint[], autoRotate: boolean,
  onHover: (v: VPoint | null) => void,
  onSelect: (v: VPoint) => void,
  onExplain: (v: VPoint) => void,
  onAnnoHover: (c: AnnoPoint | null) => void,
}) {
  useFrame((_, dt) => {
    if (autoRotate && groupRef.current) groupRef.current.rotation.y += dt * 0.4
  })

  const useSpheres = vpoints.length <= 600
  const pick = (vp: VPoint) => { onSelect(vp); onExplain(vp) }

  return (
    <group ref={groupRef}>
      <HelixStrand phase={0} color={0x4488ff} />
      <HelixStrand phase={Math.PI} color={0xaa44ff} />
      <BaseRungs />
      {useSpheres
        ? vpoints.map((vp, i) => (
          <VariantDot key={i} vp={vp} onClick={() => pick(vp)} onHover={onHover} />
        ))
        : <VariantCloud vpoints={vpoints} onPick={(i) => pick(vpoints[i])} />
      }
      {annos.map((a, i) => (
        <AnnoMarker key={`anno-${i}`} a={a} onHover={onAnnoHover} />
      ))}
    </group>
  )
}

// Smoothly flies the camera in to focus on a local-space point on the helix.
function CameraRig({ focus, groupRef, controlsRef }: {
  focus: THREE.Vector3 | null
  groupRef: React.RefObject<THREE.Group>
  controlsRef: React.RefObject<OrbitControlsImpl | null>
}) {
  const { camera } = useThree()
  const targetPos = useRef(new THREE.Vector3())
  const camPos = useRef(new THREE.Vector3())
  const active = useRef(false)

  useEffect(() => {
    if (!focus || !groupRef.current) { active.current = false; return }
    // local position on helix, rotated into world space by the (now paused) group
    const world = focus.clone().applyQuaternion(groupRef.current.quaternion)
    targetPos.current.copy(world)
    // sit the camera outside the helix, level with the point, ~3.2 units away
    const radial = new THREE.Vector3(world.x, 0, world.z)
    if (radial.lengthSq() < 1e-4) radial.set(0, 0, 1)
    radial.normalize()
    camPos.current.copy(world).add(radial.multiplyScalar(3.2))
    active.current = true
  }, [focus, groupRef])

  useFrame(() => {
    if (!active.current || !controlsRef.current) return
    camera.position.lerp(camPos.current, 0.09)
    controlsRef.current.target.lerp(targetPos.current, 0.09)
    controlsRef.current.update()
    if (camera.position.distanceTo(camPos.current) < 0.05) active.current = false
  })

  return null
}
interface Props {
  variants: Variant[]
  chrom: string
  startPos: number
  endPos: number
  sampleId?: string
  onExplain?: (message: string) => void
  // ── Multi-source annotations ──
  annotations?: GenomeAnnotation[]
  annoSource?: AnnoSource
  annoShow?: boolean
  annoLoading?: boolean
  onSetAnnoSource?: (s: AnnoSource) => void
  onToggleAnno?: (show: boolean) => void
  onRequestAnno?: () => void
  clinFilter?: number[] | null            // ClinVar only: allowed clinsig codes; null = all
  onSetClinFilter?: (codes: number[] | null) => void
}

export function DNAHelix({
  variants, chrom, startPos, endPos, sampleId, onExplain,
  annotations, annoSource = 'clinvar', annoShow = false, annoLoading,
  onSetAnnoSource, onToggleAnno, onRequestAnno,
  clinFilter = null, onSetClinFilter,
}: Props) {
  const [autoRotate, setAutoRotate] = useState(true)
  const [hovered, setHovered] = useState<VPoint | null>(null)
  const [selected, setSelected] = useState<VPoint | null>(null)
  const [focus, setFocus] = useState<THREE.Vector3 | null>(null)
  const [hoveredAnno, setHoveredAnno] = useState<AnnoPoint | null>(null)
  const groupRef = useRef<THREE.Group>(null)
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const MAX_ANNO_MARKERS = 600

  const regionSize = endPos - startPos

  const vpoints = useMemo((): VPoint[] => {
    if (!variants.length) return []
    const step = Math.max(1, Math.ceil(variants.length / 2000))
    return variants
      .filter((_, i) => i % step === 0)
      .map(v => ({
        pos: v.pos,
        af: Math.min(1, Math.max(0, v.value)),
        type: v.type ?? 0,
        t: (v.pos - startPos) / regionSize,
      }))
      .filter(v => v.t >= 0 && v.t <= 1)
  }, [variants, startPos, regionSize])

  const typeCounts = useMemo(() => {
    const c: Record<number, number> = {}
    variants.forEach(v => { const t = v.type ?? 0; c[t] = (c[t] ?? 0) + 1 })
    return c
  }, [variants])

  const annoPoints = useMemo((): AnnoPoint[] => {
    if (!annotations?.length) return []
    const allowed = annoSource === 'clinvar' && clinFilter && clinFilter.length
      ? new Set(clinFilter) : null
    return annotations
      .filter(a => !allowed || (a.clinsig != null && allowed.has(a.clinsig)))
      .map(a => ({ ...a, t: (a.pos - startPos) / regionSize }))
      .filter(a => a.t >= 0 && a.t <= 1)
      .slice(0, MAX_ANNO_MARKERS)
  }, [annotations, annoSource, clinFilter, startPos, regionSize])

  // pick a variant: pin it, pause spin, fly camera to it, ask the agent
  const pickVariant = (vp: VPoint) => { setSelected(vp); setAutoRotate(false); setFocus(variantLocalPos(vp)) }
  // hover an annotation: show card, pause spin, zoom to it
  const hoverAnno = (a: AnnoPoint | null) => {
    setHoveredAnno(a)
    if (a) { setAutoRotate(false); setFocus(annoLocalPos(a.t)) }
  }

  const activeVariant = hovered ?? selected

  if (!variants.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, background: '#030608' }}>
        <div style={{ fontSize: 48 }}>🧬</div>
        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 14, textAlign: 'center' }}>
          Fetch variants in the Genome Browser first,<br />then return here to see them on the 3D helix.
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, position: 'relative', background: '#030608' }}>
      {/* Header overlay */}
      <div style={{ position: 'absolute', top: 12, left: 16, zIndex: 10, pointerEvents: 'none' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 0 20px rgba(68,136,255,0.9)' }}>
          🧬 DNA Helix — {chrom}:{startPos.toLocaleString()}–{endPos.toLocaleString()}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
          {variants.length.toLocaleString()} variants · sphere size = allele frequency
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
          {[0, 1, 2, 3].map(t => typeCounts[t] ? (
            <span key={t} style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: TYPE_COLORS_HEX[t], display: 'inline-block',
                boxShadow: `0 0 6px ${TYPE_COLORS_HEX[t]}`,
              }} />
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {VTYPE_LABELS[t] ?? 'SNP'} ({typeCounts[t].toLocaleString()})
              </span>
            </span>
          ) : null)}
        </div>
      </div>

      {/* Pause / rotate + annotation source selector + significance filter */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        {annoShow && (
          <select
            value={annoSource}
            onChange={e => onSetAnnoSource?.(e.target.value as AnnoSource)}
            title="Annotation source"
            style={{
              background: 'rgba(2,4,12,0.85)', color: '#eee', fontSize: 11,
              border: '1px solid rgba(120,160,255,0.5)', borderRadius: 6, padding: '5px 6px', cursor: 'pointer',
            }}
          >
            {Object.entries(ANNO_SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        )}
        {annoShow && annoSource === 'clinvar' && (
          <select
            value={JSON.stringify(clinFilter)}
            onChange={e => onSetClinFilter?.(JSON.parse(e.target.value) as number[] | null)}
            title="Filter ClinVar annotations by clinical significance"
            style={{
              background: 'rgba(2,4,12,0.85)', color: '#eee', fontSize: 11,
              border: '1px solid rgba(255,77,109,0.5)', borderRadius: 6, padding: '5px 6px', cursor: 'pointer',
            }}
          >
            <option value="[4]">Pathogenic only</option>
            <option value="[3,4]">Pathogenic + Likely</option>
            <option value="[2]">VUS</option>
            <option value="[0,1]">Benign</option>
            <option value="[5]">Conflicting</option>
            <option value="null">All significances</option>
          </select>
        )}
        <button
          onClick={() => {
            const next = !annoShow
            onToggleAnno?.(next)
            if (next && !annotations?.length) onRequestAnno?.()
          }}
          style={{
            background: annoShow ? 'rgba(120,160,255,0.22)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${annoShow ? 'rgba(120,160,255,0.6)' : 'rgba(255,255,255,0.15)'}`,
            color: '#ddd', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
          }}
        >
          {annoLoading ? '⏳ Loading…' : annoShow ? `🔖 Annotations (${annoPoints.length})` : '🔖 Annotations'}
        </button>
        <button
          onClick={() => setAutoRotate(r => !r)}
          style={{
            background: autoRotate ? 'rgba(68,136,255,0.2)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${autoRotate ? 'rgba(68,136,255,0.5)' : 'rgba(255,255,255,0.15)'}`,
            color: '#ddd', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
          }}
        >
          {autoRotate ? '⏸ Pause' : '▶ Rotate'}
        </button>
      </div>

      {/* Canvas */}
      <Canvas
        camera={{ position: [0, 0, 16], fov: 50 }}
        style={{ width: '100%', height: '100%' }}
        gl={{ antialias: true }}
        raycaster={{ params: { Points: { threshold: 0.18 } } as unknown as THREE.RaycasterParameters }}
      >
        <ambientLight intensity={0.3} />
        <pointLight position={[6, 6, 6]} intensity={1.5} color={0x4488ff} />
        <pointLight position={[-6, -6, 6]} intensity={0.9} color={0xaa44ff} />
        <Stars radius={80} depth={50} count={3000} factor={4} saturation={0.5} fade speed={0.4} />
        <fog attach="fog" args={[0x020408, 32, 70]} />
        <HelixGroup
          groupRef={groupRef}
          vpoints={vpoints}
          annos={annoShow ? annoPoints : []}
          autoRotate={autoRotate}
          onHover={setHovered}
          onSelect={pickVariant}
          onAnnoHover={hoverAnno}
          onExplain={vp => {
            if (!onExplain) return
            const typeLabel = VTYPE_LABELS[vp.type] ?? 'SNP'
            onExplain(
              `Explain the ${typeLabel} variant at ${chrom}:${vp.pos.toLocaleString()}` +
              `${sampleId ? ` in sample ${sampleId}` : ''} (allele frequency ${(vp.af * 100).toFixed(2)}%). ` +
              `What does this variant type mean, and what is its potential significance in population genetics or clinical context?`,
            )
          }}
        />
        <CameraRig focus={focus} groupRef={groupRef} controlsRef={controlsRef} />
        <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.07} minDistance={3} maxDistance={45} />
      </Canvas>

      {/* Variant tooltip */}
      {activeVariant && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(2,4,12,0.92)',
          border: `1px solid ${TYPE_COLORS_HEX[activeVariant.type] ?? '#40c4ff'}55`,
          padding: '10px 18px', borderRadius: 8, zIndex: 10,
          display: 'flex', gap: 22, alignItems: 'center',
          backdropFilter: 'blur(12px)',
          boxShadow: `0 0 24px ${TYPE_COLORS_HEX[activeVariant.type] ?? '#40c4ff'}33`,
          fontSize: 12, color: '#e8f4ff', pointerEvents: 'none',
        }}>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>Position</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{activeVariant.pos.toLocaleString()}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>Type</div>
            <div style={{ fontWeight: 700, color: TYPE_COLORS_HEX[activeVariant.type] ?? '#40c4ff' }}>
              {VTYPE_LABELS[activeVariant.type] ?? 'SNP'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>Allele Freq</div>
            <div style={{ fontWeight: 700 }}>{(activeVariant.af * 100).toFixed(2)}%</div>
          </div>
        </div>
      )}

      {/* Annotation card (on hover) */}
      {hoveredAnno && (
        <div style={{
          position: 'absolute', top: 70, left: 16, zIndex: 11, maxWidth: 300,
          background: 'rgba(2,4,12,0.94)',
          border: `1px solid rgb(${hoveredAnno.color[0]},${hoveredAnno.color[1]},${hoveredAnno.color[2]})`,
          padding: '12px 16px', borderRadius: 10,
          backdropFilter: 'blur(12px)',
          boxShadow: `0 0 28px rgba(${hoveredAnno.color[0]},${hoveredAnno.color[1]},${hoveredAnno.color[2]},0.35)`,
          fontSize: 12, color: '#e8f4ff',
        }}>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            {ANNO_SOURCE_LABELS[hoveredAnno.source]}
          </div>
          <div style={{
            fontWeight: 800, fontSize: 15, marginBottom: 6,
            color: `rgb(${hoveredAnno.color[0]},${hoveredAnno.color[1]},${hoveredAnno.color[2]})`,
          }}>
            {hoveredAnno.label}
          </div>
          {hoveredAnno.sublabel && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>
              {hoveredAnno.sublabel}
            </div>
          )}
          <div style={{ fontFamily: 'monospace', marginBottom: 2 }}>
            {hoveredAnno.start != null && hoveredAnno.end != null
              ? `${chrom}:${hoveredAnno.start.toLocaleString()}–${hoveredAnno.end.toLocaleString()}`
              : `${chrom}:${hoveredAnno.pos.toLocaleString()}`}
          </div>
          {hoveredAnno.link && (
            <div style={{ fontSize: 10, color: 'rgba(120,200,255,0.7)', marginTop: 6, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {hoveredAnno.link}
            </div>
          )}
        </div>
      )}

      {/* Hint */}
      <div style={{ position: 'absolute', bottom: 10, right: 12, fontSize: 9, color: 'rgba(255,255,255,0.2)', zIndex: 5 }}>
        drag to orbit · scroll to zoom · click a variant → agent explains · hover a 🔖 annotation to zoom in
      </div>
    </div>
  )
}
