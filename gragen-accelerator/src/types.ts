// ── Dataset types ─────────────────────────────────────────────────────────────

export interface Sample {
  sample_id: string
  sex: string
  population: string
  pop_name: string
  superpopulation: string
  superpop_name: string
}

export interface SampleMetrics extends Sample {
  mean_coverage?: number
  pct_duplicates?: number
  pct_mapped?: number
  total_reads?: number
  total_variants?: number
  snp_count?: number
  indel_count?: number
  titv_ratio?: number
  het_hom_ratio?: number
  error?: string
}

export interface Variant {
  pos: number
  ref: string
  alts: string[]
  qual: number | null
  filter: string[]
  type: 'SNP' | 'INS' | 'DEL' | 'MNP' | 'REF'
  af: number | null
}

export interface DensityBin {
  pos: number
  count: number
}

export interface VariantResult {
  sample_id: string
  chrom: string
  start: number
  end: number
  count: number
  truncated: boolean
  variants: Variant[]
  density: DensityBin[] | null
}

export interface MetaResult {
  sample_count: number
  chromosomes: string[]
  chrom_lengths: Record<string, number>
  superpopulations: Record<string, number>
  superpop_colors: Record<string, [number, number, number]>
  dragen_version: string
  reference: string
}

// ── Superpopulation colours (fallback if meta not loaded) ─────────────────────

export const SUPERPOP_COLORS: Record<string, [number, number, number]> = {
  AFR: [230, 60,  60],
  AMR: [230, 130, 40],
  EAS: [60,  180, 60],
  EUR: [60,  120, 220],
  SAS: [160, 60,  200],
}

export const SUPERPOP_LABELS: Record<string, string> = {
  AFR: 'African',
  AMR: 'Admixed American',
  EAS: 'East Asian',
  EUR: 'European',
  SAS: 'South Asian',
}

export const VARIANT_COLORS: Record<string, [number, number, number]> = {
  SNP: [60,  120, 220],
  INS: [60,  180, 60],
  DEL: [230, 60,  60],
  MNP: [200, 140, 30],
  REF: [120, 120, 120],
}

// Chromosome display order
export const CHROMOSOMES = [
  'chr1','chr2','chr3','chr4','chr5','chr6','chr7','chr8','chr9','chr10',
  'chr11','chr12','chr13','chr14','chr15','chr16','chr17','chr18','chr19',
  'chr20','chr21','chr22','chrX','chrY',
]

export const CHROM_LENGTHS: Record<string, number> = {
  chr1: 248_956_422, chr2: 242_193_529, chr3: 198_295_559, chr4: 190_214_555,
  chr5: 181_538_259, chr6: 170_805_979, chr7: 159_345_973, chr8: 145_138_636,
  chr9: 138_394_717, chr10: 133_797_422, chr11: 135_086_622, chr12: 133_275_309,
  chr13: 114_364_328, chr14: 107_043_718, chr15: 101_991_189, chr16: 90_338_345,
  chr17: 83_257_441, chr18: 80_373_148, chr19: 58_617_616, chr20: 64_444_167,
  chr21: 46_709_983, chr22: 50_818_468, chrX: 156_040_895, chrY: 57_227_415,
}
