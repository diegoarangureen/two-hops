import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The graph is read from disk at request time; make sure it travels with the server bundle.
  outputFileTracingIncludes: {
    "/*": ["./data/graph.json"],
  },
  // Do not let `next dev` write an AGENTS.md into the repo.
  agentRules: false,
};

export default nextConfig;
