/**
 * The absolute base URL for this deployment.
 *
 * Emails carry absolute URLs — a mail client has no origin to resolve a
 * relative path against — and those URLs are baked into the draft's hashed
 * content. So getting this wrong does not produce a warning, it produces a
 * broken logo in a message somebody already approved.
 *
 * It resolves from the explicit setting first, then from the values Vercel
 * injects, so a missing or malformed NEXT_PUBLIC_APP_URL cannot silently
 * degrade to a relative path.
 */

function clean(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function appBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit && /^https?:\/\/\S+$/.test(explicit)) return clean(explicit);

  // Vercel sets this to the project's stable production domain.
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${clean(prod)}`;

  // Per-deployment URL. Correct for previews, still absolute.
  const deployment = process.env.VERCEL_URL?.trim();
  if (deployment) return `https://${clean(deployment)}`;

  return "http://localhost:3000";
}

/**
 * Guards generation. A draft is immutable once written, so a localhost URL
 * baked into a production draft can only be fixed by regenerating it — better
 * to refuse up front and say why.
 */
export function assertUsableForEmail(): void {
  const base = appBaseUrl();

  if (!/^https?:\/\//.test(base)) {
    throw new Error(
      `The application base URL ("${base}") is not absolute. Emails need absolute URLs. Set NEXT_PUBLIC_APP_URL.`,
    );
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/i.test(base);
  if (isLocal && process.env.NODE_ENV === "production") {
    throw new Error(
      `The application base URL is "${base}", which recipients cannot reach. ` +
      "Set NEXT_PUBLIC_APP_URL to the public address of this deployment before generating drafts.",
    );
  }
}
