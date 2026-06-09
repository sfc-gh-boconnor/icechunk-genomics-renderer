/**
 * GoslingTracks — genomic track visualization using Gosling.js
 * Shows chr22 variant density, allele frequency, and type breakdown
 * as beautiful circular/linear genomic tracks
 */
import { useEffect, useRef } from 'react'
import type { Variant } from '../types'

interface Props {
  variants: Variant[]
  chrom: string
  startPos: number
  endPos: number
}

export function GoslingTracks({ variants, chrom, startPos, endPos }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || !variants.length) return

    // Gosling requires a global API — import dynamically
    import('gosling.js').then(({ embed }) => {
      if (!containerRef.current) return

      // Convert our variants to Gosling inline data format
      const data = variants.map(v => ({
        chromosome: chrom,
        start: v.pos,
        end: v.pos + 1,
        allele_freq: v.value,
        type: v.type ?? 0,
        type_label: ['SNP', 'INS', 'DEL', 'MNP'][v.type ?? 0] ?? 'SNP',
      }))

      // Sample to 5000 for performance
      const step = Math.max(1, Math.floor(data.length / 5000))
      const sampled = data.filter((_, i) => i % step === 0)

      // Size the tracks to fill the available container height
      const W = containerRef.current?.clientWidth ?? 800
      const H = containerRef.current?.clientHeight ?? 600
      const trackH = Math.max(160, Math.floor((H - 110) / 2))   // 2 tracks + title/subtitle space

      const spec = {
        title: `${chrom} Variant Landscape`,
        subtitle: `${variants.length.toLocaleString()} variants · ${startPos.toLocaleString()}–${endPos.toLocaleString()}`,
        layout: 'linear',
        arrangement: 'vertical',
        width: W,
        height: H,
        views: [
          {
            // Track 1: Variant density (bar chart)
            tracks: [{
              data: {
                type: 'json',
                values: sampled,
                chromosomeField: 'chromosome',
                genomicFields: ['start'],
              },
              mark: 'bar',
              x: { field: 'start', type: 'genomic', domain: { chromosome: chrom, interval: [startPos, endPos] }, axis: 'bottom' },
              y: { field: 'allele_freq', type: 'quantitative', axis: 'right' },
              color: {
                field: 'type_label',
                type: 'nominal',
                domain: ['SNP', 'INS', 'DEL', 'MNP'],
                range: ['#40c4ff', '#00ff80', '#ff4080', '#ffa020'],
              },
              width: W,
              height: trackH,
              title: 'Allele Frequency by Variant Type',
              style: { background: '#0a0f1a', outlineWidth: 0 },
            }],
          },
          {
            // Track 2: Point plot of variants
            tracks: [{
              data: {
                type: 'json',
                values: sampled.filter(v => v.allele_freq > 0.01),
                chromosomeField: 'chromosome',
                genomicFields: ['start'],
              },
              mark: 'point',
              x: { field: 'start', type: 'genomic', domain: { chromosome: chrom, interval: [startPos, endPos] } },
              y: { field: 'allele_freq', type: 'quantitative', axis: 'right' },
              color: {
                field: 'type_label',
                type: 'nominal',
                domain: ['SNP', 'INS', 'DEL', 'MNP'],
                range: ['#40c4ff', '#00ff80', '#ff4080', '#ffa020'],
              },
              size: { value: 2 },
              opacity: { value: 0.7 },
              width: W,
              height: trackH,
              title: 'Common Variants (AF > 1%)',
              style: { background: '#0a0f1a', outlineWidth: 0 },
            }],
          },
        ],
        style: { background: '#080d16' },
      }

      // Clear previous
      containerRef.current.innerHTML = ''
      embed(containerRef.current, spec, {
        padding: 0,
        margin: 0,
        theme: 'dark',
      })
    }).catch(err => {
      console.warn('Gosling load error:', err)
      if (containerRef.current) {
        containerRef.current.innerHTML = `<div style="padding:20px;color:rgba(255,255,255,0.4)">Gosling tracks unavailable: ${err.message}</div>`
      }
    })
  }, [variants, chrom, startPos, endPos])

  if (!variants.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
        Fetch variants first to see genomic tracks
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'hidden', background: '#080d16', borderRadius: 8 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
