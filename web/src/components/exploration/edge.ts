/**
 * Edge and divertor features for the Exploration Room:
 *  - X-point rings at the engine's X-point location(s).
 *  - Strike-point rings where the separatrix legs meet the wall (geometry
 *    from the engine's separatrix via the port view's strike-point finder),
 *    with brightness from the display-side divertor heat-flux model
 *    (computeDivertorHeatFlux: Eich λq scaling, detachment, ELM transients).
 *    Brightness is log-scaled q_peak; the colour ramp is illustrative.
 *  - An optional magnetic field line on the near-LCFS surface whose pitch is
 *    the engine's q95. Approximation: it advances φ = q95·θ in the geometric
 *    poloidal angle rather than the straight-field-line angle, so it shows
 *    the right number of toroidal transits per poloidal turn, not the exact
 *    local pitch. Field direction (handedness) is arbitrary.
 */

import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { N_POLOIDAL, type ResampledSurfaces } from './fluxGeometry'

const MAX_STRIKES = 4
const FIELD_LINE_PTS = 1200
/** Field lines drawn, evenly spaced in starting toroidal angle. */
const FIELD_LINES = 3

export interface EdgeFeatures {
  group: THREE.Group
  clippedMaterials: THREE.Material[]
  setXPoints: (pts: { r: number; z: number }[]) => void
  setStrikes: (pts: { r: number; z: number }[], intensity: number) => void
  setFieldLine: (surf: ResampledSurfaces | null, q95: number, visible: boolean) => void
  /** Fat-line materials need the viewport size in pixels. */
  setResolution: (w: number, h: number) => void
  dispose: () => void
}

export function createEdgeFeatures(size: number, clippingPlanes: THREE.Plane[]): EdgeFeatures {
  const group = new THREE.Group()
  const disposables: { dispose: () => void }[] = []

  // ── X-point rings (unit circle in the XZ plane, scaled to R) ──
  const circlePts: THREE.Vector3[] = []
  for (let i = 0; i < 256; i++) {
    const a = (2 * Math.PI * i) / 256
    circlePts.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)))
  }
  const circleGeo = new THREE.BufferGeometry().setFromPoints(circlePts)
  const xpMat = new THREE.LineBasicMaterial({
    color: 0xd070ff, transparent: true, opacity: 0.7,
    clippingPlanes, clipIntersection: true,
  })
  const xpRings = [0, 1].map(() => {
    const l = new THREE.LineLoop(circleGeo, xpMat)
    l.visible = false
    group.add(l)
    return l
  })
  disposables.push(circleGeo, xpMat)

  // ── Strike-point rings ──
  const tube = 0.012 * size
  const strikeMat = new THREE.MeshBasicMaterial({
    color: 0xffa040, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
    clippingPlanes, clipIntersection: true,
  })
  disposables.push(strikeMat)
  const strikes = Array.from({ length: MAX_STRIKES }, () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), strikeMat)
    mesh.visible = false
    mesh.userData.r = -1
    group.add(mesh)
    return mesh
  })
  const hot = new THREE.Color()
  const cool = new THREE.Color(0xff5a1a)
  const white = new THREE.Color(0xfff2d8)

  // ── Field lines on the LCFS (screen-space fat lines) ──
  const flPos = new Float32Array(FIELD_LINE_PTS * 3)
  const flMat = new LineMaterial({
    color: 0xb8f0ff, linewidth: 2, transparent: true, opacity: 0.95,
    clippingPlanes, clipIntersection: true,
  })
  const fieldGroup = new THREE.Group()
  fieldGroup.visible = false
  const fieldLines = Array.from({ length: FIELD_LINES }, () => {
    const line = new Line2(new LineGeometry(), flMat)
    line.frustumCulled = false
    fieldGroup.add(line)
    return line
  })
  group.add(fieldGroup)
  disposables.push(flMat)
  // Only rebuild the (allocation-heavy) fat-line buffers when q95 or the
  // boundary actually moves.
  let lastKey = ''

  return {
    group,
    clippedMaterials: [xpMat, strikeMat, flMat],

    setXPoints(pts) {
      xpRings.forEach((ring, i) => {
        const p = pts[i]
        ring.visible = !!p && p.r > 0
        if (p && p.r > 0) {
          ring.scale.set(p.r, 1, p.r)
          ring.position.set(0, p.z, 0)
        }
      })
    },

    setStrikes(pts, intensity) {
      const I = Math.min(Math.max(intensity, 0), 1)
      hot.copy(cool).lerp(white, I)
      strikeMat.color.copy(hot).multiplyScalar(0.2 + 2.2 * I)
      strikes.forEach((mesh, i) => {
        const p = pts[i]
        mesh.visible = !!p && I > 0.01
        if (!p) return
        if (Math.abs(mesh.userData.r - p.r) > 0.005) {
          mesh.geometry.dispose()
          const g = new THREE.TorusGeometry(p.r, tube, 8, 192)
          g.rotateX(Math.PI / 2)
          mesh.geometry = g
          mesh.userData.r = p.r
        }
        mesh.position.set(0, p.z, 0)
      })
    },

    setFieldLine(surf, q95, visible) {
      fieldGroup.visible = visible && !!surf && surf.count > 0 && q95 > 0.5
      if (!fieldGroup.visible || !surf) return
      const k = surf.count - 1
      const q = Math.min(q95, 12)
      const b = k * N_POLOIDAL * 2
      const key = [(Math.round(q * 20) / 20).toFixed(2), surf.rz[b].toFixed(3), surf.rz[b + N_POLOIDAL / 2].toFixed(3),
        surf.rz[b + N_POLOIDAL + 1].toFixed(3), surf.axisZ.toFixed(3)].join('|')
      if (key === lastKey) return
      lastKey = key
      fieldLines.forEach((line, n) => {
      const phi0 = (2 * Math.PI * n) / FIELD_LINES
      for (let i = 0; i < FIELD_LINE_PTS; i++) {
        const u = i / (FIELD_LINE_PTS - 1)                 // one poloidal turn
        const x = u * N_POLOIDAL
        const j0 = Math.floor(x) % N_POLOIDAL
        const j1 = (j0 + 1) % N_POLOIDAL
        const f = x - Math.floor(x)
        const b0 = (k * N_POLOIDAL + j0) * 2, b1 = (k * N_POLOIDAL + j1) * 2
        // Lift slightly off the surface so it reads over the shell glow
        const R0 = surf.axisR + (surf.rz[b0] - surf.axisR) * 1.012
        const R1 = surf.axisR + (surf.rz[b1] - surf.axisR) * 1.012
        const Z0 = surf.axisZ + (surf.rz[b0 + 1] - surf.axisZ) * 1.012
        const Z1 = surf.axisZ + (surf.rz[b1 + 1] - surf.axisZ) * 1.012
        const R = R0 + (R1 - R0) * f
        const Z = Z0 + (Z1 - Z0) * f
        const phi = phi0 + q * 2 * Math.PI * u
        flPos[i * 3] = R * Math.sin(phi)
        flPos[i * 3 + 1] = Z
        flPos[i * 3 + 2] = R * Math.cos(phi)
      }
      // setPositions allocates new buffers; swap in a fresh geometry and
      // dispose the old one so its GPU buffers are released.
      const old = line.geometry
      const geo = new LineGeometry()
      geo.setPositions(flPos)
      line.geometry = geo
      old.dispose()
      })
    },

    setResolution(w, h) {
      flMat.resolution.set(w, h)
    },

    dispose() {
      strikes.forEach((m) => m.geometry.dispose())
      fieldLines.forEach((l) => l.geometry.dispose())
      disposables.forEach((d) => d.dispose())
    },
  }
}
