import { useEffect, useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'

// 1000 Genomes population coordinates
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

const SUPERPOP_COLORS: Record<string, string> = {
  AFR: '#f59e0b', AMR: '#10b981', EAS: '#3b82f6', EUR: '#8b5cf6', SAS: '#ef4444',
}

const SUPERPOP_LABELS: Record<string, string> = {
  AFR: 'African', AMR: 'Admixed American', EAS: 'East Asian', EUR: 'European', SAS: 'South Asian',
}

interface PopStat {
  population: string
  superpopulation: string
  sex: string
  cnt: number
}

interface Props {
  popStats: PopStat[]
}

export function CohortMap({ popStats }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<MapLibreMap | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; pop: string; sp: string; total: number; male: number; female: number } | null>(null)

  // Aggregate by population
  const byPop: Record<string, { sp: string; total: number; male: number; female: number }> = {}
  for (const s of popStats) {
    if (!byPop[s.population]) byPop[s.population] = { sp: s.superpopulation, total: 0, male: 0, female: 0 }
    byPop[s.population].total += s.cnt
    if (s.sex === 'male') byPop[s.population].male += s.cnt
    else if (s.sex === 'female') byPop[s.population].female += s.cnt
  }

  const maxCount = Math.max(...Object.values(byPop).map(p => p.total), 1)

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return

    import('maplibre-gl').then(({ Map, NavigationControl }) => {
      const map = new Map({
        container: mapRef.current!,
        style: {
          version: 8,
          name: 'dark',
          glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
          sources: {},
          layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
          ],
        },
        center: [20, 20],
        zoom: 1.2,
        attributionControl: false,
      })

      mapInstance.current = map
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right')

      map.on('load', () => {
        setLoaded(true)

        // Bundled world outline — no external tiles
        Promise.resolve().then(async () => {
          try {
            const mod = await import('../assets/world-outline.json')
            map.addSource('world', { type: 'geojson', data: mod.default as never })
            map.addLayer({ id: 'continents', type: 'fill', source: 'world',
              paint: { 'fill-color': '#1a2332', 'fill-opacity': 0.95 } })
            map.addLayer({ id: 'cont-lines', type: 'line', source: 'world',
              paint: { 'line-color': '#2d4a6e', 'line-width': 0.8 } })
          } catch { /* ignore */ }
        })

        // Add markers as circles for each population
        const features = Object.entries(byPop)
          .filter(([pop]) => POP_COORDS[pop])
          .map(([pop, data]) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: POP_COORDS[pop] },
            properties: { pop, ...data, radius: 6 + (data.total / maxCount) * 24 },
          }))

        map.addSource('populations', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        })

        // Add a circle layer per superpopulation
        const superpops = ['AFR', 'AMR', 'EAS', 'EUR', 'SAS']
        for (const sp of superpops) {
          map.addLayer({
            id: `circles-${sp}`,
            type: 'circle',
            source: 'populations',
            filter: ['==', ['get', 'sp'], sp],
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'],
                1, ['/', ['get', 'radius'], 3],
                4, ['get', 'radius'],
              ],
              'circle-color': SUPERPOP_COLORS[sp],
              'circle-opacity': 0.85,
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#fff',
              'circle-stroke-opacity': 0.5,
            },
          })
        }

        // Add labels
        map.addLayer({
          id: 'pop-labels',
          type: 'symbol',
          source: 'populations',
          layout: {
            'text-field': ['get', 'pop'],
            'text-size': 10,
            'text-anchor': 'top',
            'text-offset': [0, 0.8],
            'text-optional': true,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 1,
          },
        })

        // Hover tooltip
        for (const sp of superpops) {
          map.on('mouseenter', `circles-${sp}`, (e) => {
            map.getCanvas().style.cursor = 'pointer'
            const f = e.features?.[0]
            if (!f) return
            const p = f.properties
            const pt = e.point
            setTooltip({
              x: pt.x, y: pt.y,
              pop: p.pop, sp: p.sp,
              total: p.total, male: p.male, female: p.female,
            })
          })
          map.on('mouseleave', `circles-${sp}`, () => {
            map.getCanvas().style.cursor = ''
            setTooltip(null)
          })
        }
      })
    })

    return () => {
      mapInstance.current?.remove()
      mapInstance.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update source data when popStats change
  useEffect(() => {
    if (!loaded || !mapInstance.current) return
    const map = mapInstance.current
    const src = map.getSource('populations') as import('maplibre-gl').GeoJSONSource | undefined
    if (!src) return
    const features = Object.entries(byPop)
      .filter(([pop]) => POP_COORDS[pop])
      .map(([pop, data]) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: POP_COORDS[pop] },
        properties: { pop, ...data, radius: 6 + (data.total / maxCount) * 24 },
      }))
    src.setData({ type: 'FeatureCollection', features })
  }, [popStats, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <div ref={mapRef} style={{ height: '100%', minHeight: 400, width: '100%', borderRadius: 8 }} />

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 8, left: 8, background: 'rgba(0,0,0,0.75)',
        padding: '6px 10px', borderRadius: 6, fontSize: 10,
        display: 'flex', flexDirection: 'column', gap: 3,
      }}>
        {Object.entries(SUPERPOP_COLORS).map(([sp, color]) => (
          <div key={sp} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
            <span style={{ color: '#ccc' }}>{SUPERPOP_LABELS[sp]}</span>
          </div>
        ))}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'absolute',
          left: tooltip.x + 12, top: tooltip.y - 40,
          background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(255,255,255,0.2)',
          padding: '6px 10px', borderRadius: 6, fontSize: 11, pointerEvents: 'none',
          color: '#fff', minWidth: 140,
        }}>
          <div style={{ fontWeight: 700, color: SUPERPOP_COLORS[tooltip.sp], marginBottom: 3 }}>
            {tooltip.pop} ({SUPERPOP_LABELS[tooltip.sp] ?? tooltip.sp})
          </div>
          <div>Total: <strong>{tooltip.total}</strong></div>
          <div>♂ Male: {tooltip.male} · ♀ Female: {tooltip.female}</div>
        </div>
      )}
    </div>
  )
}
