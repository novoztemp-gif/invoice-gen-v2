import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit"],
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
    middlewareClientMaxBodySize: "100mb",
  },
};

export default nextConfig;
