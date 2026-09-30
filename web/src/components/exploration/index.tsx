/**
 * Exploration Room: a free-camera 3D view of the whole tokamak, driven by the
 * same live simulation state as the control room. See scene.ts for the
 * rendering and plasmaVolume.ts / edge.ts for what each visual is tied to.
 */

import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../../lib/types'
import type { Device } from '../../lib/wasm'
import { ExplorationScene, type CameraPreset, type ViewOptions } from './scene'
import type { ProfileScale } from './plasmaVolume'
import Hud from './Hud'

interface Props {
  snapshot: Snapshot | null
  device: Device | undefined
  /** Detailed first-wall contour (CAD-derived) when the app has one. */
  limiterPoints?: [number, number][]
  finished: boolean
  scrubTime: number | null
  duration: number
  onScrub: (t: number | null) => void
}

const DEFAULT_OPTIONS: ViewOptions = { cutaway: true, slice: false, nested: true, coils: true, fieldLine: false, colorVar: 'te' }

export default function ExplorationRoom({ snapshot, device, limiterPoints, finished, scrubTime, duration, onScrub }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<ExplorationScene | null>(null)
  const [options, setOptions] = useState<ViewOptions>(DEFAULT_OPTIONS)
  const [scale, setScale] = useState<ProfileScale>({ teRef: 1, neRef: 0.5 })
  const [webglError, setWebglError] = useState<string | null>(null)

  // Scene lifecycle
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let scene: ExplorationScene
    try {
      scene = new ExplorationScene(container)
    } catch (e) {
      // Surface the failure instead of rendering a blank panel.
      queueMicrotask(() => setWebglError(e instanceof Error ? e.message : String(e)))
      return
    }
    sceneRef.current = scene
    scene.onScale = (s) => setScale(s)
    scene.start()

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') scene.stop()
      else scene.start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const ro = new ResizeObserver(() => scene.resize())
    ro.observe(container)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  // Device hardware
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !device) return
    const wall = limiterPoints && limiterPoints.length > 3 ? limiterPoints : device.wall_outline
    scene.setDevice(device, wall)
  }, [device, limiterPoints])

  // View options
  useEffect(() => {
    sceneRef.current?.setOptions(options)
  }, [options])

  // Live state
  useEffect(() => {
    sceneRef.current?.setSnapshot(snapshot)
  }, [snapshot, device])

  const onCamera = (p: CameraPreset) => sceneRef.current?.setCameraPreset(p)

  return (
    <div className="relative w-full h-full min-h-0 overflow-hidden bg-[#050608]">
      <div ref={containerRef} className="absolute inset-0" data-testid="exploration-canvas" />
      {webglError ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--c-ink-dim)] p-6 text-center">
          WebGL could not start in this browser, so the 3D Exploration Room is unavailable. ({webglError})
        </div>
      ) : (
        <Hud
          snapshot={snapshot}
          device={device}
          options={options}
          onOptions={setOptions}
          onCamera={onCamera}
          scale={scale}
          finished={finished}
          scrubTime={scrubTime}
          duration={duration}
          onScrub={onScrub}
        />
      )}
    </div>
  )
}
