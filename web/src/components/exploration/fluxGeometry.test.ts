/**
 * Standalone sanity tests for the Exploration Room's flux-surface resampler.
 * Run with: npx tsx src/components/exploration/fluxGeometry.test.ts
 */
import { resampleFluxSurfaces, profileAtPsi, poloidalAngle, N_POLOIDAL } from './fluxGeometry'
import type { Contour } from '../../lib/types'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

/** Ellipse (R0 + a cos t, Z0 + k a sin t) with n points, starting at angle t0. */
function ellipse(level: number, a: number, k: number, n: number, t0: number, R0 = 1.7, Z0 = 0.1): Contour {
  const points: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const t = t0 + (2 * Math.PI * i) / n
    points.push([R0 + a * Math.cos(t), Z0 + k * a * Math.sin(t)])
  }
  return { level, points }
}

// ── Test 1: nested ellipses with arbitrary start points and point counts ──
{
  const surfaces = [
    ellipse(0.9, 0.5, 1.7, 157, 2.1),
    ellipse(0.1, 0.15, 1.7, 61, -0.4),
    ellipse(0.5, 0.35, 1.7, 103, 4.0),
  ]
  const out = resampleFluxSurfaces(surfaces, 1.7, 0.1)
  assert(out.count === 3, `expected 3 surfaces, got ${out.count}`)
  assert(out.levels[0] === 0.1 && out.levels[2] === 0.9, 'surfaces sorted innermost first')
  for (let k = 0; k < out.count; k++) {
    const a = [0.15, 0.35, 0.5][k]
    for (let j = 0; j < N_POLOIDAL; j += 8) {
      const R = out.rz[(k * N_POLOIDAL + j) * 2]
      const Z = out.rz[(k * N_POLOIDAL + j) * 2 + 1]
      // Point must lie on its ellipse (to polygon-chord accuracy) ...
      const e = ((R - 1.7) / a) ** 2 + ((Z - 0.1) / (1.7 * a)) ** 2
      assert(Math.abs(e - 1) < 0.02, `k=${k} j=${j} off ellipse: ${e.toFixed(4)}`)
      // ... and at the requested poloidal angle from the axis.
      const th = Math.atan2(Z - 0.1, R - 1.7)
      const want = poloidalAngle(j)
      const d = Math.abs(Math.atan2(Math.sin(th - want), Math.cos(th - want)))
      assert(d < 1e-3, `k=${k} j=${j} angle off by ${d}`)
    }
  }
  console.log('✓ nested ellipses resampled on a fixed angular grid')
}

// ── Test 2: a stray outer chain concatenated into the contour is ignored ──
{
  const main = ellipse(0.5, 0.3, 1.5, 120, 0)
  const stray: [number, number][] = [[2.6, -1.2], [2.62, -1.25], [2.64, -1.3], [2.66, -1.35]]
  const out = resampleFluxSurfaces([{ level: 0.5, points: [...main.points, ...stray] }], 1.7, 0.1)
  assert(out.count === 1, 'surface kept')
  const R0 = out.rz[0]
  assert(Math.abs(R0 - 2.0) < 0.01, `outboard midplane radius ${R0}`)
  console.log('✓ stray chain ignored (nearest hit wins)')
}

// ── Test 3: a surface that mostly misses the rays is dropped ──
{
  const arc: [number, number][] = []
  for (let i = 0; i <= 20; i++) {
    const t = -0.3 + (0.6 * i) / 20
    arc.push([1.7 + 0.4 * Math.cos(t), 0.1 + 0.4 * Math.sin(t)])
  }
  const out = resampleFluxSurfaces([{ level: 0.7, points: arc }], 1.7, 0.1)
  assert(out.count === 0, 'open arc covering ~10% of angles is rejected')
  console.log('✓ open fragment rejected')
}

// ── Test 4: profile lookup uses rho = sqrt(psi_N) ──
{
  const prof = Array.from({ length: 51 }, (_, i) => i / 50) // value == rho
  assert(Math.abs(profileAtPsi(prof, 0.25) - 0.5) < 1e-9, 'psi 0.25 -> rho 0.5')
  assert(Math.abs(profileAtPsi(prof, 1) - 1) < 1e-9, 'psi 1 -> rho 1')
  assert(profileAtPsi([], 0.5) === 0, 'empty profile -> 0')
  console.log('✓ profile lookup')
}

console.log('All flux-geometry tests passed.')
