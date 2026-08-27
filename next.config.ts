import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * pdfjs-dist must be required from node_modules at runtime rather than
   * bundled. Bundling rewrites the dynamic import it uses to load
   * `pdf.worker.mjs`, so the worker resolves to a path inside `.next` that
   * does not exist and every upload fails with "Setting up fake worker
   * failed". Extraction worked from the CLI scripts, which are not bundled,
   * which is why this only ever showed up through the web upload.
   */
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
