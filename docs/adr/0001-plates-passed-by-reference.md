---
status: accepted
---

# Plates are passed to one `<Skeleton>` by reference, not resolved by name

A component imports its plate from `virtual:xray/plates/<name>` and passes it to a single `<Skeleton plate={plate}>`. The same component renders the skeleton (no real children) and, in dev, captures the real subtree (when children are present). The plate carries its own identity, so no `name` string is wired across call sites.

boneyard's model, a global `registerBones()` registry keyed by a `name` string, was rejected for two reasons: it bundles every plate up front (no per-chunk code-splitting, a hard requirement), and it makes the render↔capture link a stringly-typed match that can drift or typo with no compiler check. Passing the plate by reference gives per-chunk bundling for free and lets module resolution verify the wiring.

The accepted trade-off: `<Skeleton>{realContent}</Skeleton>` renders the real content (capturing it in dev), so the component's name doesn't literally describe that branch.
