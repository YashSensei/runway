/**
 * Email adapters.
 *
 * Two rules govern this file:
 *
 * 1. Sending email must NEVER throw. The collections loop runs autonomously;
 *    a dead SMTP provider is not allowed to take down the agent. Every failure
 *    path returns an `EmailSendResult` with `ok: false`.
 * 2. The simulated adapter is the default. The demo has to work with zero
 *    credentials configured.
 */

import type {
  CollectionCandidate,
  EmailAdapter,
  EmailMessage,
  EmailSendResult,
} from "../types";
import { formatINR, formatISODate } from "../money";

export { formatINR, formatISODate };

// ---------------------------------------------------------------------------
// Simulated
// ---------------------------------------------------------------------------

/**
 * Renders the email to the activity log instead of transmitting it.
 *
 * Instant, offline, and infallible by construction. This is what runs during
 * the demo unless a Resend key is explicitly wired up.
 */
export class SimulatedEmailAdapter implements EmailAdapter {
  readonly provider = "simulated";

  async send(_message: EmailMessage): Promise<EmailSendResult> {
    return {
      provider: this.provider,
      ok: true,
      id: `sim_${crypto.randomUUID()}`,
      simulated: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

export interface ResendEmailAdapterConfig {
  apiKey: string;
  fromName: string;
  fromEmail: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Real transmission via the Resend HTTP API. */
export class ResendEmailAdapter implements EmailAdapter {
  readonly provider = "resend";

  readonly #apiKey: string;
  readonly #from: string;

  constructor(config: ResendEmailAdapterConfig) {
    this.#apiKey = config.apiKey;
    this.#from = `${config.fromName} <${config.fromEmail}>`;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.#from,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
      });

      if (!response.ok) {
        return {
          provider: this.provider,
          ok: false,
          error: `resend responded ${response.status}: ${await readBodySafely(response)}`,
          simulated: false,
        };
      }

      return {
        provider: this.provider,
        ok: true,
        id: await readIdSafely(response),
        simulated: false,
      };
    } catch (error) {
      return {
        provider: this.provider,
        ok: false,
        error: errorMessage(error),
        simulated: false,
      };
    }
  }
}

/** Never let response-body parsing turn a soft failure into a thrown one. */
async function readBodySafely(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}

async function readIdSafely(response: Response): Promise<string> {
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof (parsed as { id: unknown }).id === "string"
    ) {
      return (parsed as { id: string }).id;
    }
  } catch {
    // fall through
  }
  return `resend_${crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface EmailEnv {
  EMAIL_PROVIDER?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  COLLECTION_FROM_NAME?: string | undefined;
  COLLECTION_FROM_EMAIL?: string | undefined;
}

const DEFAULT_FROM_NAME = "Runway Finance";
const DEFAULT_FROM_EMAIL = "finance@runway.example";

/**
 * Defensive by default: only returns the network-backed adapter when the
 * provider is explicitly selected AND a key is actually present. Any other
 * configuration — missing, partial, typo'd — falls back to simulation.
 */
export function createEmailAdapter(env: EmailEnv): EmailAdapter {
  const apiKey = env.RESEND_API_KEY?.trim();

  if (env.EMAIL_PROVIDER === "resend" && apiKey) {
    return new ResendEmailAdapter({
      apiKey,
      fromName: env.COLLECTION_FROM_NAME?.trim() || DEFAULT_FROM_NAME,
      fromEmail: env.COLLECTION_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL,
    });
  }

  return new SimulatedEmailAdapter();
}

// ---------------------------------------------------------------------------
// Collection email template
// ---------------------------------------------------------------------------

export type CollectionTone = "gentle" | "firm" | "serious";

/** Tone ladder: <15 days gentle, 15–45 firm, >45 serious. */
export function collectionTone(daysOverdue: number): CollectionTone {
  if (daysOverdue < 15) return "gentle";
  if (daysOverdue <= 45) return "firm";
  return "serious";
}

/**
 * Deterministic accounts-receivable chase email. No LLM involved — this text
 * goes out under the company's name, so it is written once, by a human, and
 * only the figures vary.
 */
export function buildCollectionEmail(
  candidate: CollectionCandidate,
  companyName: string,
  senderName: string,
): EmailMessage {
  const { invoice, daysOverdue } = candidate;
  const amount = formatINR(invoice.amount);
  const dueDate = formatISODate(invoice.dueDate);
  const days = Math.max(0, Math.round(daysOverdue));
  const dayWord = days === 1 ? "day" : "days";
  const customer = invoice.customer;
  const tone = collectionTone(days);

  const signOff = `${senderName}\n${companyName}`;

  if (tone === "gentle") {
    return {
      to: invoice.customerEmail,
      toName: customer,
      subject: `Reminder: invoice ${invoice.id} for ${amount} is past due`,
      body:
        `Hi ${customer},\n\n` +
        `Hope all is well. A quick reminder that invoice ${invoice.id} for ${amount} ` +
        `fell due on ${dueDate} and is now ${days} ${dayWord} past due.\n\n` +
        `In my experience this is usually just an invoice sitting in someone's queue, ` +
        `so please treat this as a nudge rather than a chase. If payment has already ` +
        `gone out, do ignore this note and accept my apologies for the duplication.\n\n` +
        `If it would help, I am happy to re-send the invoice or the supporting ` +
        `documents to whoever needs them. Otherwise, a quick note on when we can ` +
        `expect payment would be much appreciated.\n\n` +
        `Best regards,\n${signOff}`,
    };
  }

  if (tone === "firm") {
    return {
      to: invoice.customerEmail,
      toName: customer,
      subject: `Overdue: invoice ${invoice.id} — ${amount}, ${days} ${dayWord} past due`,
      body:
        `Hi ${customer},\n\n` +
        `I am following up on invoice ${invoice.id} for ${amount}. It was due on ` +
        `${dueDate} and is now ${days} ${dayWord} outstanding. We have not been able ` +
        `to match a payment against it.\n\n` +
        `Could you confirm the invoice has been approved on your side and let me know ` +
        `the date it is scheduled for? If something is holding it up — a missing ` +
        `purchase order, a query on the line items, an approver on leave — please tell ` +
        `me and I will get it cleared from our end today.\n\n` +
        `We would appreciate settlement this week.\n\n` +
        `Best regards,\n${signOff}`,
    };
  }

  return {
    to: invoice.customerEmail,
    toName: customer,
    subject: `Action required: invoice ${invoice.id} is ${days} ${dayWord} past due`,
    body:
      `Hi ${customer},\n\n` +
      `Invoice ${invoice.id} for ${amount} was due on ${dueDate} and is now ${days} ` +
      `${dayWord} overdue. That is significantly beyond the terms we agreed, and ` +
      `previous reminders have not resulted in payment.\n\n` +
      `I need a specific date on which this invoice will be paid. Please reply with ` +
      `that date, or with the name of the person in your accounts payable team I ` +
      `should be speaking to directly.\n\n` +
      `If there is a dispute on any part of this invoice, please put it in writing ` +
      `today and we will deal with it immediately. Absent that, I have to escalate ` +
      `this internally.\n\n` +
      `Regards,\n${signOff}`,
  };
}
