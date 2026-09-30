/**
 * Static tokamak hardware for the Exploration Room: vacuum vessel, TF coils,
 * central solenoid, PF coils, and the divertor region.
 *
 * What is real and what is schematic:
 *  - The VESSEL / first wall is the device's own wall or limiter contour from
 *    the engine (or the CAD-derived limiter tables the control room already
 *    uses), revolved 360°. Its proportions are the device's.
 *  - The DIVERTOR shading marks the part of that wall below (and, for double
 *    null, above) the X-point region. It is a visual classification by
 *    height, not a separate engineering model.
 *  - TF coils, the central solenoid and PF coils are SCHEMATIC. The engine
 *    does not model coil geometry; their sizes are derived from the wall
 *    extent so they sit plausibly around the vessel. TF coil counts are the
 *    real machines' (DIII-D 24, JET 32, ITER 18); CENTAUR is a design concept
 *    and its count here is illustrative.
 *
 * Coordinates: metres, three.js Y-up. A point (R, Z) at toroidal angle φ maps
 * to (R·sinφ, Z, R·cosφ), the convention of THREE.LatheGeometry.
 */

import * as THREE from 'three'

export const TF_COIL_COUNT: Record<string, number> = {
  diiid: 24,
  jet: 32,
  iter: 18,
  centaur: 18,
}

export interface WallExtent {
  rMin: number
  rMax: number
  zMin: number
  zMax: number
  /** Characteristic size, used to scale clearances and camera distances. */
  size: number
}

export function wallExtent(wall: [number, number][]): WallExtent {
  let rMin = Infinity, rMax = -Infinity, zMin = Infinity, zMax = -Infinity
  for (const [r, z] of wall) {
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r)
    zMin = Math.min(zMin, z); zMax = Math.max(zMax, z)
  }
  return { rMin, rMax, zMin, zMax, size: Math.max(rMax - rMin, zMax - zMin) }
}

export interface MachineOptions {
  deviceId: string
  wall: [number, number][]
  doubleNull: boolean
  clippingPlanes: THREE.Plane[]
}

export interface Machine {
  group: THREE.Group
  vessel: THREE.Mesh
  coils: THREE.Group
  extent: WallExtent
  /** Materials that honour the cutaway planes. */
  clippedMaterials: THREE.Material[]
  dispose: () => void
}

const VESSEL_SEGMENTS = 128

/** Exponent of the superellipse used for the coil's outboard arc (2 = ellipse). */
const D_EXP = 3

/**
 * D-shaped coil outline: straight inboard leg + a half-superellipse outboard,
 * |x|^p + |z/H|^p = 1. Boxier than an ellipse so it hugs the vessel corners.
 */
function dShape(rLeg: number, width: number, halfHeight: number, zc: number, n = 64): THREE.Vector2[] {
  const pts: THREE.Vector2[] = []
  const e = 2 / D_EXP
  for (let i = 0; i <= n; i++) {
    const th = -Math.PI / 2 + (Math.PI * i) / n
    const c = Math.cos(th), s = Math.sin(th)
    pts.push(new THREE.Vector2(
      rLeg + width * Math.sign(c) * Math.abs(c) ** e,
      zc + halfHeight * Math.sign(s) * Math.abs(s) ** e,
    ))
  }
  return pts // the closing straight leg is implied by the Shape
}

export function buildMachine(opts: MachineOptions): Machine {
  const { wall, deviceId, doubleNull, clippingPlanes } = opts
  const ext = wallExtent(wall)
  const group = new THREE.Group()
  const coils = new THREE.Group()
  group.add(coils)
  const clippedMaterials: THREE.Material[] = []
  const disposables: { dispose: () => void }[] = []

  // ── Vacuum vessel / first wall ────────────────────────────────────────
  // Lathe the wall contour. LatheGeometry wants points in order; the contour
  // is a closed polygon, so repeat the first point to close the seam.
  const profile = wall.map(([r, z]) => new THREE.Vector2(r, z))
  if (profile.length > 1 && profile[0].distanceTo(profile[profile.length - 1]) > 1e-6) {
    profile.push(profile[0].clone())
  }
  const vesselGeo = new THREE.LatheGeometry(profile, VESSEL_SEGMENTS)
  // Divertor shading: height-based classification of the same wall.
  const span = ext.zMax - ext.zMin
  const divLow = ext.zMin + 0.2 * span
  const divHigh = ext.zMax - 0.2 * span
  const base = new THREE.Color(0x8d9299)
  const div = new THREE.Color(0x3a3530)
  const colors = new Float32Array(vesselGeo.attributes.position.count * 3)
  const nP = profile.length
  for (let i = 0; i <= VESSEL_SEGMENTS; i++) {
    for (let j = 0; j < nP; j++) {
      const z = profile[j].y
      const inDiv = z < divLow || (doubleNull && z > divHigh)
      const c = inDiv ? div : base
      const idx = (i * nP + j) * 3
      colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b
    }
  }
  vesselGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const vesselMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.55,
    roughness: 0.55,
    side: THREE.DoubleSide,
    clippingPlanes,
    clipIntersection: true,
    // Faint self-illumination so the vessel reads even with the plasma off
    emissive: new THREE.Color(0x0b0c0e),
  })
  const vessel = new THREE.Mesh(vesselGeo, vesselMat)
  group.add(vessel)
  clippedMaterials.push(vesselMat)
  disposables.push(vesselGeo, vesselMat)

  // ── Schematic TF coils ────────────────────────────────────────────────
  const s = ext.size
  const gap = 0.06 * s
  const w = 0.07 * s                        // radial build of a coil
  const zc = (ext.zMax + ext.zMin) / 2
  const rLeg = ext.rMin - gap - w / 2       // inboard leg centre line
  const width = ext.rMax + gap + w / 2 - rLeg + 0.08 * s
  // Half-height large enough that the arc clears every wall point.
  let halfH = (ext.zMax - ext.zMin) / 2 + gap
  for (const [r, z] of wall) {
    const x = Math.min((r - rLeg) / width, 0.95)
    if (x <= 0) continue
    halfH = Math.max(halfH, (Math.abs(z - zc) + gap + w / 2) / (1 - x ** D_EXP) ** (1 / D_EXP))
  }
  const outer = dShape(rLeg - w / 2, width + w, halfH + w / 2, zc)
  const inner = dShape(rLeg + w / 2, width - w, halfH - w / 2, zc)
  const coilShape = new THREE.Shape(outer)
  coilShape.holes.push(new THREE.Path(inner))
  const depth = Math.min(0.9 * (2 * Math.PI * (rLeg - w / 2)) / (TF_COIL_COUNT[deviceId] ?? 18), 0.12 * s)
  const tfGeo = new THREE.ExtrudeGeometry(coilShape, { depth, bevelEnabled: false, curveSegments: 4 })
  tfGeo.translate(0, 0, -depth / 2)
  const tfMat = new THREE.MeshStandardMaterial({
    color: 0x9a6a3a, metalness: 0.7, roughness: 0.4,
    clippingPlanes, clipIntersection: true,
  })
  const nTf = TF_COIL_COUNT[deviceId] ?? 18
  const tf = new THREE.InstancedMesh(tfGeo, tfMat, nTf)
  const m = new THREE.Matrix4()
  // Shape lies in the XY plane (x = R, y = Z). Rotating about Y by φ puts it
  // at toroidal angle φ in the lathe convention (R·sinφ, Z, R·cosφ).
  for (let i = 0; i < nTf; i++) {
    const phi = (2 * Math.PI * (i + 0.5)) / nTf
    m.makeRotationY(phi - Math.PI / 2)
    tf.setMatrixAt(i, m)
  }
  tf.instanceMatrix.needsUpdate = true
  coils.add(tf)
  clippedMaterials.push(tfMat)
  disposables.push(tfGeo, tfMat)

  // ── Schematic central solenoid (stacked modules) ──────────────────────
  const csOuter = rLeg - w / 2 - 0.02 * s
  const csInner = Math.max(csOuter * 0.55, 0.02)
  const csHalf = halfH * 0.85
  const nMod = 6
  const modGap = 0.01 * s
  const csMat = new THREE.MeshStandardMaterial({
    color: 0x6f7c8c, metalness: 0.6, roughness: 0.45,
    clippingPlanes, clipIntersection: true,
  })
  clippedMaterials.push(csMat)
  disposables.push(csMat)
  if (csOuter > csInner) {
    const modH = (2 * csHalf - (nMod - 1) * modGap) / nMod
    for (let i = 0; i < nMod; i++) {
      const z0 = zc - csHalf + i * (modH + modGap)
      const geo = new THREE.LatheGeometry([
        new THREE.Vector2(csInner, z0), new THREE.Vector2(csOuter, z0),
        new THREE.Vector2(csOuter, z0 + modH), new THREE.Vector2(csInner, z0 + modH),
        new THREE.Vector2(csInner, z0),
      ], 64)
      coils.add(new THREE.Mesh(geo, csMat))
      disposables.push(geo)
    }
  }

  // ── Schematic PF coils (up-down pairs just outside the TF envelope) ──
  const pfMat = new THREE.MeshStandardMaterial({
    color: 0x7a8a6a, metalness: 0.6, roughness: 0.5,
    clippingPlanes, clipIntersection: true,
  })
  clippedMaterials.push(pfMat)
  disposables.push(pfMat)
  const tfOuterW = width + w
  const tfOuterH = halfH + w / 2
  const pfSize = 0.05 * s
  const pfClear = 0.05 * s
  const pfPositions: [number, number][] = []
  for (const f of [0.3, 0.72]) {
    const r = rLeg - w / 2 + f * tfOuterW
    const zEdge = tfOuterH * (1 - f ** D_EXP) ** (1 / D_EXP)
    pfPositions.push([r, zc + zEdge + pfClear + pfSize], [r, zc - zEdge - pfClear - pfSize])
  }
  const rOut = rLeg - w / 2 + tfOuterW + pfClear + pfSize
  pfPositions.push([rOut, zc + 0.4 * tfOuterH], [rOut, zc - 0.4 * tfOuterH])
  for (const [r, z] of pfPositions) {
    const h = pfSize
    const geo = new THREE.LatheGeometry([
      new THREE.Vector2(r - h, z - h), new THREE.Vector2(r + h, z - h),
      new THREE.Vector2(r + h, z + h), new THREE.Vector2(r - h, z + h),
      new THREE.Vector2(r - h, z - h),
    ], 96)
    coils.add(new THREE.Mesh(geo, pfMat))
    disposables.push(geo)
  }

  return {
    group, vessel, coils, extent: ext, clippedMaterials,
    dispose: () => disposables.forEach((d) => d.dispose()),
  }
}
