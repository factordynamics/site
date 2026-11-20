/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  async rewrites() {
    return [
      { source: "/copybook", destination: "/copybook/index.html" },
      { source: "/copybook/", destination: "/copybook/index.html" }
    ];
  }
};

export default nextConfig;
