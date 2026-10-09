import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Standalone output keeps the serverless bundle small on Vercel.
  output: 'standalone',

  // Security headers (spec §23). HSTS is intentionally NOT set here: on a
  // preview deployment this would pin the domain to HTTPS and, if the preview
  // host is ever served over HTTP, break it. It is set in vercel.json instead.
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