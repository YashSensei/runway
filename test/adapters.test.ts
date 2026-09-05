import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResendEmailAdapter,
  SimulatedEmailAdapter,
  buildCollectionEmail,
  createEmailAdapter,
  formatINR,
} from "../src/adapters/email";
import {
  DECISION_NARRATION_SYSTEM_PROMPT,
  NullLLMAdapter,
  OpenAICompatibleLLMAdapter,
  buildDecisionNarrationPrompt,
  createLLMAdapter,
} from "../src/adapters/llm";
import type { DecisionNarrationInput } from "../src/adapters/llm";
import type { CollectionCandidate, EmailMessage, Invoice } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stubFetch(impl: (...args: never[]) => unknown): void {
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INVOICE: Invoice = {
  id: "INV-2041",
  customer: "Meridian Retail",
  customerEmail: "ap@meridian.example",
  amount: 15_20_000,
  issuedDate: "2026-01-10",
  dueDate: "2026-02-09",
  status: "overdue",
  customerAvgLagDays: 12,
  chasedAt: null,
};

function candidate(daysOverdue: number): CollectionCandidate {
  return {
    invoice: INVOICE,
    daysOverdue,
    expectedArrivalWeek: 3,
    landsBeforeBreach: true,
    score: 0.8,
    rationale: "large, overdue, lands before the breach",
  };
}

const MESSAGE: EmailMessage = {
  to: "ap@meridian.example",
  toName: "Meridian Retail",
  subject: "Test",
  body: "Body",
};

// ---------------------------------------------------------------------------
// formatINR
// ---------------------------------------------------------------------------

describe("formatINR", () => {
  it("formats with Indian lakh grouping", () => {
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(7)).toBe("₹7");
    expect(formatINR(999)).toBe("₹999");
    expect(formatINR(1_000)).toBe("₹1,000");
    expect(formatINR(99_999)).toBe("₹99,999");
    expect(formatINR(1_00_000)).toBe("₹1,00,000");
    expect(formatINR(1520000)).toBe("₹15,20,000");
    expect(formatINR(52_00_000)).toBe("₹52,00,000");
    expect(formatINR(1_00_00_000)).toBe("₹1,00,00,000");
  });

  it("handles negatives and non-integers defensively", () => {
    expect(formatINR(-4500)).toBe("-₹4,500");
    expect(formatINR(1520000.4)).toBe("₹15,20,000");
    expect(formatINR(Number.NaN)).toBe("₹0");
  });
});

// ---------------------------------------------------------------------------
// SimulatedEmailAdapter
// ---------------------------------------------------------------------------

describe("SimulatedEmailAdapter", () => {
  it("always succeeds, is marked simulated, and never touches the network", async () => {
    stubFetch(() => {
      throw new Error("network must not be used");
    });

    const adapter = new SimulatedEmailAdapter();
    expect(adapter.provider).toBe("simulated");

    const result = await adapter.send(MESSAGE);

    expect(result.ok).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.provider).toBe("simulated");
    expect(typeof result.id).toBe("string");
    expect(result.id).not.toBe("");
    expect(result.error).toBeUndefined();
  });

  it("generates a distinct id per send", async () => {
    const adapter = new SimulatedEmailAdapter();
    const a = await adapter.send(MESSAGE);
    const b = await adapter.send(MESSAGE);
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// createEmailAdapter
// ---------------------------------------------------------------------------

describe("createEmailAdapter", () => {
  it("falls back to simulated when the api key is missing", () => {
    expect(createEmailAdapter({}).provider).toBe("simulated");
    expect(createEmailAdapter({ EMAIL_PROVIDER: "resend" }).provider).toBe(
      "simulated",
    );
    expect(
      createEmailAdapter({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "   " })
        .provider,
    ).toBe("simulated");
  });

  it("falls back to simulated when the provider is not resend", () => {
    expect(
      createEmailAdapter({ RESEND_API_KEY: "re_live_123" }).provider,
    ).toBe("simulated");
    expect(
      createEmailAdapter({
        EMAIL_PROVIDER: "sendgrid",
        RESEND_API_KEY: "re_live_123",
      }).provider,
    ).toBe("simulated");
  });

  it("selects Resend when provider and key are both present", () => {
    const adapter = createEmailAdapter({
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_live_123",
      COLLECTION_FROM_NAME: "Runway Finance",
      COLLECTION_FROM_EMAIL: "finance@runway.example",
    });

    expect(adapter.provider).toBe("resend");
    expect(adapter).toBeInstanceOf(ResendEmailAdapter);
  });
});

// ---------------------------------------------------------------------------
// ResendEmailAdapter
// ---------------------------------------------------------------------------

describe("ResendEmailAdapter", () => {
  const adapter = new ResendEmailAdapter({
    apiKey: "re_live_123",
    fromName: "Runway Finance",
    fromEmail: "finance@runway.example",
  });

  it("returns ok:false instead of throwing when fetch rejects", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await adapter.send(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("resend");
    expect(result.simulated).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns ok:false instead of throwing when fetch throws synchronously", async () => {
    stubFetch(() => {
      throw new Error("boom");
    });

    const result = await adapter.send(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    expect(result.simulated).toBe(false);
  });

  it("returns ok:false on a non-2xx response", async () => {
    stubFetch(() => Promise.resolve(new Response("forbidden", { status: 403 })));

    const result = await adapter.send(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("403");
    expect(result.simulated).toBe(false);
  });

  it("posts the documented payload and returns the provider id on success", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stubFetch(((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse({ id: "resend-abc-123" }));
    }) as never);

    const result = await adapter.send({
      to: "ap@meridian.example",
      toName: "Meridian Retail",
      subject: "Overdue invoice",
      body: "Please pay.",
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBe("resend-abc-123");
    expect(result.simulated).toBe(false);

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");

    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer re_live_123");

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body["from"]).toBe("Runway Finance <finance@runway.example>");
    expect(body["to"]).toEqual(["ap@meridian.example"]);
    expect(body["subject"]).toBe("Overdue invoice");
    expect(body["text"]).toBe("Please pay.");
  });
});

// ---------------------------------------------------------------------------
// buildCollectionEmail
// ---------------------------------------------------------------------------

describe("buildCollectionEmail", () => {
  const COMPANY = "Northwind Systems";
  const SENDER = "Ananya Rao";

  const gentle = buildCollectionEmail(candidate(5), COMPANY, SENDER);
  const firm = buildCollectionEmail(candidate(30), COMPANY, SENDER);
  const serious = buildCollectionEmail(candidate(60), COMPANY, SENDER);

  it("addresses the invoice contact", () => {
    for (const message of [gentle, firm, serious]) {
      expect(message.to).toBe("ap@meridian.example");
      expect(message.toName).toBe("Meridian Retail");
    }
  });

  it("always contains the invoice id and the formatted amount", () => {
    for (const message of [gentle, firm, serious]) {
      const combined = `${message.subject}\n${message.body}`;
      expect(combined).toContain("INV-2041");
      expect(combined).toContain("₹15,20,000");
    }
  });

  it("always contains the due date, the day count, and the signature", () => {
    for (const [message, days] of [
      [gentle, 5],
      [firm, 30],
      [serious, 60],
    ] as const) {
      expect(message.body).toContain("9 February 2026");
      expect(message.body).toContain(`${days} days`);
      expect(message.body).toContain("Ananya Rao");
      expect(message.body).toContain("Northwind Systems");
    }
  });

  it("produces a distinct subject per tone tier", () => {
    expect(gentle.subject).not.toBe(firm.subject);
    expect(firm.subject).not.toBe(serious.subject);
    expect(gentle.subject).not.toBe(serious.subject);

    expect(gentle.subject.toLowerCase()).toContain("reminder");
    expect(firm.subject.toLowerCase()).toContain("overdue");
    expect(serious.subject.toLowerCase()).toContain("action required");
  });

  it("escalates the body tone across the tiers", () => {
    expect(gentle.body).not.toBe(firm.body);
    expect(firm.body).not.toBe(serious.body);

    // Gentle: apologetic, no demand.
    expect(gentle.body.toLowerCase()).toContain("nudge");
    expect(gentle.body.toLowerCase()).not.toContain("escalate");

    // Firm: explicit due date reference, asks for a scheduled date.
    expect(firm.body.toLowerCase()).toContain("following up");
    expect(firm.body.toLowerCase()).toContain("scheduled for");
    expect(firm.body.toLowerCase()).not.toContain("escalate");

    // Serious: demands a date and flags being past terms.
    expect(serious.body.toLowerCase()).toContain("specific date");
    expect(serious.body.toLowerCase()).toContain("significantly beyond the terms");
    expect(serious.body.toLowerCase()).toContain("escalate");
  });

  it("switches tone exactly at the 15 and 45 day boundaries", () => {
    const at14 = buildCollectionEmail(candidate(14), COMPANY, SENDER);
    const at15 = buildCollectionEmail(candidate(15), COMPANY, SENDER);
    const at45 = buildCollectionEmail(candidate(45), COMPANY, SENDER);
    const at46 = buildCollectionEmail(candidate(46), COMPANY, SENDER);

    expect(at14.subject.toLowerCase()).toContain("reminder");
    expect(at15.subject.toLowerCase()).toContain("overdue");
    expect(at45.subject.toLowerCase()).toContain("overdue");
    expect(at46.subject.toLowerCase()).toContain("action required");
  });

  it("stays under 150 words and uses no markdown or emoji", () => {
    for (const message of [gentle, firm, serious]) {
      const words = message.body.split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThan(150);
      expect(message.body).not.toMatch(/[*_#`]/);
      expect(message.body).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("singularises the day count", () => {
    const oneDay = buildCollectionEmail(candidate(1), COMPANY, SENDER);
    expect(oneDay.body).toContain("1 day past due");
  });
});

// ---------------------------------------------------------------------------
// NullLLMAdapter
// ---------------------------------------------------------------------------

describe("NullLLMAdapter", () => {
  it("returns null", async () => {
    const adapter = new NullLLMAdapter();
    expect(adapter.provider).toBe("none");
    await expect(adapter.complete("system", "user")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleLLMAdapter
// ---------------------------------------------------------------------------

describe("OpenAICompatibleLLMAdapter", () => {
  const adapter = new OpenAICompatibleLLMAdapter({
    baseUrl: "https://llm.example/v1/",
    apiKey: "sk-test",
    model: "gpt-test",
  });

  it("returns the message content on a valid response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stubFetch(((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "  I approved it.  " } }],
        }),
      );
    }) as never);

    const result = await adapter.complete("SYS", "USR");
    expect(result).toBe("I approved it.");

    const call = calls[0];
    expect(call?.url).toBe("https://llm.example/v1/chat/completions");

    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-test");
    expect(body["temperature"]).toBe(0.3);
    expect(body["max_tokens"]).toBe(400);
    expect(body["messages"]).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
    expect(call?.init.signal).toBeDefined();
  });

  it("returns null on a non-2xx response", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
    );
    await expect(adapter.complete("SYS", "USR")).resolves.toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    stubFetch(() => Promise.reject(new Error("network down")));
    await expect(adapter.complete("SYS", "USR")).resolves.toBeNull();
  });

  it("returns null when fetch throws synchronously", async () => {
    stubFetch(() => {
      throw new Error("boom");
    });
    await expect(adapter.complete("SYS", "USR")).resolves.toBeNull();
  });

  it("returns null on malformed or empty payloads", async () => {
    const payloads: unknown[] = [
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: 42 } }] },
      { choices: [{ message: { content: "   " } }] },
      null,
    ];

    for (const payload of payloads) {
      stubFetch(() => Promise.resolve(jsonResponse(payload)));
      await expect(adapter.complete("SYS", "USR")).resolves.toBeNull();
    }
  });

  it("returns null when the body is not JSON", async () => {
    stubFetch(() => Promise.resolve(new Response("<html>oops</html>")));
    await expect(adapter.complete("SYS", "USR")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createLLMAdapter
// ---------------------------------------------------------------------------

describe("createLLMAdapter", () => {
  const FULL = {
    LLM_PROVIDER: "openai-compatible",
    LLM_API_KEY: "sk-test",
    LLM_BASE_URL: "https://llm.example/v1",
    LLM_MODEL: "gpt-test",
  } as const;

  it("returns the null adapter when config is incomplete", () => {
    expect(createLLMAdapter({}).provider).toBe("none");

    for (const key of [
      "LLM_API_KEY",
      "LLM_BASE_URL",
      "LLM_MODEL",
      "LLM_PROVIDER",
    ] as const) {
      const partial: Record<string, string> = { ...FULL };
      delete partial[key];
      expect(createLLMAdapter(partial).provider).toBe("none");
    }
  });

  it("returns the null adapter for an unknown provider", () => {
    expect(
      createLLMAdapter({ ...FULL, LLM_PROVIDER: "anthropic" }).provider,
    ).toBe("none");
  });

  it("returns the openai-compatible adapter on complete config", () => {
    const adapter = createLLMAdapter({ ...FULL });
    expect(adapter.provider).toBe("openai-compatible");
    expect(adapter).toBeInstanceOf(OpenAICompatibleLLMAdapter);
  });
});

// ---------------------------------------------------------------------------
// Narration prompts
// ---------------------------------------------------------------------------

describe("decision narration prompt", () => {
  it("encodes the do-not-contradict constraint in the system prompt", () => {
    const lowered = DECISION_NARRATION_SYSTEM_PROMPT.toLowerCase();
    expect(lowered).toContain("already been made");
    expect(lowered).toContain("second-guess");
    expect(lowered).toContain("no markdown");
    expect(lowered).toContain("emoji");
  });

  it("includes the outcome, figures and rule evaluations", () => {
    const prompt = buildDecisionNarrationPrompt({
      outcome: "ESCALATED",
      reasonCode: "exceeds_authority",
      amount: 52_00_000,
      departmentName: "Engineering",
      vendorName: "Nimbus Cloud",
      category: "infrastructure",
      rules: [
        {
          rule: "max_autonomous_amount",
          passed: false,
          severity: "soft",
          detail: "₹52,00,000 exceeds the ₹25,00,000 ceiling",
        },
        {
          rule: "headroom_check",
          passed: true,
          severity: "soft",
          detail: "headroom covers the amount",
        },
      ],
      headroomBefore: 1_20_00_000,
      headroomAfter: 68_00_000,
      projectedMinimumBefore: 2_20_00_000,
      projectedMinimumAfter: 1_68_00_000,
      threshold: 1_00_00_000,
      description: "Annual cloud commitment",
      requestedBy: "priya@northwind.example",
    });

    expect(prompt).toContain("ESCALATED");
    expect(prompt).toContain("exceeds_authority");
    expect(prompt).toContain("₹52,00,000");
    expect(prompt).toContain("₹1,20,00,000");
    expect(prompt).toContain("₹68,00,000");
    expect(prompt).toContain("₹1,00,00,000");
    expect(prompt).toContain("Engineering");
    expect(prompt).toContain("Nimbus Cloud");
    expect(prompt).toContain("infrastructure");
    expect(prompt).toContain("Annual cloud commitment");
    expect(prompt).toContain("max_autonomous_amount");
    expect(prompt).toContain("FAIL");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("Rules that failed: max_autonomous_amount.");
  });

  it("handles the clean-approval case with no failed rules", () => {
    const prompt = buildDecisionNarrationPrompt({
      outcome: "APPROVED",
      reasonCode: "within_authority",
      amount: 4_50_000,
      departmentName: "Marketing",
      vendorName: "Trellis Media",
      category: "advertising",
      rules: [],
      headroomBefore: 90_00_000,
      headroomAfter: 85_50_000,
      projectedMinimumBefore: 1_90_00_000,
      projectedMinimumAfter: 1_85_50_000,
      threshold: 1_00_00_000,
    });

    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("No rules failed.");
    expect(prompt).toContain("(none recorded)");
    expect(prompt).not.toContain("Purpose:");
    expect(prompt).not.toContain("Requested by:");
  });

  it("is deterministic", () => {
    const input: DecisionNarrationInput = {
      outcome: "REJECTED",
      reasonCode: "hard_rule_violation",
      amount: 10_00_000,
      departmentName: "Ops",
      vendorName: "Acme",
      category: "misc",
      rules: [],
      headroomBefore: 0,
      headroomAfter: 0,
      projectedMinimumBefore: 0,
      projectedMinimumAfter: 0,
      threshold: 0,
    };

    expect(buildDecisionNarrationPrompt({ ...input })).toBe(
      buildDecisionNarrationPrompt({ ...input }),
    );
  });
});
