/**
 * LLM adapters.
 *
 * The LLM is a NARRATION layer and nothing else. Every decision in this system
 * is produced by the deterministic engine; the model's only job is to say out
 * loud what the engine already concluded. That is why:
 *
 * - `complete()` returns `string | null` and never throws — a decision with a
 *   null narration still renders, using its `fallbackNarration`.
 * - `NullLLMAdapter` is the default. Zero credentials, full demo.
 */

import type {
  DecisionOutcome,
  LLMAdapter,
  ReasonCode,
  RuleEvaluation,
  Rupees,
} from "../types";
import { formatINR } from "../money";

// ---------------------------------------------------------------------------
// Null adapter
// ---------------------------------------------------------------------------

/** Always declines to narrate. Callers fall back to deterministic text. */
export class NullLLMAdapter implements LLMAdapter {
  readonly provider = "none";

  async complete(_system: string, _user: string): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter
// ---------------------------------------------------------------------------

export interface OpenAICompatibleLLMAdapterConfig {
  /** e.g. `https://api.openai.com/v1` — trailing slash optional. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Talks to anything speaking the OpenAI chat-completions dialect (OpenAI,
 * Groq, Together, OpenRouter, a local llama.cpp server, Workers AI's compat
 * endpoint).
 *
 * Hard-capped at 8 seconds. Narration is a nice-to-have; it is never allowed
 * to hold a request open.
 */
export class OpenAICompatibleLLMAdapter implements LLMAdapter {
  readonly provider = "openai-compatible";

  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;

  constructor(config: OpenAICompatibleLLMAdapterConfig) {
    this.#endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.#apiKey = config.apiKey;
    this.#model = config.model;
  }

  async complete(system: string, user: string): Promise<string | null> {
    try {
      const response = await fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.#model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.3,
          max_tokens: 400,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const payload: unknown = await response.json();
      return extractContent(payload);
    } catch {
      // Network error, timeout, malformed JSON — all identical to the caller.
      return null;
    }
  }
}

/** Pull `choices[0].message.content` out of an untrusted payload. */
function extractContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;

  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;

  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") return null;

  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface LLMEnv {
  LLM_PROVIDER?: string | undefined;
  LLM_API_KEY?: string | undefined;
  LLM_BASE_URL?: string | undefined;
  LLM_MODEL?: string | undefined;
}

/**
 * Returns the network adapter only when the provider is explicitly selected
 * and every one of the three required settings is present. Partial config is
 * treated as no config.
 */
export function createLLMAdapter(env: LLMEnv): LLMAdapter {
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();

  if (env.LLM_PROVIDER === "openai-compatible" && apiKey && baseUrl && model) {
    return new OpenAICompatibleLLMAdapter({ baseUrl, apiKey, model });
  }

  return new NullLLMAdapter();
}

// ---------------------------------------------------------------------------
// Decision narration
// ---------------------------------------------------------------------------

export const DECISION_NARRATION_SYSTEM_PROMPT = `You are the narration layer of Runway, an autonomous CFO agent that manages cash for a company.

The decision below has ALREADY been made by a deterministic rules engine. It is final. Your only job is to explain it to the CFO in plain language.

Absolute rules:
- Never contradict, second-guess, question, or re-derive the outcome. Do not suggest a different outcome. Do not say what you "would" have done.
- Never invent numbers, rules, dates, or facts. Use only the figures supplied, exactly as written, including the currency symbol and comma grouping.
- Do not perform arithmetic. If a number is not given to you, do not mention it.

Style:
- 2 to 4 short sentences. Nothing longer.
- First person, as the agent, addressed directly to the CFO ("I approved...", "I've held this for you...").
- Plain, confident, factual. No hedging words: no "seems", "appears", "might", "I think", "possibly".
- State what was decided, the one or two numbers that drove it, and what it means for cash.
- If the outcome is ESCALATED or REJECTED, say clearly which rule stopped it and what the CFO needs to do.
- No markdown, no bullet points, no headings, no bold, no emoji, no sign-off. Plain prose only.`;

/** Everything the narration prompt is allowed to know. */
export interface DecisionNarrationInput {
  outcome: DecisionOutcome;
  reasonCode: ReasonCode;
  amount: Rupees;
  departmentName: string;
  vendorName: string;
  category: string;
  rules: RuleEvaluation[];
  headroomBefore: Rupees;
  headroomAfter: Rupees;
  projectedMinimumBefore: Rupees;
  projectedMinimumAfter: Rupees;
  threshold: Rupees;
  /** Optional free-text description of what the money is for. */
  description?: string | undefined;
  /** Optional requester name, for a more natural sentence. */
  requestedBy?: string | undefined;
}

/** Human-readable gloss for each reason code, so the model never guesses. */
const REASON_LABELS: Record<ReasonCode, string> = {
  within_authority: "the request fell entirely within the delegated authority",
  hard_rule_violation: "a hard rule was violated, which forces a rejection",
  exceeds_authority: "the amount exceeds the maximum the agent may approve alone",
  insufficient_headroom: "approving it would leave insufficient cash headroom",
  anomalous_request: "the amount is anomalous versus the historical baseline",
};

const OUTCOME_LABELS: Record<DecisionOutcome, string> = {
  APPROVED: "APPROVED (auto-approved by the agent, no human needed)",
  ESCALATED: "ESCALATED (held for the CFO to decide)",
  REJECTED: "REJECTED (refused outright)",
};

/** Build the user message. Deterministic; safe to snapshot in tests. */
export function buildDecisionNarrationPrompt(
  input: DecisionNarrationInput,
): string {
  const lines: string[] = [
    "Decision record (final, already committed):",
    "",
    `Outcome: ${OUTCOME_LABELS[input.outcome]}`,
    `Reason code: ${input.reasonCode} — ${REASON_LABELS[input.reasonCode]}`,
    `Amount: ${formatINR(input.amount)}`,
    `Department: ${input.departmentName}`,
    `Vendor: ${input.vendorName}`,
    `Category: ${input.category}`,
  ];

  if (input.description) lines.push(`Purpose: ${input.description}`);
  if (input.requestedBy) lines.push(`Requested by: ${input.requestedBy}`);

  lines.push(
    "",
    "Cash impact:",
    `- Minimum cash threshold: ${formatINR(input.threshold)}`,
    `- Headroom before: ${formatINR(input.headroomBefore)}`,
    `- Headroom after: ${formatINR(input.headroomAfter)}`,
    `- Projected minimum cash before: ${formatINR(input.projectedMinimumBefore)}`,
    `- Projected minimum cash after: ${formatINR(input.projectedMinimumAfter)}`,
    "",
    "Rule evaluations:",
  );

  if (input.rules.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const rule of input.rules) {
      lines.push(
        `- ${rule.rule} [${rule.severity}]: ${rule.passed ? "PASS" : "FAIL"} — ${rule.detail}`,
      );
    }
  }

  const failed = input.rules.filter((rule) => !rule.passed);
  lines.push(
    "",
    failed.length === 0
      ? "No rules failed."
      : `Rules that failed: ${failed.map((rule) => rule.rule).join(", ")}.`,
    "",
    "Explain this decision to the CFO in 2-4 short sentences.",
  );

  return lines.join("\n");
}
