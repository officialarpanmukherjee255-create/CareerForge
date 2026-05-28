import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["three"],
  async rewrites() {
    return [
      { source: "/resume-builder", destination: "/resume-builder/index.html" },
      { source: "/resume-analyzer", destination: "/resume-analyzer/index.html" },
      { source: "/cover-letter", destination: "/cover-letter/index.html" },
      { source: "/interviewer", destination: "/interviewer/index.html" },
      { source: "/job-listings", destination: "/job-listings/index.html" },
      { source: "/job-listings/job-detail", destination: "/job-listings/job-detail.html" },
      { source: "/leaderboard", destination: "/leaderboard/index.html" },
      { source: "/profile", destination: "/profile/index.html" },
    ];
  },
};

export default nextConfig;
