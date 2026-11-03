import type { NextConfig } from "next";

const backendOrigin = (
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://devpilot-backend-iso1.onrender.com"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["lucide-react", "react-icons", "date-fns", "recharts"],
  },
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: `${backendOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
