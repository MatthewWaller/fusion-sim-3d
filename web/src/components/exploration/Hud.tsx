import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { Snapshot } from '../../lib/types'
import type { Device } from '../../lib/wasm'
import { computeFusion, formatQ } from '../../lib/fusionPhysics'
import { colormapCss, type ColorVar } from './colormap'
import type { CameraPreset, ViewOptions } from './scene'
import type { ProfileScale } from './plasmaVolume'

interface HudProps {
  snapshot: Snapshot | null
  device: Device | undefined
  options: ViewOptions
  onOptions: Dispatch<SetStateAction<ViewOptions>>
  onCamera: (p: CameraPreset) => void
  scale: ProfileScale
  finished: boolean
  scrubTime: number | null
  duration: number
  onScrub: (t: number | null) => void
}

function Row({ label, value, unit, tone }: { label: ReactNode; value: string; unit?: string; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-[var(--c-bad-ink)]' : tone === 'warn' ? 'text-[var(--c-warn)]' : 'text-[var(--c-ink)]'
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--c-ink-dim)]">{label}</span>
      <span className={`font-mono tabular-nums ${color}`}>
        {value}
        {unit && <span className="text-[var(--c-ink-faint)] ml-1 text-[10px]">{unit}</span>}
      </span>
    </div>
  )
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`px-2 py-1 rounded text-xs transition-colors cursor-pointer border
        ${on ? 'bg-cyan-700/60 border-cyan-500/60 text-white' : 'bg-gray-900/70 border-gray-700 text-gray-400 hover:text-gray-200'}`}
    >
      {children}
    </button>
  )
}

const panel = 'bg-[#0b0d12]/80 backdrop-blur-sm border border-gray-800 rounded-md'

export default function Hud(props: HudProps) {
  const { snapshot: s, device, options, onOptions, onCamera, scale, finished, scrubTime, duration, onScrub } = props
  const [showNotes, setShowNotes] = useState(false)

  const fusion = useMemo(() => {
    if (!s || !device) return null
    const dev = s.mass_number !== device.mass_number ? { ...device, mass_number: s.mass_number } : device
    return computeFusion(s, dev)
  }, [s, device])

  const set = (patch: Partial<ViewOptions> | ((o: ViewOptions) => Partial<ViewOptions>)) =>
    onOptions((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
  const colorLabel: Record<ColorVar, string> = { te: 'Tₑ', ne: 'nₑ' }
  const legendMax = options.colorVar === 'te' ? `${scale.teRef.toFixed(1)} keV` : `${scale.neRef.toFixed(2)}×10²⁰ m⁻³`

  // Event banners — each driven by a flag or value the engine computes.
  const banners: { text: string; tone: 'info' | 'warn' | 'bad' }[] = []
  if (s) {
    if (s.status === 'Disrupted') banners.push({ text: 'DISRUPTION: current quench', tone: 'bad' })
    else if (s.disrupted) banners.push({ text: 'DISRUPTION: locked mode / thermal quench', tone: 'bad' })
    else if (s.disruption_risk > 0.3) banners.push({ text: `Disruption risk ${(s.disruption_risk * 100).toFixed(0)}%`, tone: 'warn' })
    // f_GW is only meaningful with current flowing (it divides by Ip)
    if (s.f_greenwald >= 0.95 && s.ip > 0.1 && s.status !== 'Disrupted' && s.status !== 'Complete') banners.push({ text: `Near Greenwald limit (f_GW ${s.f_greenwald.toFixed(2)})`, tone: 'warn' })
    if (s.elm_active) banners.push({ text: 'ELM', tone: 'info' })
  }

  return (
    <div className="absolute inset-0 pointer-events-none text-xs select-none">
      {/* Live parameters */}
      <div className={`${panel} pointer-events-auto absolute top-2 left-2 w-52 p-2 space-y-0.5`}>
        <div className="flex items-center justify-between mb-1">
          <span className="font-semibold text-[var(--c-ink)]">{device?.name ?? '—'}</span>
          <span className={`px-1.5 rounded text-[10px] font-medium ${s?.in_hmode ? 'bg-emerald-700/70 text-white' : 'bg-gray-700 text-gray-300'}`}>
            {s ? (s.in_hmode ? 'H-mode' : 'L-mode') : 'idle'}
          </span>
        </div>
        {s ? (
          <>
            <Row label="t" value={s.time.toFixed(2)} unit="s" />
            <Row label="Config" value={s.is_limited ? 'Limited' : s.magnetic_config.replace(/([a-z])([A-Z])/g, '$1 $2')} />
            <Row label="Iₚ" value={s.ip.toFixed(2)} unit="MA" />
            <Row label="B_T" value={s.bt.toFixed(2)} unit="T" />
            <Row label="Tₑ₀" value={s.te0.toFixed(2)} unit="keV" />
            <Row label="n̄ₑ" value={s.ne_bar.toFixed(2)} unit="10²⁰m⁻³" />
            <Row label="W_th" value={s.w_th.toFixed(2)} unit="MJ" />
            <Row label="P_in" value={s.p_input.toFixed(1)} unit="MW" />
            <Row label="P_rad" value={s.p_rad.toFixed(1)} unit="MW" />
            <Row label="P_fus" value={fusion ? fusion.p_fus.toFixed(fusion.p_fus < 1 ? 3 : 1) : '—'} unit="MW" />
            <Row label="Q" value={fusion?.q_plasma != null ? formatQ(fusion.q_plasma) : '—'} />
            <Row label="β_N" value={s.beta_n.toFixed(2)} tone={s.beta_n > 3 ? 'warn' : undefined} />
            <Row label="q₉₅" value={s.q95.toFixed(2)} tone={s.q95 < 2.5 ? 'warn' : undefined} />
            <Row label="f_GW" value={s.f_greenwald.toFixed(2)} tone={s.f_greenwald >= 1 ? 'bad' : s.f_greenwald >= 0.85 ? 'warn' : undefined} />
            <Row label="H₉₈" value={s.h_factor.toFixed(2)} />
            <div className="pt-1">
              <div className="flex justify-between text-[var(--c-ink-dim)]"><span>Disruption risk</span><span className="font-mono">{(s.disruption_risk * 100).toFixed(0)}%</span></div>
              <div className="h-1 bg-gray-800 rounded mt-0.5 overflow-hidden">
                <div className="h-full rounded" style={{
                  width: `${Math.min(100, s.disruption_risk * 100)}%`,
                  background: s.disruption_risk > 0.5 ? 'var(--c-bad)' : s.disruption_risk > 0.2 ? 'var(--c-warn)' : 'var(--c-ok)',
                }} />
              </div>
            </div>
          </>
        ) : (
          <div className="text-[var(--c-ink-dim)] py-2">Press ▶ Start to run the pulse.</div>
        )}
      </div>

      {/* Event banners */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
        {banners.map((b) => (
          <div key={b.text} className={`px-3 py-1 rounded font-medium tracking-wide border ${
            b.tone === 'bad' ? 'bg-red-900/80 border-red-500 text-red-100'
              : b.tone === 'warn' ? 'bg-amber-900/70 border-amber-500 text-amber-100'
                : 'bg-fuchsia-900/70 border-fuchsia-400 text-fuchsia-100'}`}>
            {b.text}
          </div>
        ))}
      </div>

      {/* View controls */}
      <div className={`${panel} pointer-events-auto absolute top-2 right-2 p-2 flex flex-col gap-1.5 items-stretch w-48`}>
        <div className="text-[10px] uppercase tracking-wider text-[var(--c-ink-faint)]">View</div>
        <div className="flex flex-wrap gap-1">
          <Toggle on={options.cutaway} onClick={() => set((o) => ({ cutaway: !o.cutaway }))}>Cutaway</Toggle>
          <Toggle on={options.slice} onClick={() => set((o) => ({ slice: !o.slice, cutaway: o.cutaway || !o.slice }))}>Slice plasma</Toggle>
          <Toggle on={options.nested} onClick={() => set((o) => ({ nested: !o.nested }))}>Flux surfaces</Toggle>
          <Toggle on={options.coils} onClick={() => set((o) => ({ coils: !o.coils }))}>Coils</Toggle>
          <Toggle on={options.fieldLine} onClick={() => set((o) => ({ fieldLine: !o.fieldLine }))}>Field line</Toggle>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--c-ink-faint)] mt-1">Colour by</div>
        <div className="flex gap-1">
          {(['te', 'ne'] as const).map((v) => (
            <Toggle key={v} on={options.colorVar === v} onClick={() => set({ colorVar: v })}>{colorLabel[v]}</Toggle>
          ))}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--c-ink-faint)] mt-1">Camera</div>
        <div className="flex flex-wrap gap-1">
          {([['overview', 'Overview'], ['tangential', 'Tangential'], ['section', 'Section'], ['top', 'Top']] as const).map(([id, label]) => (
            <Toggle key={id} on={false} onClick={() => {
              // The section view is only useful with the plasma sliced open
              if (id === 'section') set({ cutaway: true, slice: true })
              if (id === 'tangential') set({ cutaway: true })
              onCamera(id)
            }}>{label}</Toggle>
          ))}
        </div>
        <div className="text-[10px] text-[var(--c-ink-faint)] leading-snug mt-1">
          Drag to orbit, right-drag to pan, scroll to zoom. Click the view, then W A S D / Q E to fly.
        </div>
      </div>

      {/* Legend + notes */}
      <div className={`${panel} pointer-events-auto absolute bottom-2 left-2 p-2 w-64`}>
        <div className="flex justify-between text-[var(--c-ink-dim)] mb-1">
          <span>{colorLabel[options.colorVar]} on flux surfaces</span>
          <button className="underline cursor-pointer text-[var(--c-ink-faint)] hover:text-[var(--c-ink)]" onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? 'hide notes' : "what's physical?"}
          </button>
        </div>
        <div className="h-2 rounded" style={{ background: colormapCss(options.colorVar) }} />
        <div className="flex justify-between font-mono text-[10px] text-[var(--c-ink-faint)] mt-0.5">
          <span>0</span><span>{legendMax} (pulse max)</span>
        </div>
        {showNotes && (
          <ul className="mt-2 space-y-1 text-[10.5px] leading-snug text-[var(--c-ink-dim)] list-disc pl-4">
            <li><b>From the engine:</b> flux-surface shapes (ψ_N 0.1–0.9, 0.995), magnetic axis, X-points, Tₑ/nₑ profiles, ELM timing and size, D-alpha, disruption state.</li>
            <li><b>Mapping assumption:</b> profiles are indexed by ρ; surfaces are coloured with ρ ≈ √ψ_N.</li>
            <li><b>Brightness</b> ∝ nₑ²√Tₑ (bremsstrahlung scaling) as a relative proxy, not a synthetic camera image.</li>
            <li><b>Strike rings:</b> separatrix–wall intersections; brightness is log-scaled q_peak from the display-side Eich model.</li>
            <li><b>Field line:</b> pitch from q₉₅ in geometric poloidal angle (approximate).</li>
            <li><b>Schematic / decorative:</b> TF, CS and PF coil geometry, divertor shading, wall lighting, ELM flash shape, disruption afterglow.</li>
          </ul>
        )}
      </div>

      {/* Post-pulse scrub */}
      {finished && (
        <div className={`${panel} pointer-events-auto absolute bottom-2 right-2 left-[17.5rem] p-2 flex items-center gap-2`}>
          <span className="text-[var(--c-ink-dim)] whitespace-nowrap">Replay</span>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={scrubTime ?? duration}
            onChange={(e) => onScrub(Number(e.target.value))}
            className="flex-1 accent-cyan-500"
            aria-label="Scrub pulse time"
          />
          <button onClick={() => onScrub(null)} className="px-2 py-0.5 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 cursor-pointer">
            End
          </button>
        </div>
      )}
    </div>
  )
}
