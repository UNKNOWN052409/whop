# Product artwork

Static catalog imagery served from `public/`. Every file here is referenced by
`imageUrl` in `prisma/seed.ts` and must exist: a path that 404s renders the
storefront placeholder instead of the artwork, and an OG crawler gets nothing.

## These are PLACEHOLDER ARTWORK, not supplier photography

The store resells gift cards through an authorized distributor. The distributor's
real product photography is licensed to the reseller account and is not
available in this repository, so nothing here was traced, scraped, or lifted
from a supplier feed. Each file is generic vector artwork rendered to PNG from
the design tokens in `src/app/globals.css`, and is labelled "Illustrative
artwork" in the corner of the image itself.

Replace them with the supplier's approved product images before launch. Keep the
same filenames and the seed needs no change.

| file | product | notes |
| --- | --- | --- |
| `redeem-1.png` | `$1 Digital Redeem Code` | generic store credit, blue tier |
| `redeem-2.png` | `$2 Digital Redeem Code` | generic store credit, cyan tier |
| `redeem-5.png` | `$5 Digital Redeem Code` | generic store credit, green tier |
| `redeem-10.png` | `$10 Digital Redeem Code` | generic store credit, amber tier |
| `amazon-5.png` | `Amazon.com Gift Card $5` | generic gift-card treatment, neutral palette |
| `amazon-10.png` | `Amazon.com Gift Card $10` | generic gift-card treatment, neutral palette |

Denominations differ by numeral, accent hue and a tier meter, so the four
redeem tiers stay distinguishable as thumbnails.

## On the Amazon SKUs

Amazon's wordmark, the smile arrow, the orange-and-navy trade dress and the
`amazon.com` type are trademarks. They are deliberately NOT reproduced here.

The two Amazon SKUs use the same neutral gift-card frame as the generic tiers
(cool grey accent, no brand colour, no logo) and the only place the brand
appears is the product's own descriptive name, set in body text, exactly as the
catalog record already states it: "Amazon.com Gift Card". That is nominative —
naming the product you are authorised to resell — not a claim to the mark.

If the distributor supplies approved Amazon artwork, prefer it. Do not
hand-draw a lookalike.
