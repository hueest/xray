---
title: Nested skeletons
description: Stitches compose skeletons that capture independently, hold the layout, and reveal as one.
---

Nesting is automatic. Put a `<Skeleton>` inside a component that another
`<Skeleton>` wraps, and capture handles the rest: the parent does not descend
into the child's subtree. It records a **Stitch** — a reference to the child
Plate by name — and the child captures on its own.

```tsx
// ProductPage.tsx — the parent owns its own Plate
import { Skeleton } from '@hueest/xray/react'
import plate from 'virtual:xray/plates/product-page'

export function ProductPage({ productId }) {
  const { data: product, loading } = useProduct(productId)

  return (
    <Skeleton plate={plate} loading={loading}>
      <ProductHero product={product} />
      <ReviewsList productId={productId} />
    </Skeleton>
  )
}
```

```tsx
// ReviewsList.tsx — the child owns its own Plate and its own loading state
import { Skeleton } from '@hueest/xray/react'
import plate from 'virtual:xray/plates/reviews-list'

export function ReviewsList({ productId }) {
  const { data: reviews, loading } = useReviews(productId)

  return (
    <Skeleton plate={plate} loading={loading}>
      {reviews?.map((review) => (
        <Review key={review.id} review={review} />
      ))}
    </Skeleton>
  )
}
```

The `product-page` Plate carries a Stitch named `reviews-list` where the child
sits. At render, the Stitch mounts the child Plate's skeleton inside the
parent's.

## What a Stitch buys

- **Independent captures.** Each region is captured, re-captured, and
  hot-swapped on its own. Re-capturing `reviews-list` updates every page that
  stitches it in; `product-page` is untouched.
- **Small Plates.** A parent stores its own structure plus a name per child,
  never a copy of the child. Capture size is bounded by composition, not depth.
- **Real code splitting.** The reference resolves as an import between plate
  modules, so a page's chunk carries only the Plates it actually uses.

A child that has never been captured renders a blank slot at its Stitch until
it is captured once. The HUD lists which Plates exist.

## The layout holds

Every skeleton occupies exactly the space its content will, so nested async
regions resolve in any order without pushing the page around. While the
product data loads, the parent's bones hold the frame — reviews included. When
the product arrives but reviews are still pending, the reviews region keeps
its shape while real content fills in around it. The result is near-zero
layout shift across the whole load sequence, however the requests race.

## One reveal

While the parent is loading, the stitched child inherits the parent's reveal:
parent and child bones fade in together, on one delay, as a single skeleton.

When the parent resolves and a child is still loading, the child's own
`<Skeleton>` takes over in place. That skeleton is a **Continuation** — it was
already on screen as a Stitch — so it reveals instantly, with no grace delay
and no second fade ([ADR 0020](https://github.com/hueest/xray/blob/main/docs/adr/0020-instant-reveal-for-stitch-continuations.md)).
The takeover from stitched bones to standalone skeleton to real content is
invisible; the user sees one region fill in, once.
