/**
 * Branded email layout, section 6.1.
 *
 * Table-based with inline CSS because Outlook's Word rendering engine ignores
 * flexbox, grid and most of <style>. The generator supplies only the inner
 * body copy; the header, button, footer and structure are applied here so
 * branding cannot be altered by model output.
 */

export const BRAND = {
  red: "#C8102E",
  black: "#1A1A1A",
  bodyText: "#333333",
  muted: "#6B6B6B",
  border: "#E4E4E4",
  pageBg: "#F4F4F4",
  white: "#FFFFFF",
  containerWidth: 620,
} as const;

export interface EmailRenderInput {
  subject: string;
  previewText: string | null;
  salutation: string;
  /** Inner body HTML from generation, already validated and sanitized. */
  bodyHtml: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
  companyName: string;
  sender: { name: string; email: string; phone: string | null; website: string | null };
  /** Absolute URL on the application's own asset domain. Never hot-linked. */
  alamLogoUrl: string | null;
  /**
   * The managing agent's mark, shown as a footer credit. Section 6 fixes the
   * primary sender brand as ALAM Business Center, so this never appears in the
   * header — the recipient must be in no doubt whose property this is.
   */
  agentLogoUrl?: string | null;
  agentName?: string;
  /** Optional approved building image (section 6.1). */
  heroImageUrl?: string | null;
  heroAlt?: string;
  /** Only set when the asset is approved; otherwise the name renders as text. */
  recipientLogoUrl: string | null;
  propertyAddress: string;
  unsubscribeUrl: string;
  isTest?: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Strips anything not permitted in an email body. The validator already
 * rejects unsafe output, but rendering is the last gate before a message is
 * hashed and approved, so it re-checks rather than trusting an earlier pass.
 */
export function sanitizeBodyHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form|input|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form|input|base)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>]*\2/gi, '$1="#"');
}

export function renderEmailHtml(input: EmailRenderInput): string {
  const {
    subject, previewText, salutation, ctaLabel, ctaUrl, companyName,
    sender, alamLogoUrl, recipientLogoUrl, propertyAddress, unsubscribeUrl, isTest,
  } = input;

  const body = sanitizeBodyHtml(input.bodyHtml);
  const W = BRAND.containerWidth;

  // The approved mark is served at 2x (360 px) and displayed at 180 px so it
  // stays sharp on high-density screens. width/height are set explicitly
  // because Outlook ignores CSS sizing on images.
  const header = alamLogoUrl
    ? `<img src="${esc(alamLogoUrl)}" width="180" height="107" alt="ALAM Business Center" style="display:block;border:0;width:180px;height:auto;">`
    : `<div style="font:700 20px/1.2 Georgia,'Times New Roman',serif;color:${BRAND.black};">ALAM Business Center</div>`;

  // Section 6: recipient branding is a discreet "Prepared for" line and must
  // never read as endorsement. Text fallback when no approved logo exists.
  const preparedFor = recipientLogoUrl
    ? `<img src="${esc(recipientLogoUrl)}" height="28" alt="${esc(companyName)}" style="display:block;border:0;max-height:28px;width:auto;">`
    : `<span style="font:600 14px/1.4 Arial,Helvetica,sans-serif;color:${BRAND.black};">${esc(companyName)}</span>`;

  // Section 6 again: the agent is credited, not co-branded. It sits below the
  // rule, at a smaller weight than the ALAM footer block, and says plainly
  // what the relationship is.
  const agentName = input.agentName ?? "Bright Properties";
  const agentCredit = input.agentLogoUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${BRAND.border};padding-top:12px;">
        <tr>
          <td style="font:400 11px/1.4 Arial,Helvetica,sans-serif;color:${BRAND.muted};letter-spacing:.06em;text-transform:uppercase;padding-bottom:6px;">Leasing managed by</td>
        </tr>
        <tr>
          <td><img src="${esc(input.agentLogoUrl)}" width="140" height="63" alt="${esc(agentName)}" style="display:block;border:0;width:140px;height:auto;"></td>
        </tr>
      </table>`
    : `<p style="margin:12px 0 0;padding-top:12px;border-top:1px solid ${BRAND.border};font:400 12px/1.5 Arial,Helvetica,sans-serif;color:${BRAND.muted};">
        Leasing managed by <strong style="color:${BRAND.black};">${esc(agentName)}</strong>.
      </p>`;

  /*
   * Hero, section 6.1. Served at 2x and displayed at the container width.
   * The alt text says "architectural render" rather than describing it as a
   * photograph: Phase One is a development, and an image that reads as a
   * finished building would imply something the property facts do not claim.
   */
  const hero = input.heroImageUrl
    ? `<tr><td style="padding:0;">
        <img src="${esc(input.heroImageUrl)}" width="${W}" alt="${esc(input.heroAlt ?? "Architectural render of ALAM Business Center, Fifth Street, Industrial Area, Kampala")}" style="display:block;border:0;width:100%;max-width:${W}px;height:auto;">
      </td></tr>`
    : "";

  const testBanner = isTest
    ? `<tr><td style="background:${BRAND.black};color:#FFD400;padding:10px 28px;font:700 13px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;">TEST MESSAGE — NOT SENT TO A PROSPECT</td></tr>`
    : "";

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  @media screen and (max-width:640px){
    .wrap{width:100% !important;}
    .pad{padding-left:20px !important;padding-right:20px !important;}
    .cta a{display:block !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(previewText ?? "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="${W}" cellpadding="0" cellspacing="0" border="0" style="width:${W}px;max-width:${W}px;background:${BRAND.white};border:1px solid ${BRAND.border};">
  ${testBanner}
  <tr><td class="pad" style="padding:28px 32px 20px;border-bottom:3px solid ${BRAND.red};">${header}</td></tr>
  ${hero}

  <tr><td class="pad" style="padding:22px 32px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="font:400 11px/1.4 Arial,Helvetica,sans-serif;color:${BRAND.muted};letter-spacing:.1em;text-transform:uppercase;padding-bottom:6px;">Prepared for</td>
      </tr>
      <tr><td>${preparedFor}</td></tr>
    </table>
  </td></tr>

  <tr><td class="pad" style="padding:22px 32px 0;font:400 16px/1.65 Arial,Helvetica,sans-serif;color:${BRAND.bodyText};">
    <p style="margin:0 0 16px;">${esc(salutation)},</p>
    ${body}
  </td></tr>

  <tr><td class="pad" align="left" style="padding:26px 32px 8px;">
    <table role="presentation" class="cta" cellpadding="0" cellspacing="0" border="0">
      <tr><td bgcolor="${BRAND.red}" style="border-radius:2px;">
        <a href="${esc(ctaUrl)}" style="display:inline-block;padding:14px 26px;font:700 16px/1 Arial,Helvetica,sans-serif;color:#FFFFFF;text-decoration:none;">${esc(ctaLabel)}</a>
      </td></tr>
    </table>
  </td></tr>

  <tr><td class="pad" style="padding:22px 32px 28px;font:400 16px/1.65 Arial,Helvetica,sans-serif;color:${BRAND.bodyText};">
    <p style="margin:0 0 4px;">Kind regards,</p>
    <p style="margin:0;font-size:15px;">
      <strong style="color:${BRAND.black};">${esc(sender.name)}</strong>
      <span style="color:${BRAND.muted};"> | </span>ALAM Business Center${
        sender.phone ? `<span style="color:${BRAND.muted};"> | </span>${esc(sender.phone)}` : ""
      }<span style="color:${BRAND.muted};"> | </span><a href="mailto:${esc(sender.email)}" style="color:${BRAND.bodyText};">${esc(sender.email)}</a>
    </p>
  </td></tr>

  <tr><td class="pad" style="padding:18px 32px 26px;background:#FAFAFA;border-top:1px solid ${BRAND.border};font:400 13px/1.6 Arial,Helvetica,sans-serif;color:${BRAND.muted};">
    <p style="margin:0 0 6px;color:${BRAND.black};font-weight:700;">ALAM Business Center</p>
    <p style="margin:0 0 4px;">${esc(propertyAddress)}</p>
    <p style="margin:0 0 10px;">
      ${sender.phone ? `${esc(sender.phone)} &nbsp;|&nbsp; ` : ""}
      <a href="mailto:${esc(sender.email)}" style="color:${BRAND.muted};">${esc(sender.email)}</a>
      ${sender.website ? ` &nbsp;|&nbsp; <a href="${esc(sender.website)}" style="color:${BRAND.muted};">${esc(sender.website)}</a>` : ""}
    </p>
    <p style="margin:0 0 14px;">
      You received this business enquiry because ${esc(companyName)} is listed in the Uganda Manufacturers Association directory.
      <a href="${esc(unsubscribeUrl)}" style="color:${BRAND.red};">Tell us not to contact you again</a>.
    </p>
    ${agentCredit}
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Section 6.1 fallback: same facts, same CTA, no markup. */
export function renderEmailText(input: EmailRenderInput): string {
  const { salutation, bodyText, ctaLabel, ctaUrl, sender, companyName,
    propertyAddress, unsubscribeUrl, isTest } = input;

  return [
    isTest ? "*** TEST MESSAGE - NOT SENT TO A PROSPECT ***\n" : "",
    `${salutation},`,
    "",
    bodyText.trim(),
    "",
    `${ctaLabel}: ${ctaUrl}`,
    "",
    "Kind regards,",
    [sender.name, "ALAM Business Center", sender.phone, sender.email]
      .filter(Boolean).join(" | "),
    "",
    "--",
    "ALAM Business Center",
    propertyAddress,
    [sender.phone, sender.email, sender.website].filter(Boolean).join(" | "),
    "",
    `You received this business enquiry because ${companyName} is listed in the Uganda Manufacturers Association directory.`,
    `To be removed from this list: ${unsubscribeUrl}`,
    "",
    `Leasing managed by ${input.agentName ?? "Bright Properties"}.`,
  ].filter((l) => l !== "").join("\n");
}
