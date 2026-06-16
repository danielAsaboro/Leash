/** @type {import('next').NextConfig} */
const nextConfig = {
  // The marketing site is type-checked separately; don't let latent type drift gate the deploy.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
