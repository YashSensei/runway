import type { SentEmail } from "@shared/types";
import { stamp } from "../format";
import { Modal } from "./Modal";

interface Props {
  email: SentEmail;
  onClose: () => void;
}

export function EmailPreview({ email, onClose }: Props) {
  const { message, result } = email;
  const simulated = result.simulated;

  return (
    <Modal
      title="Collection Email"
      onClose={onClose}
      headerExtra={
        <span
          className={`badge ${simulated ? "badge-mock" : "badge-ok"}`}
          title={
            simulated
              ? "Rendered to the activity log, not handed to a mail provider"
              : "Handed to the mail provider and accepted"
          }
        >
          <i className="dot" />
          {simulated ? "Simulated" : "Transmitted"}
        </span>
      }
    >
      <div className="mail">
        <div className="mail-head">
          <span className="mail-key">To</span>
          <span className="mail-val">
            {message.toName}{" "}
            <span className="mono" style={{ color: "var(--text-3)" }}>
              &lt;{message.to}&gt;
            </span>
          </span>

          <span className="mail-key">Subject</span>
          <span className="mail-val mail-subject">{message.subject}</span>

          <span className="mail-key">Sent</span>
          <span className="mail-val mono" style={{ fontSize: 12.5 }}>
            {stamp(email.sentAt)}
          </span>
        </div>

        <pre className="mail-body">{message.body}</pre>
      </div>

      <div className="mail-foot">
        <span>
          provider <b style={{ color: "var(--text-2)" }}>{result.provider}</b>
        </span>
        <span>·</span>
        <span>
          delivery{" "}
          <b
            style={{
              color: result.ok ? "var(--ok)" : "var(--danger)",
            }}
          >
            {result.ok ? "accepted" : "failed"}
          </b>
        </span>
        <span>·</span>
        <span>invoice {email.invoiceId}</span>
        <span>·</span>
        <span>{result.id ? `id ${result.id}` : `id — · ${email.id}`}</span>
        {result.error ? (
          <span style={{ color: "var(--danger)" }}>· {result.error}</span>
        ) : null}
      </div>

      {simulated ? (
        <div
          className="mail-foot"
          style={{ color: "var(--warn)", marginTop: 8 }}
        >
          This message was composed and logged but not transmitted — no mail
          provider credential is configured for this run.
        </div>
      ) : null}
    </Modal>
  );
}
