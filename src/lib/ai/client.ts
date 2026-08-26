import { env } from "@/lib/env";
import { SYSTEM_PROMPT, buildUserMessage, type GenerationInput } from "./prompt";
import {
  generationOutputSchema, GEMINI_RESPONSE_SCHEMA, type GenerationOutput,
} from "./schema";
import { shortCompanyName, buildSalutation, buildSubject } from "@/lib/naming";

export interface CompletionResult {
  output: GenerationOutput;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number };
  raw: string;
}

export class GenerationError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "GenerationError";
  }
}

/** Low temperature: this is a grounded extraction task, not a creative one. */
const TEMPERATURE = 0.2;
/**
 * Gemini 2.5 spends output tokens on internal reasoning before emitting
 * anything, so a budget sized for the visible answer truncates the JSON
 * mid-object. Thinking is switched off — this is low-temperature generation
 * from a supplied fact list, not a problem that benefits from deliberation —
 * and the ceiling is generous so a long products list cannot clip the reply.
 */
const GEMINI_MAX_TOKENS = 8000;
const TIMEOUT_MS = 60_000;

/**
 * Provider adapter. Call sites depend on this signature only, so swapping
 * one provider for another is a change here and nowhere else.
 */
export async function generateEmail(input: GenerationInput): Promise<CompletionResult> {
  switch (env.AI_PROVIDER) {
    case "gemini":
      return callGemini(input);
    case "stub":
      return callStub(input);
  }
}

/** Models sometimes wrap JSON in prose or a fenced block despite instructions. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    throw new GenerationError("Model did not return parseable JSON.", text.slice(0, 500));
  }
}

function parseOutput(raw: string): GenerationOutput {
  const json = extractJson(raw);
  const parsed = generationOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new GenerationError(
      "Model output did not match the required schema.",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return parsed.data;
}

/**
 * Rate limiting is routine on a free Gemini tier, and a whole batch failing
 * because one request arrived a second early is not a useful outcome. Retries
 * only on 429 and only a couple of times: everything else here is a decision
 * (no credit, bad key, wrong model) that retrying cannot change.
 */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 20_000;

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  attempt = 0,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();

    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RATE_LIMIT_BACKOFF_MS * (attempt + 1);
      console.warn(`[ai] rate limited, retrying in ${Math.round(waitMs / 1000)}s`);
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, waitMs));
      return postJson(url, headers, body, attempt + 1);
    }

    if (!res.ok) {
      // A bare status code sends whoever hit it to a search engine. These are
      // the failures that actually happen, so say what they mean and who can
      // fix them.
      const explained: Record<number, string> = {
        400: "The generation provider rejected the request as malformed. This usually means AI_MODEL names a model the key cannot use.",
        401: "Gemini rejected the API key. Check GEMINI_API_KEY.",
        402: "The Gemini account has no credit left. No draft was created and nothing was charged.",
        403: "The generation provider refused this request. The key may not have access to the configured model.",
        404: `The model "${env.AI_MODEL}" was not found at this provider. Check AI_MODEL.`,
        429: "The generation provider is rate limiting this account, and the request still failed after retrying. Free Gemini tiers allow only a few requests per minute; wait a minute, or generate drafts in smaller batches.",
      };
      throw new GenerationError(
        explained[res.status] ??
          `The generation provider returned an unexpected error (HTTP ${res.status}).`,
        text.slice(0, 500),
      );
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof GenerationError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new GenerationError(`Generation timed out after ${TIMEOUT_MS / 1000}s.`);
    }
    throw new GenerationError("Generation request failed.", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Google Gemini. Uses the API's native JSON mode rather than asking for JSON
 * in the prompt, so a malformed response is a provider fault rather than
 * something the parser has to rescue.
 */
async function callGemini(input: GenerationInput): Promise<CompletionResult> {
  if (!env.GEMINI_API_KEY) {
    throw new GenerationError("AI_PROVIDER is gemini but GEMINI_API_KEY is not set.");
  }

  const model = env.AI_MODEL;
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": env.GEMINI_API_KEY },
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: buildUserMessage(input) }] }],
      generationConfig: {
        temperature: TEMPERATURE,
        maxOutputTokens: GEMINI_MAX_TOKENS,
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
      // The task is business correspondence grounded in a public directory.
      // Default thresholds occasionally flag ordinary commercial language, and
      // a blocked response here is a failed draft, not a safety win.
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
    },
  );

  const candidate = data?.candidates?.[0];

  // A refusal arrives as a 200 with no content, so it has to be detected
  // rather than assumed away.
  if (!candidate || candidate.finishReason === "SAFETY") {
    throw new GenerationError(
      "The generation provider blocked this request on safety grounds. Check the prospect's directory text for anything unusual.",
      data?.promptFeedback ?? candidate?.safetyRatings,
    );
  }
  if (candidate.finishReason === "MAX_TOKENS") {
    throw new GenerationError(
      "The model hit its output limit before finishing the JSON. Raise GEMINI_MAX_TOKENS or shorten the campaign word limit.",
    );
  }

  const raw = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
  if (!raw) {
    throw new GenerationError("Provider response had no text content.", data);
  }

  return {
    output: parseOutput(raw),
    model: data?.modelVersion ?? model,
    usage: {
      inputTokens: data?.usageMetadata?.promptTokenCount,
      outputTokens: data?.usageMetadata?.candidatesTokenCount,
    },
    raw,
  };
}

/**
 * Deterministic fixture. Lets the whole approval workflow be exercised, and
 * tested in CI, without spending tokens or depending on network access.
 * It always flags manual review so a stub draft can never be mistaken for a
 * grounded one during a demo.
 */
async function callStub(input: GenerationInput): Promise<CompletionResult> {
  const p = input.prospect;
  const c = input.campaign;
  const services = p.products_services ?? p.sector ?? "its stated line of business";
  const short = shortCompanyName(p.company_name);
  const { salutation } = buildSalutation(p.contact_name, p.company_name);

  // Mirrors the approved reference email in section 3 of the proposal deck.
  const opening =
    `I am reaching out from ALAM Business Center after noting that ${short} supplies ${lowerFirst(services)}.`;
  const paragraphs = [
    opening,
    `We believe your business may be a strong fit for ${c.recommended_pitch.toLowerCase()} at our new commercial development on Fifth Street in Kampala's Industrial Area.`,
    "Available units are approximately 570-660 m², with an indicative rent of USD 15 per m² per month, subject to availability and final lease terms.",
    "Would you be available for a private site visit or a short call to review the floor plan?",
  ];

  const output: GenerationOutput = {
    subject: buildSubject(p.company_name, c.target_floor, c.segment ?? "unclassified"),
    preview_text: `Space at ALAM Business Center, Fifth Street, matched to ${short}.`,
    salutation,
    opening_personalization: opening,
    body_html: paragraphs.map((t) => `<p>${escapeHtml(t)}</p>`).join("\n"),
    body_text: paragraphs.join("\n\n"),
    primary_cta_label: c.cta_label,
    primary_cta_url: c.cta_url,
    facts_used: input.property.approved_facts.slice(0, 4).map((f) => f.key),
    evidence_ids: input.evidence.map((e) => e.id),
    risk_flags: ["stub_generation"],
    needs_manual_review: true,
    manual_review_reason:
      "Produced by the offline stub generator (AI_PROVIDER=stub). Content is template-filled, not model-grounded, and must be rewritten or regenerated before approval.",
  };

  return { output, model: "stub", usage: {}, raw: JSON.stringify(output) };
}

/** Keeps a directory phrase reading naturally mid-sentence. */
function lowerFirst(s: string): string {
  const t = s.trim();
  if (!t) return t;
  // Leave deliberate capitalization alone: "SUPPLY OF TYRES" is shouting, but
  // "Bajaj motorcycles" starts with a brand that must keep its capital.
  if (t === t.toUpperCase()) return t.toLowerCase();
  if (/^[A-Z][a-z]/.test(t) && !/^[A-Z][a-z]+\s[A-Z]/.test(t)) {
    return t.charAt(0).toLowerCase() + t.slice(1);
  }
  return t;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
