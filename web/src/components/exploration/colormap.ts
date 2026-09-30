/**
 * Colour maps for the Exploration Room. Perceptually ordered (sampled from
 * matplotlib's inferno and viridis) so brighter always means "more", which
 * matters when the colour encodes a profile value rather than decoration.
 */

export type ColorVar = 'te' | 'ne'

type Stop = [number, number, number]

const INFERNO: Stop[] = [
  [0.001, 0.000, 0.014], [0.087, 0.044, 0.225], [0.258, 0.039, 0.406],
  [0.416, 0.090, 0.433], [0.578, 0.148, 0.404], [0.735, 0.216, 0.330],
  [0.865, 0.317, 0.226], [0.954, 0.469, 0.099], [0.988, 0.645, 0.040],
  [0.964, 0.843, 0.273], [0.988, 0.998, 0.645],
]

const VIRIDIS: Stop[] = [
  [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318],
  [0.741, 0.873, 0.150], [0.993, 0.906, 0.144],
]

const MAPS: Record<ColorVar, Stop[]> = { te: INFERNO, ne: VIRIDIS }

/** Sample a map at x ∈ [0, 1]; returns linear-ish sRGB in [0, 1]. */
export function sampleColormap(v: ColorVar, x: number, out: Stop = [0, 0, 0]): Stop {
  const stops = MAPS[v]
  const t = Math.min(Math.max(x, 0), 1) * (stops.length - 1)
  const i = Math.min(Math.floor(t), stops.length - 2)
  const f = t - i
  const a = stops[i], b = stops[i + 1]
  out[0] = a[0] + (b[0] - a[0]) * f
  out[1] = a[1] + (b[1] - a[1]) * f
  out[2] = a[2] + (b[2] - a[2]) * f
  return out
}

/** CSS linear-gradient for the legend colour bar. */
export function colormapCss(v: ColorVar): string {
  const stops = MAPS[v]
  const parts = stops.map((s, i) => {
    const c = s.map((x) => Math.round(x * 255)).join(',')
    return `rgb(${c}) ${Math.round((100 * i) / (stops.length - 1))}%`
  })
  return `linear-gradient(to right, ${parts.join(', ')})`
}
