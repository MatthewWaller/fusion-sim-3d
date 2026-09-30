/**
 * The plasma as nested, glowing toroidal shells swept from the engine's flux
 * surfaces, plus the cut-face cross-sections shown in cutaway mode.
 *
 * GPU layout: one float texture holds the resampled (R, Z) of every surface
 * (MAX_SURFACES rows × N_POLOIDAL columns). The shell mesh is a static grid of
 * (surface k, poloidal j, toroidal φ) indices; the vertex shader fetches
 * (R, Z) and revolves it. A snapshot update therefore uploads ~11 KB and
 * touches no geometry, however finely the torus is tessellated.
 *
 * What drives the visuals (all from the engine's snapshot):
 *  - Shape: the engine's flux-surface contours (ψ_N = 0.1…0.9, 0.995).
 *  - Colour: Te or ne from the engine's 51-point radial profiles, mapped to
 *    each surface with ρ ≈ √ψ_N (a visualisation assumption).
 *  - Brightness: ∝ ne²·√Te on each surface, the bremsstrahlung scaling, used
 *    here as a relative emissivity. It is a visual proxy, not a synthetic
 *    camera image; the absolute gain is an arbitrary display constant.
 *  - Edge glow: ∝ the engine's synthetic D-alpha signal (colour: the
 *    656 nm Balmer-alpha red). ELM flashes: timing and size from elm_active /
 *    elm_energy_loss, localised to the outboard side where ELMs originate;
 *    the flash's shape and decay are illustrative.
 *  - Limb brightening: an optically thin shell viewed at angle has line-of-
 *    sight path ∝ 1/cos, which the fragment shader applies (capped).
 */

import * as THREE from 'three'
import type { Snapshot } from '../../lib/types'
import { MAX_SURFACES, N_POLOIDAL, poloidalAngle, profileAtPsi, type ResampledSurfaces } from './fluxGeometry'
import { sampleColormap, type ColorVar } from './colormap'

const N_TOROIDAL = 160

export interface CutState {
  enabled: boolean
  /** Inward-pointing clip-plane normals: a point is cut if n·p < 0 for both. */
  n1: THREE.Vector3
  n2: THREE.Vector3
  /** Toroidal angles of the two cut faces. */
  phiA: number
  phiB: number
}

export interface PlasmaVisualState {
  colorVar: ColorVar
  showNested: boolean
  /** 0…1 ELM flash envelope (animated in the render loop). */
  elm: number
  /** 0…1 overall fade (disruption afterglow / ramp). */
  fade: number
  /** Normalised D-alpha. */
  dAlpha: number
}

export interface ProfileScale {
  teRef: number
  neRef: number
}

const shellVert = /* glsl */ `
  uniform sampler2D u_rz;
  uniform int u_count;
  uniform int u_minK;
  uniform vec3 u_color[${MAX_SURFACES}];
  uniform float u_weight[${MAX_SURFACES}];
  attribute float aJ;
  attribute float aK;
  attribute float aPhi;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vOutboard;
  varying float vEdge;

  vec2 rzAt(int j, int k) {
    j = (j + ${N_POLOIDAL}) - ${N_POLOIDAL} * ((j + ${N_POLOIDAL}) / ${N_POLOIDAL});
    return texelFetch(u_rz, ivec2(j, k), 0).rg;
  }

  void main() {
    int j = int(aJ + 0.5);
    int k = int(aK + 0.5);
    if (k >= u_count || k < u_minK) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // outside clip space: culled
      return;
    }
    vec2 rz = rzAt(j, k);
    float s = sin(aPhi), c = cos(aPhi);
    vec3 pos = vec3(rz.x * s, rz.y, rz.x * c);
    vec2 d = rzAt(j + 1, k) - rzAt(j - 1, k);
    vec3 tPol = vec3(d.x * s, d.y, d.x * c);
    vec3 tTor = vec3(c, 0.0, -s);
    vec3 n = normalize(cross(tPol, tTor));
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * n);
    vColor = u_color[k] * u_weight[k];
    vOutboard = cos(6.28318530718 * float(j) / ${N_POLOIDAL}.0);
    vEdge = (k == u_count - 1) ? 1.0 : 0.0;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const shellFrag = /* glsl */ `
  uniform float u_cut;
  uniform vec3 u_n1;
  uniform vec3 u_n2;
  uniform float u_elm;
  uniform float u_dalpha;
  uniform float u_fade;
  uniform float u_near;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vOutboard;
  varying float vEdge;

  void main() {
    // Near-camera fade: shells right next to the lens (in-vessel views)
    // would otherwise fill the frame with saturated glow. Rendering aid only.
    float near = smoothstep(0.08 * u_near, u_near, length(cameraPosition - vWorld));
    if (u_cut > 0.5 && dot(vWorld, u_n1) < 0.0 && dot(vWorld, u_n2) < 0.0) discard;
    vec3 V = normalize(cameraPosition - vWorld);
    float mu = abs(dot(normalize(vNormal), V));
    // Optically thin shell: path length through it ∝ 1/mu (capped at grazing).
    float path = min(1.0 / max(mu, 0.12), 4.0) / 4.0;
    vec3 col = vColor * (0.25 + 1.6 * path);
    // Edge (near-LCFS) shell: D-alpha glow and ELM flash, outboard-weighted.
    float outb = smoothstep(-0.3, 0.9, vOutboard);
    col += vEdge * vec3(1.0, 0.18, 0.28) * u_dalpha * path * 1.2;
    col += vEdge * vec3(1.0, 0.85, 0.95) * u_elm * outb * (0.15 + 1.2 * path);
    gl_FragColor = vec4(col * u_fade * near, 1.0);
  }
`

export interface PlasmaVolume {
  group: THREE.Group
  update: (
    surf: ResampledSurfaces,
    snap: Snapshot,
    scale: ProfileScale,
    vis: PlasmaVisualState,
    cut: CutState,
  ) => void
  /** Per-frame uniforms only (ELM envelope, fade, cut). */
  animate: (vis: PlasmaVisualState, cut: CutState) => void
  setVisible: (v: boolean) => void
  /** Distance (m) over which shells fade out as the camera approaches. */
  setNearFade: (d: number) => void
  dispose: () => void
}

function buildShellGeometry(): THREE.BufferGeometry {
  const nJ = N_POLOIDAL + 1
  const nP = N_TOROIDAL + 1
  const nV = MAX_SURFACES * nJ * nP
  const aJ = new Float32Array(nV)
  const aK = new Float32Array(nV)
  const aPhi = new Float32Array(nV)
  let v = 0
  for (let k = 0; k < MAX_SURFACES; k++) {
    for (let p = 0; p < nP; p++) {
      const phi = (2 * Math.PI * p) / N_TOROIDAL
      for (let j = 0; j < nJ; j++) {
        aJ[v] = j % N_POLOIDAL; aK[v] = k; aPhi[v] = phi; v++
      }
    }
  }
  const idx = new Uint32Array(MAX_SURFACES * N_POLOIDAL * N_TOROIDAL * 6)
  let i = 0
  for (let k = 0; k < MAX_SURFACES; k++) {
    const base = k * nJ * nP
    for (let p = 0; p < N_TOROIDAL; p++) {
      for (let j = 0; j < N_POLOIDAL; j++) {
        const a = base + p * nJ + j
        const b = a + 1
        const c = a + nJ
        const d = c + 1
        idx[i++] = a; idx[i++] = c; idx[i++] = b
        idx[i++] = b; idx[i++] = c; idx[i++] = d
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  // A dummy position attribute: three.js needs one for draw-range bookkeeping.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nV * 3), 3))
  geo.setAttribute('aJ', new THREE.BufferAttribute(aJ, 1))
  geo.setAttribute('aK', new THREE.BufferAttribute(aK, 1))
  geo.setAttribute('aPhi', new THREE.BufferAttribute(aPhi, 1))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  // Positions come from the texture, so the bounding sphere must be set by
  // hand (large) or the mesh would be frustum-culled.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  return geo
}

/**
 * One cut-face cross-section: ring strips from the magnetic axis out through
 * each flux surface, vertex-coloured by the profile value on that surface.
 */
class CapMesh {
  mesh: THREE.Mesh
  lines: THREE.LineSegments
  private pos: Float32Array
  private col: Float32Array
  private linePos: Float32Array
  private geo: THREE.BufferGeometry
  private lineGeo: THREE.BufferGeometry

  constructor(material: THREE.Material, lineMaterial: THREE.Material) {
    const rows = MAX_SURFACES + 1               // axis + surfaces
    const nJ = N_POLOIDAL + 1
    this.pos = new Float32Array(rows * nJ * 3)
    this.col = new Float32Array(rows * nJ * 3)
    const idx: number[] = []
    for (let k = 0; k < MAX_SURFACES; k++) {
      for (let j = 0; j < N_POLOIDAL; j++) {
        const a = k * nJ + j, b = a + 1, c = a + nJ, d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.geo.setIndex(idx)
    this.mesh = new THREE.Mesh(this.geo, material)
    this.mesh.frustumCulled = false

    this.linePos = new Float32Array(MAX_SURFACES * N_POLOIDAL * 2 * 3)
    this.lineGeo = new THREE.BufferGeometry()
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3))
    this.lines = new THREE.LineSegments(this.lineGeo, lineMaterial)
    this.lines.frustumCulled = false
  }

  update(
    surf: ResampledSurfaces, phi: number, rowColors: Float32Array, rowWeights: Float32Array,
    showLines: boolean, fade: number,
  ) {
    const nJ = N_POLOIDAL + 1
    const s = Math.sin(phi), c = Math.cos(phi)
    // Nudge the face a hair into the kept side so it never z-fights the cut.
    const rows = surf.count + 1
    for (let k = 0; k < rows; k++) {
      for (let jj = 0; jj < nJ; jj++) {
        const j = jj % N_POLOIDAL
        let R: number, Z: number
        if (k === 0) { R = surf.axisR; Z = surf.axisZ } else {
          const b = ((k - 1) * N_POLOIDAL + j) * 2
          R = surf.rz[b]; Z = surf.rz[b + 1]
        }
        const o = (k * nJ + jj) * 3
        this.pos[o] = R * s; this.pos[o + 1] = Z; this.pos[o + 2] = R * c
        const w = rowWeights[k] * fade
        this.col[o] = rowColors[k * 3] * w
        this.col[o + 1] = rowColors[k * 3 + 1] * w
        this.col[o + 2] = rowColors[k * 3 + 2] * w
      }
    }
    this.geo.setDrawRange(0, Math.max(0, (rows - 1)) * N_POLOIDAL * 6)
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.color.needsUpdate = true

    let li = 0
    const firstLine = showLines ? 0 : surf.count - 1
    for (let k = Math.max(firstLine, 0); k < surf.count; k++) {
      for (let j = 0; j < N_POLOIDAL; j++) {
        const b0 = (k * N_POLOIDAL + j) * 2
        const b1 = (k * N_POLOIDAL + ((j + 1) % N_POLOIDAL)) * 2
        const off = 0.002
        this.linePos[li++] = surf.rz[b0] * s + c * off; this.linePos[li++] = surf.rz[b0 + 1]; this.linePos[li++] = surf.rz[b0] * c - s * off
        this.linePos[li++] = surf.rz[b1] * s + c * off; this.linePos[li++] = surf.rz[b1 + 1]; this.linePos[li++] = surf.rz[b1] * c - s * off
      }
    }
    this.lineGeo.setDrawRange(0, li / 3)
    this.lineGeo.attributes.position.needsUpdate = true
  }

  dispose() { this.geo.dispose(); this.lineGeo.dispose() }
}

export function createPlasmaVolume(): PlasmaVolume {
  const group = new THREE.Group()

  const rzData = new Float32Array(N_POLOIDAL * MAX_SURFACES * 2)
  const rzTex = new THREE.DataTexture(rzData, N_POLOIDAL, MAX_SURFACES, THREE.RGFormat, THREE.FloatType)
  rzTex.minFilter = THREE.NearestFilter
  rzTex.magFilter = THREE.NearestFilter
  rzTex.needsUpdate = true

  const colors = Array.from({ length: MAX_SURFACES }, () => new THREE.Vector3())
  const weights = new Array<number>(MAX_SURFACES).fill(0)

  const shellMat = new THREE.ShaderMaterial({
    vertexShader: shellVert,
    fragmentShader: shellFrag,
    uniforms: {
      u_rz: { value: rzTex },
      u_count: { value: 0 },
      u_minK: { value: 0 },
      u_color: { value: colors },
      u_weight: { value: weights },
      u_cut: { value: 0 },
      u_n1: { value: new THREE.Vector3() },
      u_n2: { value: new THREE.Vector3() },
      u_elm: { value: 0 },
      u_dalpha: { value: 0 },
      u_fade: { value: 1 },
      u_near: { value: 0.5 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
  const shellGeo = buildShellGeometry()
  const shells = new THREE.Mesh(shellGeo, shellMat)
  shells.frustumCulled = false
  shells.renderOrder = 2
  group.add(shells)

  // Cut faces
  const capMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: true })
  const lineMat = new THREE.LineBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.35 })
  const capA = new CapMesh(capMat, lineMat)
  const capB = new CapMesh(capMat, lineMat)
  const caps = new THREE.Group()
  caps.add(capA.mesh, capA.lines, capB.mesh, capB.lines)
  group.add(caps)

  const rowColors = new Float32Array((MAX_SURFACES + 1) * 3)
  const rowWeights = new Float32Array(MAX_SURFACES + 1)
  const rgb: [number, number, number] = [0, 0, 0]

  const applyCut = (cut: CutState) => {
    const u = shellMat.uniforms
    u.u_cut.value = cut.enabled ? 1 : 0
    u.u_n1.value.copy(cut.n1)
    u.u_n2.value.copy(cut.n2)
    caps.visible = cut.enabled
  }

  const update: PlasmaVolume['update'] = (surf, snap, scale, vis, cut) => {
    const u = shellMat.uniforms
    for (let k = 0; k < surf.count; k++) {
      const b = k * N_POLOIDAL * 2
      rzData.set(surf.rz.subarray(b, b + N_POLOIDAL * 2), b)
    }
    rzTex.needsUpdate = true
    u.u_count.value = surf.count
    u.u_minK.value = vis.showNested ? 0 : Math.max(surf.count - 1, 0)

    // Per-surface colour and emissivity. Row 0 of the cap is the axis (ψ=0).
    const n = surf.count
    for (let row = 0; row <= n; row++) {
      const psi = row === 0 ? 0 : surf.levels[row - 1]
      const te = Math.max(profileAtPsi(snap.te_profile, psi), 0)
      const ne = Math.max(profileAtPsi(snap.ne_profile, psi), 0)
      const teN = te / scale.teRef
      const neN = ne / scale.neRef
      sampleColormap(vis.colorVar, vis.colorVar === 'te' ? teN : neN, rgb)
      // Colour-map stops are sRGB; the renderer works in linear light.
      rgb[0] = rgb[0] ** 2.2; rgb[1] = rgb[1] ** 2.2; rgb[2] = rgb[2] ** 2.2
      rowColors[row * 3] = rgb[0]; rowColors[row * 3 + 1] = rgb[1]; rowColors[row * 3 + 2] = rgb[2]
      // Bremsstrahlung-like relative emissivity ε ∝ ne² √Te (normalised)
      const eps = neN * neN * Math.sqrt(Math.max(teN, 0))
      rowWeights[row] = 0.35 + 0.65 * Math.min(eps, 1.5)  // caps: keep slices legible
      if (row > 0) {
        colors[row - 1].set(rgb[0], rgb[1], rgb[2])
        // Shells are summed additively; divide by the count so the total
        // brightness does not depend on how many surfaces the engine emitted.
        const shellCount = vis.showNested ? n : 1
        weights[row - 1] = (1.1 * Math.min(eps, 1.5)) / Math.sqrt(shellCount)
      }
    }
    // The outermost (near-LCFS) shell always carries at least a faint skin so
    // the boundary shape stays visible even in a cold, dim plasma.
    if (n > 0) weights[n - 1] = Math.max(weights[n - 1], 0.12)

    const phiA = cut.phiA, phiB = cut.phiB
    capA.update(surf, phiA, rowColors, rowWeights, vis.showNested, vis.fade)
    capB.update(surf, phiB, rowColors, rowWeights, vis.showNested, vis.fade)
    animate(vis, cut)
  }

  const animate: PlasmaVolume['animate'] = (vis, cut) => {
    const u = shellMat.uniforms
    u.u_elm.value = vis.elm
    u.u_dalpha.value = vis.dAlpha
    u.u_fade.value = vis.fade
    applyCut(cut)
  }

  return {
    group,
    update,
    animate,
    setVisible: (v: boolean) => { group.visible = v },
    setNearFade: (d: number) => { shellMat.uniforms.u_near.value = d },
    dispose: () => {
      shellGeo.dispose(); shellMat.dispose(); rzTex.dispose()
      capA.dispose(); capB.dispose(); capMat.dispose(); lineMat.dispose()
    },
  }
}

/** Poloidal angle helper re-exported for the field-line tracer. */
export { poloidalAngle }
