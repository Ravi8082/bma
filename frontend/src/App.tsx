import { fromRupees, formatINR } from "@bma/shared";
import { useEffect, useState } from "react";
import { api, type OutboxMessage } from "./lib/api";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

export function App() {
  const [health, setHealth] = useState<LoadState<Awaited<ReturnType<typeof api.health>>>>({
    status: "loading",
  });
  const [outbox, setOutbox] = useState<LoadState<OutboxMessage[]>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    api
      .health(controller.signal)
      .then((value) => setHealth({ status: "ready", value }))
      .catch((error: unknown) =>
        setHealth({
          status: "error",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );

    api
      .outbox(controller.signal)
      .then(({ data }) => setOutbox({ status: "ready", value: data }))
      .catch((error: unknown) =>
        setOutbox({
          status: "error",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <header className="masthead">
        <p className="eyebrow">Phase 1 · foundation</p>
        <h1>Business Memory AI</h1>
        <p className="tagline">Your entire business. One WhatsApp conversation.</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>API</h2>
          {health.status === "loading" && <p className="muted">Checking…</p>}
          {health.status === "error" && (
            <p className="bad">
              Offline — start the API with <code>npm run dev:api</code>
            </p>
          )}
          {health.status === "ready" && (
            <dl>
              <dt>Status</dt>
              <dd className="good">{health.value.data.status}</dd>
              <dt>Environment</dt>
              <dd>{health.value.data.env}</dd>
              <dt>Uptime</dt>
              <dd>{health.value.data.uptimeSeconds}s</dd>
            </dl>
          )}
        </article>

        <article className="card">
          <h2>Money engine</h2>
          <p className="muted">
            Integer paise in, Indian grouping out. No floats, no rounding drift.
          </p>
          <ul className="money-list">
            <li>
              <span>₹500 sale</span>
              <strong>{formatINR(fromRupees(500))}</strong>
            </li>
            <li>
              <span>₹1,50,000 month</span>
              <strong>{formatINR(fromRupees("1,50,000"))}</strong>
            </li>
            <li>
              <span>₹0.05 rounding case</span>
              <strong>{formatINR(fromRupees("0.05"))}</strong>
            </li>
            <li>
              <span>₹1,200 advance (credit)</span>
              <strong>{formatINR(fromRupees(-1200))}</strong>
            </li>
          </ul>
        </article>

        <article className="card">
          <h2>WhatsApp simulator</h2>
          {outbox.status === "loading" && <p className="muted">Loading outbox…</p>}
          {outbox.status === "error" && <p className="bad">Simulator unavailable</p>}
          {outbox.status === "ready" && (
            <>
              <p className="muted">
                {outbox.value.length === 0
                  ? "No messages recorded yet."
                  : `${outbox.value.length} message(s) recorded locally.`}
              </p>
              <ol className="outbox">
                {outbox.value.slice(-3).map((message) => (
                  <li key={message.id}>
                    <code>{message.to}</code>
                    <span>{message.body}</span>
                  </li>
                ))}
              </ol>
              <a className="link" href="/simulator" target="_blank" rel="noreferrer">
                Open simulator inbox ↗
              </a>
            </>
          )}
        </article>
      </section>

      <footer className="footer">
        Phase 1 ships the foundation only: nothing here posts a financial entry yet.
      </footer>
    </main>
  );
}
