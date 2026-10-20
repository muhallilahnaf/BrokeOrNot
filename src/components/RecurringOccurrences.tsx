
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

type Props = {
  userId: string;
  categories: Category[];
};

type OccurrenceView = Occurrence & {
  schedule: Schedule;
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
}: Props) {
  const [occurrences, setOccurrences] = useState<OccurrenceView[]>([]);
  const [statusFilter, setStatusFilter] =
    useState<"all" | OccurrenceStatus>("all");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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

      // Do not display an occurrence without its own user's schedule.
      if (!schedule || schedule.user_id !== userId) continue;

      joined.push({ ...occurrence, schedule });
    }

    setOccurrences(joined);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
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

    void load();

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

      if (rpcError) {
        throw new Error(rpcError.message);
      }

      await loadOccurrences();

      const count = Number(data ?? 0);

      setNotice(
        count === 0
          ? "No new occurrences were needed. Existing occurrences were preserved."
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
            Individual due dates generated from your recurring schedules.
            These items do not change your balance until processed in Step 12.
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

      {loading ? (
        <p className="muted">Loading occurrences...</p>
      ) : visibleOccurrences.length === 0 ? (
        <p className="muted">
          No occurrences to display. Create an active recurring schedule,
          then select Generate occurrences.
        </p>
      ) : (
        <div className="occurrences-list">
          {visibleOccurrences.map((occurrence) => {
            const schedule = occurrence.schedule;
            const category = categories.find(
              (item) => item.id === schedule.category_id
            );

            return (
              <article
                className="occurrence-item"
                key={occurrence.id}
              >
                <div className="occurrence-main">
                  <div className="occurrence-title-row">
                    <strong>{schedule.name}</strong>
                    <span
                      className={`schedule-status status-${occurrence.status}`}
                    >
                      {occurrence.status}
                    </span>
                  </div>

                  <strong className="occurrence-amount">
                    {schedule.kind === "expense" ? "−" : "+"}
                    {formatPaisa(schedule.amount_paisa)}
                  </strong>

                  <div className="occurrence-meta">
                    <span>Due: {occurrence.due_date}</span>
                    <span>{category?.name ?? "Unknown category"}</span>
                    <span>
                      {schedule.frequency.charAt(0).toUpperCase() +
                        schedule.frequency.slice(1)}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
