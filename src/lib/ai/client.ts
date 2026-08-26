import { env } from "@/lib/env";
import { appBaseUrl } from "@/lib/app-url";
import { SYSTEM_PROMPT, buildUserMessage, type GenerationInput } from "./prompt";
import { generationOutputSchema, type GenerationOutput } from "./schema";
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
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 60_000;

/**
 * Provider adapter. Call sites depend on this signature only, so swapping
 * OpenRouter for a direct Anthropic key is an env change, not a code change.
 */
export async function generateEmail(input: GenerationInput): Promise<CompletionResult> {
  switch (env.AI_PROVIDER) {
    case "openrouter":
      return callOpenRouter(input);
    case "anthropic":
      return callAnthropic(input);
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

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
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
    if (!res.ok) {
      // A bare status code sends whoever hit it to a search engine. These are
      // the failures that actually happen, so say what they mean and who can
      // fix them.
      const explained: Record<number, string> = {
        401: "The generation provider rejected the API key. Check OPENROUTER_API_KEY or ANTHROPIC_API_KEY.",
        402: "The generation provider has no credit left on this account. Top it up, or switch AI_PROVIDER to a provider that does. No draft was created and nothing was charged.",
        403: "The generation provider refused this request. The key may not have access to the configured model.",
        404: `The model "${env.AI_MODEL}" was not found at this provider. Check AI_MODEL.`,
        429: "The generation provider is rate limiting this account. Wait and try again.",
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

/** OpenAI-compatible chat completions endpoint. */
async function callOpenRouter(input: GenerationInput): Promise<CompletionResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new GenerationError("AI_PROVIDER is openrouter but OPENROUTER_API_KEY is not set.");
  }

  const data = await postJson(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "http-referer": appBaseUrl(),
      "x-title": "ALAM Lease Outreach",
    },
    {
      model: env.AI_MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(input) },
      ],
    },
  );

  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") {
    throw new GenerationError("Provider response had no message content.", data);
  }

  return {
    output: parseOutput(raw),
    model: data?.model ?? env.AI_MODEL,
    usage: {
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
    },
    raw,
  };
}

async function callAnthropic(input: GenerationInput): Promise<CompletionResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new GenerationError("AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set.");
  }

  const data = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    {
      model: env.AI_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildUserMessage(input) },
        // Prefilling the opening brace keeps the reply to bare JSON.
        { role: "assistant", content: "{" },
      ],
    },
  );

  const text = data?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new GenerationError("Provider response had no text content.", data);
  }
  const raw = `{${text}`;

  return {
    output: parseOutput(raw),
    model: data?.model ?? env.AI_MODEL,
    usage: {
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
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
