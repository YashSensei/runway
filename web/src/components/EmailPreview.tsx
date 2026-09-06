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
      title="Collection email"
      onClose={onClose}
      headerExtra={
        <span
          className={`chip ${simulated ? "chip-warn" : "chip-ok"}`}
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
            <span className="mono c-3">
              &lt;{message.to}&gt;
            </span>
          </span>

          <span className="mail-key">Subject</span>
          <span className="mail-val mail-subject">{message.subject}</span>

          <span className="mail-key">Sent</span>
          <span className="mail-val mono fs-2">
            {stamp(email.sentAt)}
          </span>
        </div>

        <pre className="mail-body">{message.body}</pre>
      </div>

      <div className="mail-foot">
        <span>
          provider <b className="c-2">{result.provider}</b>
        </span>
        <span>·</span>
        <span>
          delivery{" "}
          <b className={result.ok ? "c-ok" : "c-danger"}>
            {result.ok ? "accepted" : "failed"}
          </b>
        </span>
        <span>·</span>
        <span>invoice {email.invoiceId}</span>
        <span>·</span>
        <span>{result.id ? `id ${result.id}` : `id — · ${email.id}`}</span>
        {result.error ? (
          <span className="c-danger">· {result.error}</span>
        ) : null}
      </div>

      {simulated ? (
        <div
          className="mail-foot c-warn mt-2"
        >
          This message was composed and logged but not transmitted — no mail
          provider credential is configured for this run.
        </div>
      ) : null}
    </Modal>
  );
}
