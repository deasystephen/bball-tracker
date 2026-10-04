import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lint and type-check run as their own scripts (`npm run lint`,
  // `npm run type-check`) and their own CI leg, "Lint and Type Check (web)".
  // The build only builds, so CI's "Test Web" job does not repeat them (#690).
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  async headers() {
    return [
      {
        // Apple requires Content-Type: application/json for AASA files.
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ];
  },
};

export default nextConfig;
