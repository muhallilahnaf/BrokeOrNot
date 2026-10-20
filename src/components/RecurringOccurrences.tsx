
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatPaisa } from "../lib/money";

type OccurrenceStatus =
  | "pending"
  | "paid"
  | "skipped"
  | "cancelled";

type ScheduleKind = "income" | "expense";

type Category = {
  id: string;
  name: string;
  kind: ScheduleKind;
  is_active: boolean;
};

type Schedule = {
  id: string;
  user_id: string;
  name: string;
  kind: ScheduleKind;
  amount_paisa: string | number;
  category_id: string;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  status: "active" | "paused" | "ended";
};

type Occurrence = {
  id: string;
  user_id: string;
  schedule_id: string;
  due_date: string;
  status: OccurrenceStatus;
  transaction_id: string | null;
};

type OccurrenceView = Occurrence & {
  schedule: Schedule;
};

type Props = {
  userId: string;
  categories: Category[];
  onTransactionCreated: () => void;
};

const STATUS_OPTIONS: OccurrenceStatus[] = [
  "pending",
  "paid",
  "skipped",
  "cancelled",
];

export default function RecurringOccurrences({
  userId,
  categories,
  onTransactionCreated,
}: Props) {
  const [occurrences, setOccurrences] = useState<OccurrenceView[]>([]);
  const [statusFilter, setStatusFilter] =
    useState<"all" | OccurrenceStatus>("all");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [payingOccurrence, setPayingOccurrence] =
    useState<OccurrenceView | null>(null);
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  const loadOccurrences = useCallback(async () => {
    const [occurrenceResult, scheduleResult] = await Promise.all([
      supabase
        .from("schedule_occurrences")
        .select(
          "id, user_id, schedule_id, due_date, status, transaction_id"
        )
        .eq("user_id", userId)
        .order("due_date", { ascending: true })
        .order("id", { ascending: true }),

      supabase
        .from("recurring_schedules")
        .select(
          "id, user_id, name, kind, amount_paisa, category_id, " +
          "frequency, status"
        )
        .eq("user_id", userId),
    ]);

    if (occurrenceResult.error) {
      throw new Error(occurrenceResult.error.message);
    }

    if (scheduleResult.error) {
      throw new Error(scheduleResult.error.message);
    }

    const scheduleMap = new Map<string, Schedule>(
      ((scheduleResult.data ?? []) as unknown as Schedule[]).map((schedule) => [
        schedule.id,
        schedule,
      ])
    );

    const joined: OccurrenceView[] = [];

    for (const occurrence of (occurrenceResult.data ?? []) as Occurrence[]) {
      const schedule = scheduleMap.get(occurrence.schedule_id);

      if (!schedule || schedule.user_id !== userId) continue;

      joined.push({ ...occurrence, schedule });
    }

    setOccurrences(joined);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;

    async function initialLoad() {
      try {
        const [occurrenceResult, scheduleResult] = await Promise.all([
          supabase
            .from("schedule_occurrences")
            .select(
              "id, user_id, schedule_id, due_date, status, transaction_id"
            )
            .eq("user_id", userId)
            .order("due_date", { ascending: true })
            .order("id", { ascending: true }),

          supabase
            .from("recurring_schedules")
            .select(
              "id, user_id, name, kind, amount_paisa, category_id, " +
              "frequency, status"
            )
            .eq("user_id", userId),
        ]);

        if (occurrenceResult.error) {
          throw new Error(occurrenceResult.error.message);
        }

        if (scheduleResult.error) {
          throw new Error(scheduleResult.error.message);
        }

        const scheduleMap = new Map<string, Schedule>(
          ((scheduleResult.data ?? []) as unknown as Schedule[]).map((schedule) => [
            schedule.id,
            schedule,
          ])
        );

        const joined: OccurrenceView[] = [];

        for (
          const occurrence of (occurrenceResult.data ?? []) as Occurrence[]
        ) {
          const schedule = scheduleMap.get(occurrence.schedule_id);

          if (!schedule || schedule.user_id !== userId) continue;

          joined.push({ ...occurrence, schedule });
        }

        if (!cancelled) {
          setOccurrences(joined);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not load scheduled occurrences."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void initialLoad();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function generateOccurrences() {
    setGenerating(true);
    setError("");
    setNotice("");

    try {
      const { data, error: rpcError } = await supabase.rpc(
        "generate_schedule_occurrences"
      );

      if (rpcError) throw new Error(rpcError.message);

      await loadOccurrences();

      const count = Number(data ?? 0);
      setNotice(
        count === 0
          ? "No new occurrences were needed."
          : `Generated ${count} new occurrence${count === 1 ? "" : "s"}.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not generate occurrences."
      );
    } finally {
      setGenerating(false);
    }
  }

  function openPayment(occurrence: OccurrenceView) {
    setPayingOccurrence(occurrence);
    setPaymentDate(occurrence.due_date);
    setPaymentNotes("");
    setError("");
    setNotice("");
  }

  function closePayment() {
    if (busyId) return;

    setPayingOccurrence(null);
    setPaymentDate("");
    setPaymentNotes("");
  }

  async function confirmPayment() {
    if (!payingOccurrence) return;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      setError("Choose a valid transaction date.");
      return;
    }

    if (paymentNotes.length > 2000) {
      setError("Notes must be 2000 characters or fewer.");
      return;
    }

    const occurrence = payingOccurrence;

    if (
      !window.confirm(
        `Mark "${occurrence.schedule.name}" as paid for ` +
        `${formatPaisa(occurrence.schedule.amount_paisa)}? ` +
        "This will create a transaction."
      )
    ) {
      return;
    }

    setBusyId(occurrence.id);
    setError("");
    setNotice("");

    try {
      const { data, error: rpcError } = await supabase.rpc(
        "pay_schedule_occurrence",
        {
          p_occurrence_id: occurrence.id,
          p_transaction_date: paymentDate,
          p_notes: paymentNotes.trim() || null,
        }
      );

      if (rpcError) throw new Error(rpcError.message);

      if (!data) {
        throw new Error(
          "The database did not return the created transaction ID."
        );
      }

      onTransactionCreated();

      await loadOccurrences();

      setPayingOccurrence(null);
      setPaymentDate("");
      setPaymentNotes("");
      setNotice(
        `Payment recorded. Transaction ID: ${String(data)}`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not record payment."
      );
    } finally {
      setBusyId(null);
    }
  }

  async function changeOccurrenceStatus(
    occurrence: OccurrenceView,
    status: "skipped" | "cancelled"
  ) {
    const action = status === "skipped" ? "skip" : "cancel";

    if (
      !window.confirm(
        `Are you sure you want to ${action} "${occurrence.schedule.name}" ` +
        `due on ${occurrence.due_date}? No transaction will be created.`
      )
    ) {
      return;
    }

    setBusyId(occurrence.id);
    setError("");
    setNotice("");

    try {
      const { error: rpcError } = await supabase.rpc(
        "set_schedule_occurrence_status",
        {
          p_occurrence_id: occurrence.id,
          p_status: status,
        }
      );

      if (rpcError) throw new Error(rpcError.message);

      await loadOccurrences();
      setNotice(`Occurrence ${status}.`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Could not ${action} the occurrence.`
      );
    } finally {
      setBusyId(null);
    }
  }

  const visibleOccurrences = occurrences.filter(
    (occurrence) =>
      statusFilter === "all" || occurrence.status === statusFilter
  );

  const pendingCount = occurrences.filter(
    (occurrence) => occurrence.status === "pending"
  ).length;

  return (
    <section className="panel occurrences-panel">
      <div className="occurrences-heading">
        <div>
          <h2>Scheduled occurrences</h2>
          <p className="muted">
            Pay an occurrence to create a transaction. Skipping or cancelling
            does not affect your balance.
          </p>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={generateOccurrences}
          disabled={generating}
        >
          {generating ? "Generating..." : "Generate occurrences"}
        </button>
      </div>

      <div className="occurrences-summary">
        <div className="occurrence-summary-card">
          <span className="muted">All occurrences</span>
          <strong>{occurrences.length}</strong>
        </div>
        <div className="occurrence-summary-card">
          <span className="muted">Pending</span>
          <strong>{pendingCount}</strong>
        </div>
      </div>

      <label className="field-label occurrences-filter">
        Filter by status
        <select
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(
              event.target.value as "all" | OccurrenceStatus
            )
          }
        >
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="error">{error}</p>}
      {notice && <p className="success">{notice}</p>}

      {payingOccurrence && (
        <div className="payment-editor">
          <h3>Record payment</h3>
          <p>
            <strong>{payingOccurrence.schedule.name}</strong>
          </p>
          <p>
            Amount: {formatPaisa(payingOccurrence.schedule.amount_paisa)}
          </p>

          <label className="field-label">
            Actual transaction date
            <input
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
              required
            />
          </label>

          <label className="field-label">
            Notes (optional)
            <textarea
              value={paymentNotes}
              onChange={(event) => setPaymentNotes(event.target.value)}
              maxLength={2000}
              rows={3}
            />
          </label>

          <div className="recurring-actions">
            <button
              type="button"
              className="primary-button"
              onClick={confirmPayment}
              disabled={busyId !== null}
            >
              {busyId === payingOccurrence.id
                ? "Recording..."
                : "Confirm payment"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={closePayment}
              disabled={busyId !== null}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="muted">Loading occurrences...</p>
      ) : visibleOccurrences.length === 0 ? (
        <p className="muted">
          No occurrences to display. Create an active recurring schedule,
          then generate occurrences.
        </p>
      ) : (
        <div className="occurrences-list">
          {visibleOccurrences.map((occurrence) => {
            const category = categories.find(
              (item) => item.id === occurrence.schedule.category_id
            );
            const isBusy = busyId === occurrence.id;

            return (
              <article className="occurrence-item" key={occurrence.id}>
                <div className="occurrence-main">
                  <div className="occurrence-title-row">
                    <strong>{occurrence.schedule.name}</strong>
                    <span
                      className={`schedule-status status-${occurrence.status}`}
                    >
                      {occurrence.status}
                    </span>
                  </div>

                  <strong className="occurrence-amount">
                    {occurrence.schedule.kind === "expense" ? "−" : "+"}
                    {formatPaisa(occurrence.schedule.amount_paisa)}
                  </strong>

                  <div className="occurrence-meta">
                    <span>Due: {occurrence.due_date}</span>
                    <span>{category?.name ?? "Unknown category"}</span>
                    <span>{occurrence.schedule.frequency}</span>
                  </div>

                  {occurrence.transaction_id && (
                    <p className="muted">
                      Transaction: {occurrence.transaction_id}
                    </p>
                  )}

                  {occurrence.status === "pending" && (
                    <div className="recurring-item-actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => openPayment(occurrence)}
                        disabled={busyId !== null}
                      >
                        Pay
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          changeOccurrenceStatus(occurrence, "skipped")
                        }
                        disabled={isBusy || busyId !== null}
                      >
                        Skip
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() =>
                          changeOccurrenceStatus(occurrence, "cancelled")
                        }
                        disabled={isBusy || busyId !== null}
                      >
                        Cancel occurrence
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
