import type { NextConfig } from "next";

const pagesBuild = process.env.BUILD_GITHUB_PAGES === "1";
const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const basePath = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  ...(pagesBuild
    ? {
        output: "export" as const,
        trailingSlash: true,
        basePath,
      }
    : {}),
};

export default nextConfig;
