import type { NextConfig } from "next";

const basePath = process.env.GITHUB_PAGES === "true" ? "/traice-sdk" : "";

const nextConfig: NextConfig = {
  assetPrefix: basePath || undefined,
  basePath: basePath || undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  output: "export",
  reactStrictMode: true,
};

export default nextConfig;
