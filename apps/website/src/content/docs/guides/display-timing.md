---
title: Display timing
description: When the skeleton appears, how long it stays, and how it swaps.
---

A skeleton can flicker in two ways. On a fast load it flashes for a few frames
and vanishes. On a load that resolves just after it appeared, it blinks away
the moment you noticed it. Both read as glitches, and xray guards against both
by default.

The skeleton always mounts immediately, so layout is reserved from the first
frame and nothing shifts. What the timing tokens control is its _visual_
exposure.

## The three tokens

| token                               | default | role                                                                                  |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `--xr-skeleton-delay`               | `250ms` | grace period before the skeleton becomes visible                                      |
| `--xr-skeleton-min-duration`        | `600ms` | minimum visible time once shown, measured from the moment the skeleton became visible |
| `--xr-skeleton-transition-duration` | `150ms` | the reveal and swap fade                                                              |

- **Delay.** The skeleton stays invisible for the grace period. Resolve inside
  it and the skeleton is never seen; the fast load feels instant.
- **Minimum duration.** Once the skeleton is visible, it stays long enough to
  read as intentional. Content arriving inside the window waits for the floor;
  content arriving later swaps immediately. Latency is only ever added in the
  flash window, never on an ordinarily slow load.
- **Fade.** The swap crossfades over this duration.

## Tune them

All three are CSS custom properties, set and cascaded like every other
[theming token](/guides/theming/): no props, no JS config.

```css
/* global */
:root {
  --xr-skeleton-delay: 150ms;
  --xr-skeleton-min-duration: 400ms;
}

/* per-plate — scope by the plate name on its root */
[data-xr-root='news-feed'] {
  --xr-skeleton-delay: 0ms;
}
```

Set `--xr-skeleton-min-duration: 0ms` to disable the hold entirely; the swap
then fires synchronously the moment content is ready.

## Nested skeletons reveal instantly

When a parent skeleton resolves and a nested `<Skeleton>` takes over a Stitch
that was already on screen, that child is a **Continuation** of something the user
is already looking at. It reveals instantly, with no delay and no fade, instead
of disappearing for a grace period it already paid. This is automatic; there is
nothing to configure.

## Accessibility

Under `prefers-reduced-motion: reduce`, the fade collapses to an instant swap
and the pulse animation stops. The delay and minimum duration stay: they
prevent flashing, not motion.
