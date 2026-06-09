import { useEffect, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { OrbitView } from '@deck.gl/core'
import { ColumnLayer, TextLayer } from '@deck.gl/layers'
import type { Variant } from '../types'
import { VTYPE_LABELS } from '../types'

// Color per variant type: SNP=electric blue, INS=lime, DEL=hot pink, MNP=orange
const TYPE_COLORS: [number, number, number, number][] = [
  [64, 196, 255, 220],   // SNP - electric blue
  [0, 255, 128, 220],    // INS - neon green
  [255, 64, 128, 220],   // DEL - hot pink
  [255, 160, 0, 220],    // MNP - amber
]

interface Props {
  variants: Variant[]
  chrom: string
  startPos: number
  endPos: number
  loading: boolean
}

export function Variant3DView({ variants, chrom, startPos, endPos, loading }: Props) {
  const [autoRotate, setAutoRotate] = useState(true)
  const [viewState, setViewState] = useState({
    target: [0.5, 0.15, 0] as [number, number, number],
    rotationX: 35,
    rotationOrbit: 0,
    zoom: 1.0,
    minZoom: -1,
    maxZoom: 5,
  })
  const animRef = useRef<number | null>(null)
  const [frame, setFrame] = useState(0)

  // Auto-rotate animation
  useEffect(() => {
    if (!autoRotate) {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      return
    }
    const tick = () => {
      setFrame(f => f + 1)
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [autoRotate])

  // Update rotation
  useEffect(() => {
    if (!autoRotate) return
    setViewState(vs => ({ ...vs, rotationOrbit: (vs.rotationOrbit + 0.25) % 360 }))
  }, [frame, autoRotate])

  const regionSize = endPos - startPos
  if (!variants.length && !loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 40 }}>🧬</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          Fetch variants in the Genome Browser first, then switch to 3D view.
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading variants…</div>
      </div>
    )
  }

  // Normalize positions to [0, 1] range for the 3D view
  const columns = variants.map(v => {
    const x = (v.pos - startPos) / regionSize
    const h = Math.max(0.005, v.value * 2)  // height = 2 × allele frequency
    const type = v.type ?? 0
    return { x, h, type, pos: v.pos, af: v.value, pos_str: v.pos.toLocaleString() }
  })

  // Sample max 5000 for performance
  const sample = columns.length > 5000
    ? columns.filter((_, i) => i % Math.ceil(columns.length / 5000) === 0)
    : columns

  const columnLayer = new ColumnLayer({
    id: 'variants-3d',
    data: sample,
    diskResolution: 6,  // hexagonal columns
    radius: Math.max(0.001, 0.6 / Math.max(sample.length, 1)),
    getPosition: d => [d.x, 0, 0],
    getElevation: d => d.h,
    getFillColor: d => TYPE_COLORS[d.type] ?? TYPE_COLORS[0],
    getLineColor: d => {
      const c = TYPE_COLORS[d.type] ?? TYPE_COLORS[0]
      return [Math.min(255, c[0] + 60), Math.min(255, c[1] + 60), Math.min(255, c[2] + 60), 255]
    },
    lineWidthMaxPixels: 0.5,
    material: { ambient: 0.4, diffuse: 0.6, shininess: 60, specularColor: [255, 255, 255] },
    pickable: true,
    elevationScale: 1,
    extruded: true,
  })

  // Chromosome floor line
  const floorLayer = new ColumnLayer({
    id: 'chr-floor',
    data: [{ x: 0.5 }],
    diskResolution: 4,
    radius: 0.5,
    getPosition: d => [d.x, 0, 0],
    getElevation: 0.002,
    getFillColor: [30, 50, 80, 100],
    getLineColor: [60, 100, 160, 180],
    lineWidthMaxPixels: 1,
    extruded: true,
    pickable: false,
  })

  // Type legend text
  const typeCounts = [0, 1, 2, 3].map(t => ({
    type: t,
    count: variants.filter(v => (v.type ?? 0) === t).length,
    label: VTYPE_LABELS[t] ?? 'SNP',
  })).filter(t => t.count > 0)

  return (
    <div style={{ flex: 1, position: 'relative', background: '#050810' }}>
      {/* Header */}
      <div style={{
        position: 'absolute', top: 12, left: 16, zIndex: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', textShadow: '0 0 10px rgba(64,196,255,0.5)' }}>
          🧬 {chrom}:{startPos.toLocaleString()} – {endPos.toLocaleString()}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
          {variants.length.toLocaleString()} variants · height = allele frequency · rotate to explore
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {typeCounts.map(t => (
            <span key={t.type} style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{
                width: 8, height: 8, display: 'inline-block', borderRadius: 2,
                background: `rgba(${TYPE_COLORS[t.type].slice(0,3).join(',')})`,
                boxShadow: `0 0 6px rgba(${TYPE_COLORS[t.type].slice(0,3).join(',')},0.8)`,
              }} />
              <span style={{ color: 'rgba(255,255,255,0.7)' }}>{t.label} ({t.count.toLocaleString()})</span>
            </span>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, display: 'flex', gap: 6 }}>
        <button
          onClick={() => setAutoRotate(r => !r)}
          style={{
            background: autoRotate ? 'rgba(64,196,255,0.2)' : 'rgba(255,255,255,0.1)',
            border: `1px solid ${autoRotate ? 'rgba(64,196,255,0.5)' : 'rgba(255,255,255,0.2)'}`,
            color: '#fff', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
          }}
        >
          {autoRotate ? '⏸ Pause' : '▶ Rotate'}
        </button>
      </div>

      {/* Axis labels */}
      <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }}>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
          ← genomic position ({(regionSize / 1000).toFixed(0)} kb) →
        </div>
      </div>
      <div style={{ position: 'absolute', left: 20, top: '50%', transform: 'translateY(-50%) rotate(-90deg)', zIndex: 5 }}>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>
          ↑ allele frequency
        </div>
      </div>

      <DeckGL
        views={new OrbitView({ id: 'orbit' })}
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => {
          if (!autoRotate) setViewState(vs as typeof viewState)
        }}
        controller={true}
        layers={[floorLayer, columnLayer]}
        style={{ width: '100%', height: '100%' }}
        
        getTooltip={({ object }) => object && {
          html: `<div style="font-family:monospace;font-size:11px;line-height:1.5">
            <b>Position:</b> ${(object as typeof columns[0]).pos_str}<br/>
            <b>Type:</b> ${VTYPE_LABELS[(object as typeof columns[0]).type] ?? 'SNP'}<br/>
            <b>Allele Freq:</b> ${((object as typeof columns[0]).af * 100).toFixed(2)}%
          </div>`,
          style: { background: 'rgba(0,10,20,0.95)', border: '1px solid rgba(64,196,255,0.4)', borderRadius: '6px', padding: '8px', color: '#e0f0ff' },
        }}
      />

      {/* Ambient grid lines */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1,
        background: 'radial-gradient(ellipse at 50% 80%, rgba(64,100,200,0.08) 0%, transparent 70%)',
      }} />
    </div>
  )
}
