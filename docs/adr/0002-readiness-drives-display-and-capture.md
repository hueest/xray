---
status: accepted
---

# Readiness drives both display and capture; Suspense is opt-in

A `<Skeleton>` shows the skeleton until its content is _ready_, then renders the content and, in dev, captures it. Readiness composes two independent axes: `loading` gates whether the children **mount** (data readiness: skeleton while `loading`; children never mount without data), and opt-in `suspense` catches the **mounted** children while they resolve (a lazy code chunk, or the content itself once it data-suspends), using the same skeleton as the fallback. There is no separate `capture` trigger: capturing is "content became ready, in dev." A `loading` and a `capture` prop would be the same axis spelled twice.

**Suspense is opt-in, not the default.** The first target (the production React SPA used as the dogfood) loads data with loading booleans (`useQuery` → `{ data, loading }`) and has no data-suspense; it only suspends on lazy _code_ chunks, a separate phase from the data-loading that component skeletons cover. A suspense-default `<Skeleton>` wrapping non-suspending content would never show the skeleton during data load, silently breaking every non-suspending data layer (Apollo/urql without suspense, `fetch`+`useState`, etc.). Once an app adopts data-suspense, `suspense` can be enabled per call site or via a plugin-level default; the library default must stay compatible with loading-boolean fetching.

## The composed model (amended 2026-07-01)

The original decision framed readiness as having exactly one source per mode — `loading` in non-suspense mode, the boundary resolving in `suspense` mode. That conflated two _different_ async axes that can be live at the same time:

- **Data readiness** — the `loading` boolean (old-Apollo `useQuery`), or the content self-suspending once the app has data-suspense. This is the axis the original decision reasons about.
- **Code readiness** — a `React.lazy` chunk resolving. Only expressible via Suspense, independent of data, and it coexists with a loading-boolean data layer (a lazy component that also fetches with `useQuery`).

The original implementation let `suspense` short-circuit past `loading` (the `if (suspense)` branch returned before the `if (loading)` check), so a call site with both phases — `<Skeleton plate suspense loading={dataLoading}>` around a lazy component with old-Apollo data — never showed the data-loading skeleton; only the fast, usually cached code-chunk fallback rendered. The dogfood app's dashboard router hit exactly this: its skeletons were visible via Light Box but never on a real load.

**Corrected model: the two props gate different things and compose.**

- `loading` gates whether the children **mount** (data readiness). While `loading`, the skeleton shows and children are not mounted, so they never run without data — honored in _both_ modes.
- `suspense` catches the **mounted** children while they resolve (a lazy code chunk; data-suspense where the app has it), using the same skeleton as the fallback.

Implementation: `suspense` mode always renders `<Suspense fallback={skeleton}>` and drives the data-loading phase through an internal suspender. `SuspendWhileLoading` throws a never-settling promise while `loading`, so the skeleton is the single Suspense fallback across both the data-loading phase (the suspender) and the lazy-code-chunk phase (the content itself suspending). One fallback DOM node the whole time means no unmount/remount and no flicker between the phases (returning a top-level `skeleton` for the data phase and a Suspense-fallback `skeleton` for the chunk phase puts them at different tree positions, which remounts). While the suspender throws, the content sibling is never committed, preserving "children never render without data." React recovers when the parent re-renders with `loading=false`; a prop change drives the retry, so the promise need not settle. Non-suspense mode is untouched: `if (showSkeleton) return skeleton; else content`. A pure-suspense call site passes no `loading`, so the suspender never throws.
