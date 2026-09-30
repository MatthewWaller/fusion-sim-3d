/**
 * Flux-surface resampling for the Exploration Room.
 *
 * The engine hands us each flux surface as a marching-squares contour: a flat
 * (R, Z) point list whose length, starting point and winding change from tick
 * to tick, and which may contain extra chains concatenated with no separator.
 * To sweep those contours around the torus on the GPU we need a fixed grid:
 * every surface sampled at the same M poloidal angles, in the same order,
 * every frame. Then a frame's update is just "overwrite K×M (R, Z) pairs in a
 * texture"; the mesh topology never changes.
 *
 * Method: cast M rays from the magnetic axis at evenly spaced geometric
 * poloidal angles θ_j and intersect each with the contour. Closed flux
 * surfaces of the Cerfon-Freidberg solutions the engine uses (positive or
 * negative triangularity) are star-shaped about the axis, so each ray hits a
 * surface exactly once; stray chains further out are ignored by keeping the
 * nearest hit. This is purely a re-parameterisation of what the engine
 * computed; no geometry is invented. Rays that miss (a contour broken at the
 * grid edge) are filled by interpolating the neighbouring rays' radii.
 */

import type { Contour } from '../../lib/types'
import { splitChains } from '../portview/types'

/** Poloidal samples per surface. Power of two keeps the texture tidy. */
export const N_POLOIDAL = 128

/**
 * Flux-surface rows in the texture. The engine emits ψ_N = 0.1 … 0.9 in ten
 * steps plus a ψ_N = 0.995 near-LCFS surface: 11 in total.
 */
export const MAX_SURFACES = 11

export interface ResampledSurfaces {
  /** Number of valid surfaces (rows) filled, innermost first. */
  count: number
  /** ψ_N level of each valid row. */
  levels: number[]
  /** Packed (R, Z) per sample: rz[(k * N_POLOIDAL + j) * 2 + {0,1}]. */
  rz: Float32Array
  axisR: number
  axisZ: number
}

/** Poloidal angle of sample j (0 = outboard midplane, counter-clockwise). */
export function poloidalAngle(j: number): number {
  return (2 * Math.PI * j) / N_POLOIDAL
}

/**
 * Distance along the ray (axis + t·(cosθ, sinθ)) to the nearest crossing of
 * any segment in `chains`, or -1 if the ray misses them all.
 */
function rayHit(
  chains: [number, number][][],
  ax: number, az: number,
  dx: number, dz: number,
): number {
  let best = Infinity
  for (const chain of chains) {
    const n = chain.length
    for (let i = 0; i < n - 1; i++) {
      const [x1, z1] = chain[i]
      const [x2, z2] = chain[i + 1]
      const ex = x2 - x1, ez = z2 - z1
      const denom = dx * ez - dz * ex
      if (Math.abs(denom) < 1e-12) continue
      const wx = x1 - ax, wz = z1 - az
      const t = (wx * ez - wz * ex) / denom   // along the ray
      const s = (wx * dz - wz * dx) / denom   // along the segment
      if (t > 1e-6 && s >= 0 && s <= 1 && t < best) best = t
    }
  }
  return Number.isFinite(best) ? best : -1
}

/**
 * Chains that make up one flux-surface contour, closed back on themselves when
 * their ends nearly meet (marching squares leaves a tiny gap at the seam).
 */
function surfaceChains(points: [number, number][]): [number, number][][] {
  const chains = splitChains(points)
  return chains.map((c) => {
    if (c.length < 3) return c
    const [r0, z0] = c[0]
    const [r1, z1] = c[c.length - 1]
    const gap = Math.hypot(r1 - r0, z1 - z0)
    return gap < 0.15 ? [...c, c[0]] : c
  })
}

/**
 * Resample the snapshot's flux surfaces onto the fixed K × M grid.
 * Surfaces for which more than a quarter of rays miss are dropped.
 * Radii are forced to be non-decreasing outward so nested shells never cross.
 */
export function resampleFluxSurfaces(
  surfaces: Contour[],
  axisR: number,
  axisZ: number,
  out?: ResampledSurfaces,
): ResampledSurfaces {
  const result: ResampledSurfaces = out ?? {
    count: 0,
    levels: [],
    rz: new Float32Array(MAX_SURFACES * N_POLOIDAL * 2),
    axisR,
    axisZ,
  }
  result.count = 0
  result.levels.length = 0
  result.axisR = axisR
  result.axisZ = axisZ

  const sorted = [...surfaces]
    .filter((s) => s.points.length >= 4)
    .sort((a, b) => a.level - b.level)
    .slice(-MAX_SURFACES)

  const radii = new Float32Array(N_POLOIDAL)
  const prevRadii = new Float32Array(N_POLOIDAL)
  let havePrev = false

  for (const surf of sorted) {
    const chains = surfaceChains(surf.points)
    let misses = 0
    for (let j = 0; j < N_POLOIDAL; j++) {
      const th = poloidalAngle(j)
      radii[j] = rayHit(chains, axisR, axisZ, Math.cos(th), Math.sin(th))
      if (radii[j] < 0) misses++
    }
    if (misses > N_POLOIDAL / 4) continue
    if (misses > 0 && !fillMisses(radii)) continue

    if (havePrev) {
      for (let j = 0; j < N_POLOIDAL; j++) {
        if (radii[j] < prevRadii[j]) radii[j] = prevRadii[j]
      }
    }
    const k = result.count
    for (let j = 0; j < N_POLOIDAL; j++) {
      const th = poloidalAngle(j)
      const base = (k * N_POLOIDAL + j) * 2
      result.rz[base] = axisR + radii[j] * Math.cos(th)
      result.rz[base + 1] = axisZ + radii[j] * Math.sin(th)
      prevRadii[j] = radii[j]
    }
    havePrev = true
    result.levels.push(surf.level)
    result.count++
    if (result.count >= MAX_SURFACES) break
  }
  return result
}

/** Linear interpolation (periodic) over rays that missed. False if all missed. */
function fillMisses(radii: Float32Array): boolean {
  const n = radii.length
  let anchor = -1
  for (let j = 0; j < n; j++) if (radii[j] >= 0) { anchor = j; break }
  if (anchor < 0) return false
  for (let step = 1; step <= n; step++) {
    const j = (anchor + step) % n
    if (radii[j] >= 0) continue
    // Find the next valid sample after j
    let m = 1
    while (radii[(j + m) % n] < 0) m++
    const prevIdx = (j - 1 + n) % n
    const nextIdx = (j + m) % n
    const r0 = radii[prevIdx], r1 = radii[nextIdx]
    for (let q = 0; q < m; q++) {
      radii[(j + q) % n] = r0 + ((r1 - r0) * (q + 1)) / (m + 1)
    }
  }
  return true
}

/**
 * Map a flux-surface level ψ_N to an index into the engine's 51-point radial
 * profile arrays. The engine parameterises profiles by a normalised radius ρ
 * that it does not tie to ψ explicitly; we use the common convention
 * ρ ≈ √ψ_N. That mapping is a visualisation assumption, stated in the UI.
 */
export function profileAtPsi(profile: number[], psiN: number): number {
  if (!profile || profile.length === 0) return 0
  const rho = Math.sqrt(Math.min(Math.max(psiN, 0), 1))
  const x = rho * (profile.length - 1)
  const i = Math.min(Math.floor(x), profile.length - 2)
  const f = x - i
  return profile[i] * (1 - f) + profile[i + 1] * f
}
