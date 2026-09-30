/**
 * Imperative three.js scene for the Exploration Room. The React component
 * owns one ExplorationScene per mount and feeds it snapshots; everything
 * GPU-side lives here so React re-renders never touch WebGL objects.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Snapshot } from '../../lib/types'
import type { Device } from '../../lib/wasm'
import { computeDivertorHeatFlux } from '../../lib/fusionPhysics'
import { createPostProcessing, type PostProcessingPipeline } from '../portview/postprocessing'
import { findStrikePoints } from '../portview/glow'
import { resampleFluxSurfaces, type ResampledSurfaces } from './fluxGeometry'
import { buildMachine, type Machine } from './machine'
import { createPlasmaVolume, type CutState, type PlasmaVisualState, type PlasmaVolume, type ProfileScale } from './plasmaVolume'
import { createEdgeFeatures, type EdgeFeatures } from './edge'
import type { ColorVar } from './colormap'

export type CameraPreset = 'overview' | 'tangential' | 'top' | 'section'

export interface ViewOptions {
  /** Remove a wedge of the hardware (vessel, coils) to see inside. */
  cutaway: boolean
  /** Also slice the plasma along the cut and show the poloidal cross-sections. */
  slice: boolean
  nested: boolean
  coils: boolean
  fieldLine: boolean
  colorVar: ColorVar
}

/** Toroidal angle the cutaway wedge is centred on, and its half-width. */
const CUT_CENTER = 0
const CUT_HALF = (50 * Math.PI) / 180
/** ELM flash decay constant (s, wall clock). Illustrative. */
const ELM_DECAY = 0.18
/** Disruption afterglow fade (s, wall clock). Decorative. */
const QUENCH_FADE = 0.9

function dirAt(phi: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi))
}

/** Clip-plane normals such that n·p < 0 for both ⇔ p inside the cut wedge. */
function cutNormals(center: number, half: number): [THREE.Vector3, THREE.Vector3] {
  const c = dirAt(center)
  const inward = (b: THREE.Vector3) => {
    const m = new THREE.Vector3(b.z, 0, -b.x)
    if (m.dot(c) < 0) m.negate()
    return m.negate()
  }
  return [inward(dirAt(center + half)), inward(dirAt(center - half))]
}

export class ExplorationScene {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private post: PostProcessingPipeline
  private clock = new THREE.Clock()
  private raf = 0
  private running = false
  private keys = new Set<string>()

  private machine: Machine | null = null
  private edge: EdgeFeatures | null = null
  private plasma: PlasmaVolume
  private plasmaLights: THREE.PointLight[] = []
  private wall: [number, number][] = []
  private deviceKey = ''
  private device: Device | null = null

  private clipPlanes: THREE.Plane[]
  private cut: CutState
  private opts: ViewOptions = { cutaway: true, slice: false, nested: true, coils: true, fieldLine: false, colorVar: 'te' }

  private surf: ResampledSurfaces | null = null
  private lastSnap: Snapshot | null = null
  private scale: ProfileScale = { teRef: 1, neRef: 0.5 }
  private vis: PlasmaVisualState = { colorVar: 'te', showNested: true, elm: 0, fade: 1, dAlpha: 0 }
  private lastTime = -1
  private quenching = false
  private quenchT = 0
  private brightness = 0
  private dAlphaRef = 0.5

  /** Called when the colour-scale reference changes (for the legend). */
  onScale: ((s: ProfileScale) => void) | null = null

  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.setClearColor(0x050608, 1)
    renderer.localClippingEnabled = true
    const rect = container.getBoundingClientRect()
    renderer.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1))
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    this.camera = new THREE.PerspectiveCamera(45, Math.max(rect.width, 1) / Math.max(rect.height, 1), 0.01, 500)
    this.controls = new OrbitControls(this.camera, renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08

    // Lighting: dim fill so hardware reads, plus plasma-coloured point lights
    // around the magnetic axis (decorative: approximate plasma illumination).
    this.scene.add(new THREE.HemisphereLight(0x8090a8, 0x201810, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(4, 8, 6)
    this.scene.add(key)
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xff66aa, 0, 0, 2)
      this.plasmaLights.push(l)
      this.scene.add(l)
    }

    const [n1, n2] = cutNormals(CUT_CENTER, CUT_HALF)
    this.clipPlanes = [new THREE.Plane(n1.clone(), 0), new THREE.Plane(n2.clone(), 0)]
    this.cut = { enabled: true, n1, n2, phiA: CUT_CENTER + CUT_HALF, phiB: CUT_CENTER - CUT_HALF }

    this.plasma = createPlasmaVolume()
    this.plasma.setVisible(false)
    this.scene.add(this.plasma.group)

    this.post = createPostProcessing(renderer, this.scene, this.camera)
    this.post.bloomPass.strength = 0.6
    this.post.bloomPass.radius = 0.5
    this.post.bloomPass.threshold = 0.7

    renderer.domElement.tabIndex = 0
    renderer.domElement.style.outline = 'none'
    renderer.domElement.addEventListener('keydown', this.onKeyDown)
    renderer.domElement.addEventListener('keyup', this.onKeyUp)
    renderer.domElement.addEventListener('blur', this.onBlur)
  }

  // ── lifecycle ───────────────────────────────────────────────────────
  start() {
    if (this.running) return
    this.running = true
    this.clock.getDelta()
    this.loop()
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  resize() {
    const r = this.container.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const pr = Math.min(window.devicePixelRatio, 2)
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(r.width, r.height)
    this.camera.aspect = r.width / r.height
    this.camera.updateProjectionMatrix()
    this.post.resize(r.width, r.height, pr)
    this.edge?.setResolution(r.width, r.height)
  }

  dispose() {
    this.stop()
    const el = this.renderer.domElement
    el.removeEventListener('keydown', this.onKeyDown)
    el.removeEventListener('keyup', this.onKeyUp)
    el.removeEventListener('blur', this.onBlur)
    this.controls.dispose()
    this.machine?.dispose()
    this.edge?.dispose()
    this.plasma.dispose()
    this.post.composer.dispose()
    this.renderer.dispose()
    if (el.parentElement === this.container) this.container.removeChild(el)
  }

  // ── device / hardware ───────────────────────────────────────────────
  setDevice(device: Device, wall: [number, number][]) {
    const key = `${device.id}:${wall.length}`
    this.device = device
    if (key === this.deviceKey) return
    this.deviceKey = key
    this.wall = wall
    if (this.machine) { this.scene.remove(this.machine.group); this.machine.dispose() }
    if (this.edge) { this.scene.remove(this.edge.group); this.edge.dispose() }
    this.machine = buildMachine({
      deviceId: device.id,
      wall,
      doubleNull: device.config === 'DoubleNull',
      clippingPlanes: this.clipPlanes,
    })
    this.scene.add(this.machine.group)
    this.edge = createEdgeFeatures(this.machine.extent.size, this.clipPlanes)
    this.scene.add(this.edge.group)
    this.plasma.setNearFade(0.3 * this.machine.extent.size)
    this.resize()
    this.scale = { teRef: 1, neRef: 0.5 }
    this.dAlphaRef = 0.5
    this.onScale?.(this.scale)
    this.applyOptions()
    this.setCameraPreset('overview')
  }

  setOptions(o: ViewOptions) {
    this.opts = o
    this.vis.colorVar = o.colorVar
    this.vis.showNested = o.nested
    this.applyOptions()
    if (this.surf && this.lastSnap) this.pushPlasma(this.lastSnap)
  }

  private applyOptions() {
    const planes = this.opts.cutaway ? this.clipPlanes : []
    const mats = [...(this.machine?.clippedMaterials ?? []), ...(this.edge?.clippedMaterials ?? [])]
    for (const m of mats) {
      m.clippingPlanes = planes
      m.needsUpdate = true
    }
    this.cut.enabled = this.opts.cutaway && this.opts.slice
    if (this.machine) this.machine.coils.visible = this.opts.coils
    this.plasma.animate(this.vis, this.cut)
    if (this.edge && this.lastSnap) this.edge.setFieldLine(this.surf, this.lastSnap.q95, this.opts.fieldLine)
  }

  // ── camera ──────────────────────────────────────────────────────────
  setCameraPreset(p: CameraPreset) {
    if (!this.machine) return
    const e = this.machine.extent
    const zc = (e.zMax + e.zMin) / 2
    const d = Math.max(e.rMax * 4.0, e.size * 2.7)
    const target = new THREE.Vector3(0, zc, 0)
    let pos: THREE.Vector3
    switch (p) {
      case 'tangential': {
        // From the cut opening at the outboard midplane, looking along the
        // torus the way a tangential camera port does.
        const phi = CUT_CENTER - 0.2 * CUT_HALF
        pos = dirAt(phi).multiplyScalar(e.rMax + 0.08 * e.size).setY(zc + 0.08 * e.size)
        target.copy(dirAt(CUT_CENTER + CUT_HALF + 0.55).multiplyScalar(0.5 * (e.rMin + e.rMax))).setY(zc)
        break
      }
      case 'top':
        pos = new THREE.Vector3(0.001, zc + d * 1.05, 0.25 * d)
        break
      case 'section': {
        // Face-on to one cut face
        const face = dirAt(CUT_CENTER + CUT_HALF)
        const normal = new THREE.Vector3(face.z, 0, -face.x)
        const mid = (e.rMin + e.rMax) / 2
        target.copy(face).multiplyScalar(mid).setY(zc)
        pos = target.clone().addScaledVector(normal, -e.size * 2.4)
        break
      }
      default:
        pos = dirAt(CUT_CENTER + 0.5).multiplyScalar(d * 0.85).setY(zc + d * 0.34)
    }
    this.camera.position.copy(pos)
    this.controls.target.copy(target)
    this.camera.near = e.size * 0.005
    this.camera.far = e.size * 60
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  // ── simulation-driven updates ───────────────────────────────────────
  setSnapshot(snap: Snapshot | null) {
    if (!snap) {
      this.lastSnap = null
      this.surf = null
      this.quenching = false
      this.plasma.setVisible(false)
      this.edge?.setStrikes([], 0)
      this.edge?.setXPoints([])
      this.edge?.setFieldLine(null, 0, false)
      this.brightness = 0
      this.lastTime = -1
      return
    }

    // New pulse (time went backwards): reset auto-scaled references.
    if (snap.time < this.lastTime - 1e-6) {
      this.scale = { teRef: 1, neRef: 0.5 }
      this.dAlphaRef = 0.5
      this.onScale?.(this.scale)
    }
    this.lastTime = snap.time

    const hasPlasma = snap.flux_surfaces.length > 0 && snap.ip > 0.05
    if (!hasPlasma) {
      // Disruption: keep the last shape and fade it out (decorative afterglow).
      if (snap.disrupted && this.surf && this.lastSnap && !this.quenching) {
        this.quenching = true
        this.quenchT = 0
      } else if (!snap.disrupted) {
        this.plasma.setVisible(false)
      }
      this.edge?.setStrikes([], 0)
      this.edge?.setXPoints([])
      this.edge?.setFieldLine(null, 0, false)
      return
    }
    this.quenching = false
    this.vis.fade = 1

    // Colour-scale references: running maxima over the pulse.
    const te0 = snap.te_profile?.[0] ?? snap.te0
    const ne0 = snap.ne_profile?.[0] ?? snap.ne_bar
    if (te0 > this.scale.teRef || ne0 > this.scale.neRef) {
      this.scale = {
        teRef: Math.max(this.scale.teRef, te0 * 1.05),
        neRef: Math.max(this.scale.neRef, ne0 * 1.05),
      }
      this.onScale?.(this.scale)
    }
    this.dAlphaRef = Math.max(this.dAlphaRef, snap.diagnostics.d_alpha)
    this.vis.dAlpha = Math.min(snap.diagnostics.d_alpha / this.dAlphaRef, 1.5)

    // ELM: latch a flash sized by the engine's energy-loss fraction.
    if (snap.elm_active) {
      const amp = Math.min(0.7, 0.2 + 6 * (snap.elm_energy_loss ?? 0))
      this.vis.elm = Math.max(this.vis.elm, amp)
    }

    this.surf = resampleFluxSurfaces(snap.flux_surfaces, snap.axis_r, snap.axis_z, this.surf ?? undefined)
    this.lastSnap = snap
    this.plasma.setVisible(this.surf.count > 0)
    this.pushPlasma(snap)

    // Edge features
    if (this.edge && this.device) {
      const xps: { r: number; z: number }[] = []
      if (!snap.is_limited) {
        if (snap.xpoint_r > 0) xps.push({ r: snap.xpoint_r, z: snap.xpoint_z })
        if (snap.xpoint_upper_r > 0) xps.push({ r: snap.xpoint_upper_r, z: snap.xpoint_upper_z })
      }
      this.edge.setXPoints(xps)
      let strikes: { r: number; z: number }[] = []
      let intensity = 0
      if (!snap.is_limited && snap.separatrix.points.length > 4) {
        strikes = findStrikePoints(
          snap.separatrix.points, this.wall, snap.xpoint_r, snap.xpoint_z, snap.axis_r,
          snap.xpoint_upper_r, snap.xpoint_upper_z,
        )
        const dev = snap.mass_number !== this.device.mass_number
          ? { ...this.device, mass_number: snap.mass_number } : this.device
        const q = computeDivertorHeatFlux(snap, dev).q_peak
        intensity = Math.log10(1 + Math.max(q, 0)) / Math.log10(1 + 20)
      }
      this.edge.setStrikes(strikes, intensity)
      this.edge.setFieldLine(this.surf, snap.q95, this.opts.fieldLine)
    }
  }

  private pushPlasma(snap: Snapshot) {
    if (!this.surf) return
    this.plasma.update(this.surf, snap, this.scale, this.vis, this.cut)
    // Plasma glow brightness for the decorative wall lighting
    const teN = (snap.te_profile?.[0] ?? snap.te0) / this.scale.teRef
    const neN = (snap.ne_profile?.[0] ?? snap.ne_bar) / this.scale.neRef
    this.brightness = Math.min(neN * neN * Math.sqrt(Math.max(teN, 0)), 1.5)
    const r = snap.axis_r
    this.plasmaLights.forEach((l, i) => {
      const phi = (Math.PI / 2) * i + Math.PI / 4
      l.position.set(r * Math.sin(phi), snap.axis_z, r * Math.cos(phi))
    })
  }

  // ── render loop ─────────────────────────────────────────────────────
  private loop = () => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    this.fly(dt)
    this.controls.update()

    let needPlasma = false
    if (this.vis.elm > 0.001) {
      this.vis.elm *= Math.exp(-dt / ELM_DECAY)
      needPlasma = true
    } else if (this.vis.elm !== 0) {
      this.vis.elm = 0
      needPlasma = true
    }
    let flash = 0
    if (this.quenching) {
      this.quenchT += dt
      const f = Math.max(0, 1 - this.quenchT / QUENCH_FADE)
      this.vis.fade = f * f
      flash = Math.exp(-this.quenchT / 0.15)
      this.vis.elm = Math.max(this.vis.elm, flash)
      if (this.lastSnap) this.pushPlasma(this.lastSnap)
      if (f <= 0) { this.quenching = false; this.plasma.setVisible(false) }
      needPlasma = true
    }
    if (needPlasma) this.plasma.animate(this.vis, this.cut)

    const glow = (this.plasma.group.visible ? this.brightness * this.vis.fade : 0) + 3 * flash + 0.15 * this.vis.elm
    const size = this.machine?.extent.size ?? 1
    for (const l of this.plasmaLights) {
      l.intensity = glow * 0.035 * size * size
      l.color.setRGB(1, 0.45 + 0.4 * flash, 0.65 + 0.3 * flash)
    }
    this.post.composer.render()
  }

  // ── fly controls (WASD + Q/E), active while the canvas has focus ─────
  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase()
    if ('wasdqe'.includes(k) && k.length === 1) { this.keys.add(k); e.preventDefault() }
  }
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()) }
  private onBlur = () => { this.keys.clear() }

  private fly(dt: number) {
    if (this.keys.size === 0 || !this.machine) return
    const speed = this.machine.extent.size * 0.6 * dt
    const fwd = new THREE.Vector3()
    this.camera.getWorldDirection(fwd)
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize()
    const move = new THREE.Vector3()
    if (this.keys.has('w')) move.add(fwd)
    if (this.keys.has('s')) move.sub(fwd)
    if (this.keys.has('d')) move.add(right)
    if (this.keys.has('a')) move.sub(right)
    if (this.keys.has('e')) move.y += 1
    if (this.keys.has('q')) move.y -= 1
    if (move.lengthSq() === 0) return
    move.normalize().multiplyScalar(speed)
    this.camera.position.add(move)
    this.controls.target.add(move)
  }
}
