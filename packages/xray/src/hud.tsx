/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { render } from '@solidjs/web'
import type {
  CaptureHook,
  MountedPlate,
  PlateCoverage,
  SessionSnapshot,
  Span,
  XrayModeState,
} from './plate.ts'
import { WORDMARK_URI } from './hud-wordmark.ts'

/**
 * The opt-in dev HUD: a fixed film panel projecting the dev client's stores (ADR 0027 §4 — the HUD
 * owns no capture state). The deck holds the two controls — record (crimson) and Light Box's play
 * (steel) — with the status ticker inline and the wordmark signing off the row. Guidance and
 * failures are cards below the deck; the plates section opens on demand: mounted plates with
 * per-band coverage segments and per-plate deck keys, on-disk unmounted plates dimmed at the
 * bottom. Solid renders into a shadow root, so neither styles nor event delegation leak into the
 * consumer's app.
 */

export interface HudHandle {
  dispose: () => void
}

/**
 * Bridge a client store (`get`/`subscribe`) into a Solid read. The value is boxed so every
 * notification propagates regardless of snapshot identity (some stores rebuild their snapshot,
 * others mutate in place — the box makes reference equality always miss). The subscription's
 * lifecycle rides `onSettled`'s returned cleanup, so a disposed HUD unsubscribes everywhere.
 */
function fromStore<T>(get: () => T, subscribe?: (onChange: () => void) => () => void): () => T {
  const [box, setBox] = createSignal({ v: get() })
  onSettled(() => subscribe?.(() => setBox({ v: get() })))
  return () => box().v
}

/** `1200` → `1.2k` — the segment labels' compact width format. */
function fmtWidth(w: number): string {
  if (w < 1000) return String(w)
  const k = w / 1000
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
}

interface Band {
  label: string
  title: string
  covered: boolean
  fresh: boolean
}

/**
 * A plate's width bands from its detected breakpoints, flagged captured (a committed span matches
 * the band — spans align to band boundaries, ADR 0004), fresh (a session View's width falls inside
 * it), or missing. No breakpoints yet → one full-axis band.
 */
function bandsFor(coverage: PlateCoverage | undefined, sessionWidths: readonly number[]): Band[] {
  const breakpoints = [...(coverage?.breakpoints ?? [])].toSorted((a, b) => a - b)
  const spans = coverage?.spans ?? []
  const bands: (Span & { label: string })[] = []
  for (let i = 0; i <= breakpoints.length; i++) {
    const min = i === 0 ? undefined : breakpoints[i - 1]
    const max = i === breakpoints.length ? undefined : breakpoints[i]
    const label =
      min === undefined && max === undefined
        ? 'all widths'
        : min === undefined
          ? `‹${fmtWidth(max ?? 0)}`
          : max === undefined
            ? `≥${fmtWidth(min)}`
            : `${fmtWidth(min)}–${fmtWidth(max)}`
    bands.push({ min, max, label })
  }
  return bands.map((band) => {
    const fresh = sessionWidths.some(
      (w) => w >= (band.min ?? 0) && (band.max === undefined || w < band.max),
    )
    const covered = fresh || spans.some((span) => span.min === band.min && span.max === band.max)
    const title = fresh
      ? 'captured this session'
      : covered
        ? 'captured'
        : 'missing — record into this width'
    return { label: band.label, title, covered, fresh }
  })
}

const RELEASES_URL = 'https://github.com/hueest/xray/releases'

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 5.2 18.5 12 7.5 18.8Z" />
    </svg>
  )
}

function KeyPlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4.5 19 12 7 19.5Z" />
    </svg>
  )
}

function Hud(props: { hook: CaptureHook }) {
  const hook = props.hook

  const mode = fromStore<XrayModeState>(
    () => hook.mode?.get() ?? { action: 'idle' },
    hook.mode?.subscribe,
  )
  const session = fromStore<SessionSnapshot>(
    () => hook.session?.get() ?? { views: new Map(), save: 'idle', savedCount: 0 },
    hook.session?.subscribe,
  )
  const sites = fromStore<ReadonlyMap<string, MountedPlate>>(
    () => hook.sites?.get() ?? new Map(),
    hook.sites?.subscribe,
  )
  const coverage = fromStore<ReadonlyMap<string, PlateCoverage>>(
    () => hook.coverage?.get() ?? new Map(),
    hook.coverage?.subscribe,
  )
  const extension = fromStore(
    () => hook.extension?.get() ?? { present: false, caps: [] as readonly string[] },
    hook.extension?.subscribe,
  )
  const replayOn = fromStore(() => hook.replay?.get() ?? false, hook.replay?.subscribe)
  // Fixture/diagnostic reads are per-name derivations; the ticks make rows recompute.
  const fixturesTick = fromStore(() => ({}), hook.fixtures?.subscribe)
  const diagnosticsTick = fromStore(() => ({}), hook.diagnostics?.subscribe)

  const [platesOpen, setPlatesOpen] = createSignal(false)

  // ── mode/scope derivations ─────────────────────────────────────────────────
  const recordingGlobal = () => {
    const m = mode()
    return m.action === 'record' && m.scope === 'global'
  }
  const recordNames = (): ReadonlySet<string> | undefined => {
    const m = mode()
    return m.action === 'record' && m.scope !== 'global' ? m.scope : undefined
  }
  const lightboxGlobal = () => {
    const m = mode()
    return m.action === 'lightbox' && m.scope === 'global'
  }
  const lightboxNames = (): ReadonlySet<string> | undefined => {
    const m = mode()
    return m.action === 'lightbox' && m.scope !== 'global' ? m.scope : undefined
  }
  const recording = () => mode().action === 'record'
  const lightboxing = () => mode().action === 'lightbox'
  const writing = () => session().save === 'writing'
  const canSweep = () => extension().caps.includes('emulate')

  const mountedNames = createMemo(() => [...sites().keys()].toSorted())
  // The rows: mounted plates plus any name in an active per-plate scope. A scoped
  // plate that unmounts (navigation) keeps its row — dimmed, key lit — so the
  // engaged action can always be disengaged from where it was engaged.
  const rowNames = createMemo(() => {
    const names = new Set(mountedNames())
    const m = mode()
    if (m.action !== 'idle' && m.scope !== 'global') for (const n of m.scope) names.add(n)
    return [...names].toSorted()
  })
  const diskNames = createMemo(() => {
    const rows = new Set(rowNames())
    return [...coverage().keys()].filter((name) => !rows.has(name)).toSorted()
  })
  const fixtureStatus = (name: string) => {
    fixturesTick()
    return hook.fixtures?.status(name) ?? { participates: false, recorded: false, replaying: false }
  }
  const diagnosticLines = (name: string): readonly string[] => {
    diagnosticsTick()
    return hook.diagnostics?.get(name) ?? []
  }

  // Coverage totals over the MOUNTED plates (the ticker's x/y and the gaps count).
  const totals = createMemo(() => {
    let total = 0
    let covered = 0
    let recordedFixtures = 0
    for (const name of mountedNames()) {
      const bands = bandsFor(coverage().get(name), session().views.get(name) ?? [])
      total += bands.length
      covered += bands.filter((b) => b.covered).length
      if (fixtureStatus(name).recorded) recordedFixtures += 1
    }
    return { total, covered, gaps: total - covered, recordedFixtures }
  })
  const anyFixture = createMemo(
    () =>
      totals().recordedFixtures > 0 ||
      diskNames().some((name) => fixtureStatus(name).recorded) ||
      mountedNames().some((name) => fixtureStatus(name).participates),
  )
  const nothingCaptured = () => mountedNames().length > 0 && totals().covered === 0 && !recording()

  // ── control enable/disable (the one-mode matrix, rendered) ────────────────
  const recDisabled = () =>
    (mountedNames().length === 0 && !recordingGlobal()) ||
    lightboxing() ||
    recordNames() !== undefined ||
    writing()
  const playDisabled = () =>
    recording() ||
    lightboxNames() !== undefined ||
    writing() ||
    (!lightboxGlobal() && (mountedNames().length === 0 || totals().covered === 0))
  const rowRecDisabled = (name: string) =>
    lightboxing() ||
    recordingGlobal() ||
    writing() ||
    // One shared viewport: while a sweep is visiting widths, no NEW scope key
    // can join (a lit key still disengages its own plate).
    (session().sweep !== undefined && !(recordNames()?.has(name) ?? false))
  const rowPlayDisabled = () => recording() || lightboxGlobal() || writing()

  const onRecord = () => {
    void hook.mode?.setRecord(!recordingGlobal())
  }
  const onPlay = () => {
    hook.mode?.setLightbox(!lightboxGlobal())
  }
  const onRowRecord = (name: string) => {
    void hook.mode?.recordName(name, !recordNames()?.has(name))
  }
  const onRowPlay = (name: string) => {
    hook.mode?.lightboxName(name, !lightboxNames()?.has(name))
  }

  const sessionViewCount = () =>
    [...session().views.values()].reduce((sum, widths) => sum + widths.length, 0)
  const sweepPct = () => {
    const sweep = session().sweep
    if (!sweep || sweep.total === 0) return '0%'
    return `${Math.round((sweep.index / sweep.total) * 100)}%`
  }

  const ticker = () => {
    const s = session()
    if (s.save === 'writing') return <span class="tick">writing…</span>
    if (s.sweepError !== undefined) {
      return (
        <span class="tick">
          <span class="err">✕</span> sweep
        </span>
      )
    }
    if (s.save === 'failed') {
      return (
        <span class="tick">
          <span class="err">✕</span> {sessionViewCount()} views kept
        </span>
      )
    }
    if (recording()) {
      return (
        <span class="tick">
          <span class="live">●</span>{' '}
          <Show when={s.sweep} fallback={<>{sessionViewCount()} views</>}>
            {(sweep) => (
              <>
                <span class="em">{sweep().width}px</span> · {sweep().index}/{sweep().total}
              </>
            )}
          </Show>
        </span>
      )
    }
    if (lightboxing()) {
      const count = lightboxNames()?.size ?? mountedNames().length
      return (
        <span class="tick">
          <span class="lit">▶</span> <span class="em">{count}</span>{' '}
          {count === 1 ? 'skeleton' : 'skeletons'}
        </span>
      )
    }
    if (mountedNames().length === 0) return <span class="tick">—</span>
    return (
      <span class="tick">
        <Show when={s.save === 'saved' && s.savedCount > 0}>
          <span class="ok">✓ {s.savedCount} </span>
        </Show>
        <span class="em">
          {totals().covered}/{totals().total}
        </span>{' '}
        views
        <Show when={totals().recordedFixtures > 0}>
          {' '}
          · <span class="lit">{totals().recordedFixtures} ◆</span>
        </Show>
      </span>
    )
  }

  return (
    <div class="hud">
      <div class="deck">
        <button
          type="button"
          class={['ctl', 'rec', { on: recordingGlobal(), sweeping: session().sweep !== undefined }]}
          style={{ '--xr-sweep': sweepPct() }}
          disabled={recDisabled()}
          aria-pressed={recordingGlobal() ? 'true' : 'false'}
          aria-label={
            recordingGlobal()
              ? 'Stop and save'
              : canSweep()
                ? 'Record — sweeps every view and saves'
                : 'Record — captures at your width, writes on stop'
          }
          onClick={onRecord}
        >
          <span class="glyph" />
        </button>
        <button
          type="button"
          class={['ctl', 'play', { on: lightboxGlobal() }]}
          disabled={playDisabled()}
          aria-pressed={lightboxGlobal() ? 'true' : 'false'}
          aria-label={
            lightboxGlobal() ? 'Stop showing skeletons' : 'Light Box — flip every skeleton on'
          }
          onClick={onPlay}
        >
          <PlayGlyph />
        </button>
        {ticker()}
        <span class="wordmark" role="img" aria-label="xray" />
      </div>

      <Show when={session().sweepError}>
        {(message) => (
          <div class="foot">
            <div class="card err">
              <span class="txt">
                <b>✕ sweep failed</b>
                {message()} — press ● to try again
              </span>
            </div>
          </div>
        )}
      </Show>
      <Show when={session().save === 'failed'}>
        <div class="foot">
          <div class="card err">
            <span class="txt">
              <b>✕ write failed</b>
              {session().saveError ?? 'the dev server refused the write'} — views kept, press ● to
              retry
            </span>
          </div>
        </div>
      </Show>
      <Show when={mountedNames().length === 0}>
        <div class="foot">
          <div class="card">
            <span class="txt">
              <b>No skeletons on this page</b>browse to a page that mounts one
            </span>
          </div>
        </div>
      </Show>
      <Show when={nothingCaptured() && session().save === 'idle'}>
        <div class="foot">
          <div class="card">
            <span class="txt">
              <b>Nothing captured yet</b>
              {mountedNames().length} skeleton{mountedNames().length === 1 ? '' : 's'} mounted —
              press ● to record
            </span>
          </div>
        </div>
      </Show>
      <Show when={recording() && !canSweep() && totals().gaps > 0}>
        <div class="foot">
          <div class="card">
            <span class="txt">
              <b>
                {totals().gaps} width{totals().gaps === 1 ? '' : 's'} missing
              </b>
              resize the window through the dashed bands
            </span>
          </div>
        </div>
      </Show>
      <Show when={!extension().present && mountedNames().length > 0}>
        <div class="foot">
          <a class="card promo" href={RELEASES_URL} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 2 5 13h5l-1 9 8-11h-5l1-9z" />
            </svg>
            <span class="txt">
              <b>Sweep every view in one click</b>Get the xray extension →
            </span>
          </a>
        </div>
      </Show>
      <Show when={extension().present && !canSweep()}>
        <div class="warnline">extension can’t sweep — update it</div>
      </Show>

      <div class="hr" />
      <button
        type="button"
        class="plates-line"
        aria-expanded={platesOpen() ? 'true' : 'false'}
        onClick={() => setPlatesOpen(!platesOpen())}
      >
        {/*
          One grammar for every state:
          `{no skeletons | N skeleton(s)} [· V view(s) unsaved] [· G gap(s)] [· D on disk]`
          — the page count leads (stitched rows included: their bones are on the
          page), unsaved session views outrank gaps (both never show at once),
          gaps only appear once SOMETHING is captured (before that, the
          nothing-captured card explains), and the disk-only stock closes.
        */}
        <span>
          <Show when={mountedNames().length > 0} fallback={<span class="dim">no skeletons</span>}>
            <span class="n">
              {mountedNames().length} skeleton{mountedNames().length === 1 ? '' : 's'}
            </span>
          </Show>
          <Show when={sessionViewCount() > 0}>
            {' · '}
            <span class="em">
              {sessionViewCount()} view{sessionViewCount() === 1 ? '' : 's'} unsaved
            </span>
          </Show>
          <Show when={sessionViewCount() === 0 && totals().gaps > 0 && totals().covered > 0}>
            {' · '}
            <span class="gap">
              {totals().gaps} gap{totals().gaps === 1 ? '' : 's'}
            </span>
          </Show>
          {/* The disk stock is a repo fact, stable across pages: the TOTAL count,
              not disk-minus-page (the dim list section below still shows only the
              plates not on this page, so rows never double). */}
          <Show when={coverage().size > 0}>
            {' · '}
            {coverage().size} plate{coverage().size === 1 ? '' : 's'} on disk
          </Show>
        </span>
        <span class="chev">{platesOpen() ? '▾' : '▸'}</span>
      </button>

      <Show when={platesOpen()}>
        <div class="plates">
          <For each={rowNames()}>
            {(name) => {
              const info = () => sites().get(name)
              const stitchOnly = () => (info()?.instances ?? 0) === 0 && !!info()?.stitchedUnder
              const hosts = () => info()?.stitchedUnder ?? []
              const fx = () => fixtureStatus(name)
              const bands = () => bandsFor(coverage().get(name), session().views.get(name) ?? [])
              const diag = () => diagnosticLines(name)
              return (
                <div
                  class={['plate', { unmounted: !sites().has(name), stitch: stitchOnly() }]}
                  tabindex="0"
                  onMouseEnter={() => hook.highlight?.(name, true)}
                  onMouseLeave={() => hook.highlight?.(name, false)}
                  onFocus={() => hook.highlight?.(name, true)}
                  onBlur={() => hook.highlight?.(name, false)}
                >
                  <div class="top">
                    <span class="name">{name}</span>
                    <Show when={fx().recorded}>
                      <span
                        class="badge fx"
                        title={fx().replaying ? 'fixture · replaying' : 'fixture recorded'}
                      >
                        ◆
                      </span>
                    </Show>
                    <Show when={info()?.tooLarge}>
                      <span class="badge warn" title="capture refused: tree too large">
                        ⚠
                      </span>
                    </Show>
                    <Show when={(info()?.instances ?? 0) > 1}>
                      <span
                        class="badge"
                        title="mounted more than once; the first in the document writes"
                      >
                        ×{info()?.instances}
                      </span>
                    </Show>
                    <span class="spacer" />
                    <span class="keys">
                      <button
                        type="button"
                        class={['key', { 'on-rec': recordNames()?.has(name) ?? false }]}
                        disabled={rowRecDisabled(name) || stitchOnly()}
                        title={
                          stitchOnly() ? 'a stitch has no mounted content to capture' : undefined
                        }
                        aria-pressed={recordNames()?.has(name) ? 'true' : 'false'}
                        aria-label={
                          recordNames()?.has(name) ? `Stop recording ${name}` : `Record ${name}`
                        }
                        onClick={() => onRowRecord(name)}
                      >
                        <span class="dot" />
                      </button>
                      <button
                        type="button"
                        class={['key', { 'on-play': lightboxNames()?.has(name) ?? false }]}
                        disabled={rowPlayDisabled() || stitchOnly()}
                        title={
                          stitchOnly()
                            ? `already showing as bones — light box ${hosts()[0] ?? 'the parent'} off first`
                            : undefined
                        }
                        aria-pressed={lightboxNames()?.has(name) ? 'true' : 'false'}
                        aria-label={
                          lightboxNames()?.has(name)
                            ? `Stop Light Box for ${name}`
                            : `Light Box ${name}`
                        }
                        onClick={() => onRowPlay(name)}
                      >
                        <KeyPlayGlyph />
                      </button>
                    </span>
                  </div>
                  <div class="segs">
                    <For each={bands()}>
                      {(band) => (
                        <span
                          class={['seg', { c: band.covered && !band.fresh, f: band.fresh }]}
                          title={band.title}
                        >
                          {band.label}
                        </span>
                      )}
                    </For>
                  </div>
                  <Show when={hosts().length > 0}>
                    <div class="note">↳ stitch of {hosts().join(' · ')}</div>
                  </Show>
                  <Show when={diag().length > 0}>
                    <div class="note err">⚠ {diag()[0]}</div>
                  </Show>
                </div>
              )
            }}
          </For>
          <Show when={diskNames().length > 0}>
            <div class="disk-label">on disk · not on this page</div>
            <For each={diskNames()}>
              {(name) => (
                <div class="plate unmounted">
                  <div class="top">
                    <span class="name">{name}</span>
                    <Show when={fixtureStatus(name).recorded}>
                      <span class="badge fx">◆</span>
                    </Show>
                    <span class="spacer" />
                    <span class="views">
                      {coverage().get(name)?.spans.length ?? 0} view
                      {(coverage().get(name)?.spans.length ?? 0) === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
        <Show when={anyFixture()}>
          <div class="hr" />
          <div class="replay-line">
            replay fixtures
            <span class="spacer" />
            <button
              type="button"
              class={['switch', { on: replayOn() }]}
              role="switch"
              aria-checked={replayOn() ? 'true' : 'false'}
              aria-label="Replay fixtures"
              onClick={() => hook.replay?.set(!replayOn())}
            />
          </div>
        </Show>
      </Show>
    </div>
  )
}

const STYLE = `
  :host {
    position: fixed; bottom: 12px; right: 12px; z-index: 2147483647;
    --steel: oklch(0.62 0.11 246);
    --crimson: oklch(0.62 0.17 25);
    --surface: oklch(0.13 0.02 254);
    --surface-2: oklch(0.17 0.02 252);
    --bone: oklch(0.95 0.012 244 / 0.78);
    --bone-solid: oklch(0.95 0.012 244);
    --muted: oklch(0.69 0.02 251);
    --line: oklch(0.28 0.02 253);
  }
  * { box-sizing: border-box; margin: 0; padding: 0 }
  .hud {
    width: 320px; background: var(--surface); color: var(--bone);
    border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 0 18px oklch(0.62 0.11 246 / 0.10), inset 0 0 10px oklch(0.62 0.11 246 / 0.05);
    font: 500 11.5px/1.45 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.01em;
  }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer }
  button:disabled { opacity: 0.4; pointer-events: none }
  button:focus-visible { outline: 2px solid var(--steel); outline-offset: 3px }

  .deck { display: flex; align-items: center; gap: 10px; padding: 12px 16px }
  .ctl {
    width: 36px; height: 36px; flex: none;
    border-radius: 999px; position: relative;
    background: var(--surface-2); border: 1.5px solid var(--line);
    display: grid; place-items: center;
  }
  .ctl:hover { border-color: var(--steel); box-shadow: 0 0 14px oklch(0.62 0.11 246 / 0.3) }
  .rec .glyph { width: 40%; height: 40%; border-radius: 999px; background: var(--crimson) }
  .rec.on { border-color: var(--crimson); box-shadow: 0 0 14px oklch(0.62 0.17 25 / 0.45), inset 0 0 8px oklch(0.62 0.17 25 / 0.2) }
  .rec.on .glyph { width: 34%; height: 34%; border-radius: 2.5px; background: var(--bone-solid); animation: xr-pulse 1.6s ease-in-out infinite }
  .rec.on.sweeping::before {
    content: ''; position: absolute; inset: -5px; border-radius: 999px;
    background: conic-gradient(var(--steel) var(--xr-sweep, 0%), oklch(0.28 0.02 253 / 0.5) 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
  }
  @keyframes xr-pulse { 50% { opacity: 0.35 } }
  @media (prefers-reduced-motion: reduce) {
    .rec.on .glyph, .key.on-rec .dot { animation: none !important }
  }
  .play svg { width: 46%; height: 46%; margin-left: 2px }
  .play svg path { fill: none; stroke: var(--muted); stroke-width: 1.7; stroke-linejoin: round }
  .play:hover svg path { stroke: var(--bone) }
  .play.on { border-color: var(--steel); background: oklch(0.62 0.11 246 / 0.12); box-shadow: 0 0 14px oklch(0.62 0.11 246 / 0.5), inset 0 0 10px oklch(0.62 0.11 246 / 0.25) }
  .play.on svg path { fill: var(--bone-solid); stroke: var(--bone-solid); filter: drop-shadow(0 0 4px var(--steel)) }

  .tick { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; font-size: 10.5px; color: var(--muted) }
  .tick .em { color: var(--bone) }
  .tick .live { color: var(--crimson) }
  .tick .lit { color: var(--steel) }
  .tick .err { color: var(--crimson) }
  .tick .ok { color: var(--steel) }
  .wordmark {
    width: 56px; height: 28px; flex: none;
    background: url('${WORDMARK_URI}') center / contain no-repeat;
  }

  .hr { height: 1px; background: linear-gradient(90deg, transparent, var(--line) 15%, var(--line) 85%, transparent) }

  .foot { padding: 0 16px 12px }
  .card {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border: 1px solid var(--line); border-radius: 3px;
    background: oklch(0.17 0.02 252 / 0.55);
    box-shadow: inset 0 0 10px oklch(0.62 0.11 246 / 0.05);
    text-decoration: none; color: inherit;
  }
  .card .txt { font-size: 10.5px; line-height: 1.5; color: var(--muted) }
  .card .txt b { color: var(--bone-solid); display: block }
  .card.err { border-color: oklch(0.62 0.17 25 / 0.4) }
  .card.err .txt b { color: var(--crimson) }
  .card.promo {
    border-color: oklch(0.62 0.11 246 / 0.45);
    background: oklch(0.62 0.11 246 / 0.07);
    box-shadow: 0 0 12px oklch(0.62 0.11 246 / 0.15), inset 0 0 10px oklch(0.62 0.11 246 / 0.08);
    cursor: pointer;
  }
  .card.promo svg { width: 24px; height: 24px; flex: none; stroke: var(--steel); fill: none; stroke-width: 1.5; filter: drop-shadow(0 0 4px oklch(0.62 0.11 246 / 0.5)) }
  .card.promo .txt { color: var(--bone) }
  .card.promo .txt b { color: var(--steel) }
  .warnline { padding: 0 16px 10px; font-size: 10px; color: var(--crimson) }

  .plates-line {
    display: flex; align-items: center; gap: 6px; width: 100%;
    color: var(--muted); font-size: 10.5px; text-align: left;
    padding: 8px 16px;
  }
  .plates-line:hover { color: var(--bone) }
  .plates-line .n { color: var(--bone) }
  .plates-line .em { color: var(--bone) }
  .plates-line .dim { color: oklch(0.69 0.02 251 / 0.7) }
  .plates-line .gap { color: var(--crimson) }
  .plates-line .chev { margin-left: auto }

  .plates { max-height: 236px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent }
  .plate { padding: 8px 16px; border-top: 1px solid oklch(0.28 0.02 253 / 0.35) }
  .plate:first-child { border-top: 0 }
  .plate:hover, .plate:focus-visible { background: oklch(0.17 0.02 252 / 0.5); box-shadow: inset 2px 0 0 var(--steel); outline: none }
  .plate .top { display: flex; align-items: center; gap: 8px }
  .plate .name { color: var(--bone-solid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .plate .badge { font-size: 10px; color: var(--muted); flex: none }
  .plate .badge.fx { color: var(--steel) }
  .plate .badge.warn { color: var(--crimson) }
  .plate .spacer { flex: 1 }
  .plate .views { color: var(--muted); font-size: 10px }
  .plate.stitch { opacity: 0.65 }
  .plate.unmounted { opacity: 0.5 }
  .plate.unmounted:hover { background: none; box-shadow: none }

  .keys { display: inline-flex; gap: 3px; flex: none }
  .key {
    width: 24px; height: 17px; border-radius: 3px;
    border: 1px solid var(--line);
    background: linear-gradient(oklch(0.21 0.02 252), oklch(0.15 0.02 253));
    box-shadow: 0 1px 1px oklch(0.05 0.01 256 / 0.6), inset 0 1px 0 oklch(0.35 0.02 253 / 0.5);
    display: grid; place-items: center;
  }
  .key:hover { border-color: var(--steel) }
  .key:active { box-shadow: inset 0 1px 2px oklch(0.05 0.01 256 / 0.8) }
  .key .dot { width: 5px; height: 5px; border-radius: 999px; background: var(--crimson); opacity: 0.75 }
  .key svg { width: 8px; height: 8px; margin-left: 1px }
  .key svg path { fill: none; stroke: var(--muted); stroke-width: 2.2; stroke-linejoin: round }
  .key.on-rec { border-color: var(--crimson); box-shadow: 0 0 8px oklch(0.62 0.17 25 / 0.4), inset 0 1px 2px oklch(0.05 0.01 256 / 0.8) }
  .key.on-rec .dot { opacity: 1; animation: xr-pulse 1.6s infinite }
  .key.on-play { border-color: var(--steel); box-shadow: 0 0 8px oklch(0.62 0.11 246 / 0.45), inset 0 1px 2px oklch(0.05 0.01 256 / 0.8); background: oklch(0.62 0.11 246 / 0.14) }
  .key.on-play svg path { fill: var(--bone-solid); stroke: var(--bone-solid) }

  .segs { display: flex; margin-top: 6px }
  .seg {
    flex: 1; padding: 1.5px 4px; text-align: center; white-space: nowrap;
    font-size: 9px; color: var(--muted);
    border: 1px dashed var(--line); border-left-width: 0;
  }
  .seg:first-child { border-left-width: 1px; border-radius: 3px 0 0 3px }
  .seg:last-child { border-radius: 0 3px 3px 0 }
  .seg.c { border-style: solid; color: var(--steel); border-color: oklch(0.62 0.11 246 / 0.45); background: oklch(0.62 0.11 246 / 0.10) }
  .seg.f { border-style: solid; color: var(--bone-solid); border-color: var(--steel); background: oklch(0.62 0.11 246 / 0.16); box-shadow: 0 0 7px oklch(0.62 0.11 246 / 0.35) }

  .note { margin-top: 4px; font-size: 10px; color: var(--muted); line-height: 1.5 }
  .note.err { color: var(--crimson) }

  .disk-label {
    padding: 7px 16px 3px; font-size: 9.5px; letter-spacing: 0.06em;
    text-transform: uppercase; color: oklch(0.69 0.02 251 / 0.7);
    border-top: 1px solid oklch(0.28 0.02 253 / 0.35);
  }

  .replay-line { display: flex; align-items: center; gap: 8px; padding: 8px 16px; color: var(--muted); font-size: 10.5px }
  .replay-line .spacer { flex: 1 }
  .switch { width: 26px; height: 14px; border-radius: 999px; border: 1px solid var(--line); position: relative; flex: none }
  .switch::after { content: ''; position: absolute; top: 1px; left: 1px; width: 10px; height: 10px; border-radius: 999px; background: var(--muted) }
  .switch.on { border-color: var(--steel) }
  .switch.on::after { left: auto; right: 1px; background: var(--steel); box-shadow: 0 0 6px var(--steel) }
`

export function installXrayHud(): HudHandle {
  const hook = globalThis.__XRAY__
  if (!hook || typeof document === 'undefined') {
    console.warn('[xray] HUD not installed: the dev client is not running.')
    return { dispose() {} }
  }
  const host = document.createElement('div')
  host.setAttribute('data-xray-hud', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = STYLE
  shadow.append(style)
  const dispose = render(() => <Hud hook={hook} />, shadow)
  if (document.body) document.body.append(host)
  else document.addEventListener('DOMContentLoaded', () => document.body.append(host))
  return {
    dispose() {
      dispose()
      host.remove()
    },
  }
}
