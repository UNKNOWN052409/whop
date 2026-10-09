import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Standalone output keeps the serverless bundle small on Vercel.
  output: 'standalone',

  // Security headers (spec §23). HSTS is intentionally NOT set here: on a
  // preview deployment this would pin the domain to HTTPS and, if the preview
  // host is ever served over HTTP, break it. It is set in vercel.json instead.
  //
  // THE CACHE-CLASS CONTRACT (spec §6, §16, §29) lives in vercel.json `headers`,
  // because that is the layer Vercel applies to static files served off the CDN
  // filesystem, which is where the bandwidth actually is. Documented here so
  // there is exactly one place to read the whole contract; vercel.json is plain
  // JSON and cannot carry the reasoning.
  //
  //   /_next/static/*  → public, max-age=31536000, immutable
  //       Content-hashed: the filename changes when the bytes change, so there is
  //       never a reason to revalidate. `immutable` additionally tells the
  //       browser to skip revalidation on reload, which is the entire win. Next
  //       already emits this exact value and Vercel's immutable store covers
  //       /_next/static/immutable/, so restating it here costs nothing and keeps
  //       the guarantee independent of framework detection.
  //
  //   /products/*      → public, max-age=86400, s-maxage=604800,
  //                      stale-while-revalidate=86400
  //       public/ files are NOT content-hashed. `public/products/amazon-5.png`
  //       keeps its name across every deploy that does not touch it, so an
  //       `immutable` year here would be a live bug the moment the file is
  //       replaced: a year of stale product art, with no way to purge it client
  //       side. Long-but-bounded instead — 1 day in the browser, 7 days at the
  //       CDN, and one more day of serving-while-revalidating so a revalidation
  //       miss never blocks a shopper. No `immutable` here, deliberately.
  //       (Per Vercel, s-maxage and stale-while-revalidate are stripped before
  //       the response reaches the browser when no CDN-Cache-Control is set, so
  //       the shopper sees exactly max-age=86400.)
  //
  //   /api/*           → no-store, max-age=0, must-revalidate
  //       Payment state, order state, session cookies and auth decisions. Never
  //       cacheable, at any layer, ever.
  //
  //   /admin/*         → no-store (below, plus src/middleware.ts).
  //
  //   HTML documents   → nothing here on purpose. Every page in the app is
  //       `export const dynamic = 'force-dynamic'` (src/app/page.tsx,
  //       product/[slug], checkout, admin/*), so Next.js already emits
  //       `private, no-cache, no-store, max-age=0, must-revalidate` for all of
  //       them. Adding a Cache-Control for HTML here could only override a
  //       correct decision with an incorrect one — and a stale storefront price
  //       is a correctness incident on a payment platform, not a latency win.
  //       The authoritative price is re-read and snapshotted inside
  //       POST /api/checkout regardless of what any cache did; the 30s catalog
  //       TTL in src/catalog/cache-control.ts bounds what a shopper can SEE,
  //       never what they are CHARGED.
  //
  // INVARIANT: no two Cache-Control rules above can match the same pathname.
  // `/_next/static/` and `/products/` are disjoint from `/api/`, so rule
  // ordering never decides a conflict. If you ever add a rule, check it against
  // `/api/(.*)` before you check it against anything else — a cacheable rule
  // that can match an API route is a payment incident.
  //
  // COMPRESSION: Vercel compresses at the edge automatically and nothing here
  // disables it (no `compress: false`). No rule in this file or in vercel.json
  // sets Content-Encoding, deliberately: PNG and WebP are already compressed,
  // and gzipping them again costs origin CPU, inflates transfer and breaks
  // clients that would have decoded the original.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next.js injects inline bootstrap scripts; 'unsafe-inline' is
              // required for the App Router runtime. Script-src stays closed
              // otherwise and no external origins are trusted.
              "script-src 'self' 'unsafe-inline'",
              // Stripe/Whop checkout is reached by top-level navigation, not
              // framed, so frame-src can stay closed.
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
      {
        // Admin must never be indexed or embedded.
        source: '/admin/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
    ];
  },

  // Prisma must not be bundled by the server compiler.
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'nodemailer'],

  experimental: {
    // Stream admin lists and catalog queries.
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;