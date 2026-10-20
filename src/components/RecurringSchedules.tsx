
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { supabase } from "../lib/supabase";
import {
  formatPaisa,
  parseTakaToPaisa,
  getLocalDateString,
} from "../lib/money";

type ScheduleKind = "income" | "expense";
type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";
type ScheduleStatus = "active" | "paused" | "ended";

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
  frequency: Frequency;
  day_of_month: number | null;
  weekday: number | null;
  start_date: string;
  end_date: string | null;
  next_due_date: string;
  status: ScheduleStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type Props = {
  userId: string;
  categories: Category[];
};

type FormValues = {
  name: string;
  kind: ScheduleKind;
  amount: string;
  categoryId: string;
  frequency: Frequency;
  dayOfMonth: string;
  weekday: string;
  startDate: string;
  endDate: string;
  notes: string;
};

const emptyForm = (): FormValues => ({
  name: "",
  kind: "expense",
  amount: "",
  categoryId: "",
  frequency: "monthly",
  dayOfMonth: "1",
  weekday: "5",
  startDate: getLocalDateString(),
  endDate: "",
  notes: "",
});

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MAX_BIGINT = 9_223_372_036_854_775_807n;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function dateParts(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function makeDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));

  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Finds the first scheduled date on or after startDate.
 * Weekly schedules use weekday (Sunday = 0).
 * Monthly/quarterly/yearly schedules use dayOfMonth.
 * Longer intervals are anchored to the start date's month/year.
 */
function calculateFirstDueDate(
  frequency: Frequency,
  startDate: string,
  dayOfMonth: number,
  weekday: number
): string {
  const start = dateParts(startDate);

  if (frequency === "weekly") {
    const startWeekday = new Date(
      Date.UTC(start.year, start.month - 1, start.day)
    ).getUTCDay();

    const daysAhead = (weekday - startWeekday + 7) % 7;
    const due = new Date(
      Date.UTC(start.year, start.month - 1, start.day + daysAhead)
    );

    return makeDate(
      due.getUTCFullYear(),
      due.getUTCMonth() + 1,
      due.getUTCDate()
    );
  }

  const interval = frequency === "quarterly" ? 3 : 1;
  let offset = 0;

  while (offset <= 1200) {
    const monthIndex = start.year * 12 + (start.month - 1) + offset;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const day = Math.min(dayOfMonth, daysInMonth(year, month));
    const candidate = makeDate(year, month, day);

    if (candidate >= startDate) return candidate;

    offset += frequency === "yearly" ? 12 : interval;
  }

  throw new Error("Could not calculate the next due date.");
}

function validateName(name: string): string {
  const value = name.trim();

  if (!value) throw new Error("Enter a schedule name.");
  if (value.length > 120) {
    throw new Error("Schedule names must be 120 characters or fewer.");
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error("The schedule name contains invalid characters.");
    }
  }

  return value;
}

function databaseErrorMessage(message: string): string {
  if (message.includes("recurring_schedules")) {
    return `Could not save the schedule: ${message}`;
  }

  if (message.includes("row-level security")) {
    return "The database rejected this operation. Check your account permissions.";
  }

  if (message.includes("23505")) {
    return "A conflicting schedule record already exists.";
  }

  if (message.includes("23503")) {
    return "The selected category or related record is no longer available.";
  }

  if (message.includes("23514")) {
    return "One or more values violate a database constraint.";
  }

  return message;
}

export default function RecurringSchedules({
  userId,
  categories,
}: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [form, setForm] = useState<FormValues>(emptyForm);

  const availableCategories = categories.filter(
    (category) =>
      category.kind === form.kind &&
      (category.is_active || category.id === editing?.category_id)
  );

  const loadSchedules = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from("recurring_schedules")
      .select(
        "id, user_id, name, kind, amount_paisa, category_id, frequency, " +
        "day_of_month, weekday, start_date, end_date, next_due_date, " +
        "status, notes, created_at, updated_at"
      )
      .eq("user_id", userId)
      .order("next_due_date", { ascending: true })
      .order("created_at", { ascending: false });

    if (queryError) {
      throw new Error(queryError.message);
    }

    setSchedules((data ?? []) as unknown as Schedule[]);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;

    async function initialLoad() {
      try {
        const { data, error: queryError } = await supabase
          .from("recurring_schedules")
          .select(
            "id, user_id, name, kind, amount_paisa, category_id, frequency, " +
            "day_of_month, weekday, start_date, end_date, next_due_date, " +
            "status, notes, created_at, updated_at"
          )
          .eq("user_id", userId)
          .order("next_due_date", { ascending: true })
          .order("created_at", { ascending: false });

        if (queryError) throw new Error(queryError.message);

        if (!cancelled) {
          setSchedules((data ?? []) as unknown as Schedule[]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not load recurring schedules."
          );
        }
      } finally {
        if (!cancelled) {
          setLoadedUserId(userId);
          setLoading(false);
        }
      }
    }

    void initialLoad();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const userSchedules = loadedUserId === userId ? schedules : [];
  const isLoading = loading || loadedUserId !== userId;

  function updateForm<K extends keyof FormValues>(
    key: K,
    value: FormValues[K]
  ) {
    setForm((previous) => {
      const next = { ...previous, [key]: value };

      if (key === "kind") {
        next.categoryId = "";
      }

      return next;
    });
  }

  function resetForm() {
    setEditing(null);
    setForm(emptyForm());
    setError("");
    setSuccess("");
  }

  function startEditing(schedule: Schedule) {
    setEditing(schedule);
    setForm({
      name: schedule.name,
      kind: schedule.kind,
      amount: (() => {
        const paisa = BigInt(schedule.amount_paisa);
        return `${paisa / 100n}.${String(paisa % 100n).padStart(2, "0")}`;
      })(),
      categoryId: schedule.category_id,
      frequency: schedule.frequency,
      dayOfMonth: String(schedule.day_of_month ?? 1),
      weekday: String(schedule.weekday ?? 5),
      startDate: schedule.start_date,
      endDate: schedule.end_date ?? "",
      notes: schedule.notes ?? "",
    });
    setError("");
    setSuccess("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    let name: string;
    let amountPaisa: bigint;

    try {
      name = validateName(form.name);
      amountPaisa = parseTakaToPaisa(form.amount);

      if (amountPaisa > MAX_BIGINT) {
        throw new Error("The amount exceeds the database limit.");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Please check your inputs."
      );
      return;
    }

    if (!validDate(form.startDate)) {
      setError("Choose a valid start date.");
      return;
    }

    if (form.endDate && !validDate(form.endDate)) {
      setError("Choose a valid end date.");
      return;
    }

    if (form.endDate && form.endDate < form.startDate) {
      setError("The end date cannot be before the start date.");
      return;
    }

    const dayOfMonth = Number(form.dayOfMonth);
    const weekday = Number(form.weekday);

    if (
      form.frequency !== "weekly" &&
      (!Number.isInteger(dayOfMonth) ||
        dayOfMonth < 1 ||
        dayOfMonth > 31)
    ) {
      setError("Day of month must be between 1 and 31.");
      return;
    }

    if (
      form.frequency === "weekly" &&
      (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    ) {
      setError("Choose a valid weekday.");
      return;
    }

    const category = categories.find(
      (item) =>
        item.id === form.categoryId &&
        item.kind === form.kind &&
        (item.is_active || item.id === editing?.category_id)
    );

    if (!category) {
      setError("Choose an available category of the correct type.");
      return;
    }

    let nextDueDate: string;

    try {
      nextDueDate = calculateFirstDueDate(
        form.frequency,
        form.startDate,
        dayOfMonth,
        weekday
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not calculate the next due date."
      );
      return;
    }

    if (form.endDate && nextDueDate > form.endDate) {
      setError(
        "The end date is before the first scheduled occurrence. " +
        "Change the start date, frequency, or end date."
      );
      return;
    }

    const payload = {
      user_id: userId,
      name,
      kind: form.kind,
      amount_paisa: amountPaisa.toString(),
      category_id: form.categoryId,
      frequency: form.frequency,
      day_of_month:
        form.frequency === "weekly" ? null : dayOfMonth,
      weekday:
        form.frequency === "weekly" ? weekday : null,
      start_date: form.startDate,
      end_date: form.endDate || null,
      next_due_date: nextDueDate,
      notes: form.notes.trim() || null,
    };

    setSaving(true);

    try {
      if (editing) {
        const { data, error: updateError } = await supabase
          .from("recurring_schedules")
          .update(payload)
          .eq("id", editing.id)
          .eq("user_id", userId)
          .select("id")
          .single();

        if (updateError) throw new Error(updateError.message);
        if (!data) throw new Error("The schedule was not updated.");
      } else {
        const { data, error: insertError } = await supabase
          .from("recurring_schedules")
          .insert({
            ...payload,
            status: "active",
          })
          .select("id")
          .single();

        if (insertError) throw new Error(insertError.message);
        if (!data) throw new Error("The schedule was not created.");
      }

      await loadSchedules();
      resetForm();
      setSuccess(
        editing
          ? "Recurring schedule updated."
          : "Recurring schedule created."
      );
    } catch (err) {
      setError(
        databaseErrorMessage(
          err instanceof Error
            ? err.message
            : "Could not save the schedule."
        )
      );
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(
    schedule: Schedule,
    nextStatus: ScheduleStatus
  ) {
    const action =
      nextStatus === "paused"
        ? "pause"
        : nextStatus === "active"
          ? "resume"
          : "end";

    if (
      !window.confirm(
        `Are you sure you want to ${action} "${schedule.name}"?`
      )
    ) {
      return;
    }

    setError("");
    setSuccess("");
    setBusyId(schedule.id);

    try {
      const { data, error: updateError } = await supabase
        .from("recurring_schedules")
        .update({ status: nextStatus })
        .eq("id", schedule.id)
        .eq("user_id", userId)
        .eq("status", schedule.status)
        .select("id")
        .single();

      if (updateError) throw new Error(updateError.message);
      if (!data) {
        throw new Error(
          "The schedule may have changed. Refresh and try again."
        );
      }

      await loadSchedules();
      setSuccess(`Schedule "${schedule.name}" is now ${nextStatus}.`);
    } catch (err) {
      setError(
        databaseErrorMessage(
          err instanceof Error
            ? err.message
            : "Could not change schedule status."
        )
      );
    } finally {
      setBusyId(null);
    }
  }

  const visibleSchedules = userSchedules.filter((schedule) =>
    showInactive
      ? true
      : schedule.status === "active"
  );

  return (
    <section className="panel recurring-panel">
      <div className="recurring-heading">
        <div>
          <h2>Recurring schedules</h2>
          <p className="muted">
            Define repeating income and expenses. These schedules do not
            create transactions or change your current balance yet.
          </p>
        </div>
        <span className="pill">{userSchedules.length} total</span>
      </div>

      <form className="recurring-form" onSubmit={handleSubmit}>
        <h3>{editing ? "Edit schedule" : "Create a schedule"}</h3>

        <label className="field-label">
          Schedule name
          <input
            value={form.name}
            onChange={(event) => updateForm("name", event.target.value)}
            maxLength={120}
            placeholder="e.g. Monthly salary"
            required
          />
        </label>

        <div className="recurring-form-grid">
          <label className="field-label">
            Type
            <select
              value={form.kind}
              onChange={(event) =>
                updateForm("kind", event.target.value as ScheduleKind)
              }
            >
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
          </label>

          <label className="field-label">
            Amount (৳)
            <input
              type="text"
              inputMode="decimal"
              value={form.amount}
              onChange={(event) => updateForm("amount", event.target.value)}
              placeholder="e.g. 25000.00"
              required
            />
          </label>

          <label className="field-label">
            Category
            <select
              value={form.categoryId}
              onChange={(event) =>
                updateForm("categoryId", event.target.value)
              }
              required
            >
              <option value="">Choose category</option>
              {availableCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {!category.is_active ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label">
            Frequency
            <select
              value={form.frequency}
              onChange={(event) =>
                updateForm("frequency", event.target.value as Frequency)
              }
            >
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>

          {form.frequency === "weekly" ? (
            <label className="field-label">
              Repeat on
              <select
                value={form.weekday}
                onChange={(event) => updateForm("weekday", event.target.value)}
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field-label">
              Day of month
              <select
                value={form.dayOfMonth}
                onChange={(event) =>
                  updateForm("dayOfMonth", event.target.value)
                }
              >
                {Array.from({ length: 31 }, (_, index) => index + 1).map(
                  (day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  )
                )}
              </select>
              <span className="muted">
                Months with fewer days use their last day.
              </span>
            </label>
          )}

          <label className="field-label">
            Start date
            <input
              type="date"
              value={form.startDate}
              onChange={(event) => updateForm("startDate", event.target.value)}
              required
            />
          </label>

          <label className="field-label">
            End date (optional)
            <input
              type="date"
              value={form.endDate}
              onChange={(event) => updateForm("endDate", event.target.value)}
              min={form.startDate}
            />
          </label>
        </div>

        <label className="field-label">
          Notes (optional)
          <textarea
            value={form.notes}
            onChange={(event) => updateForm("notes", event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Additional details"
          />
        </label>

        {error && <p className="error">{error}</p>}
        {success && <p className="success">{success}</p>}

        <div className="recurring-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={saving}
          >
            {saving
              ? "Saving..."
              : editing
                ? "Save changes"
                : "Create schedule"}
          </button>

          {editing && (
            <button
              type="button"
              className="secondary-button"
              onClick={resetForm}
              disabled={saving}
            >
              Cancel editing
            </button>
          )}
        </div>
      </form>

      <div className="recurring-list-heading">
        <h3>Your schedules</h3>
        <label className="recurring-toggle">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
          />
          Show paused and ended
        </label>
      </div>

      {isLoading ? (
        <p className="muted">Loading schedules...</p>
      ) : visibleSchedules.length === 0 ? (
        <p className="muted">
          No schedules to show. Create your first recurring schedule above.
        </p>
      ) : (
        <div className="recurring-list">
          {visibleSchedules.map((schedule) => {
            const category = categories.find(
              (item) => item.id === schedule.category_id
            );

            return (
              <article className="recurring-item" key={schedule.id}>
                <div className="recurring-item-main">
                  <div className="recurring-item-title">
                    <strong>{schedule.name}</strong>
                    <span
                      className={`schedule-status status-${schedule.status}`}
                    >
                      {schedule.status}
                    </span>
                    <span className="pill">
                      {schedule.kind === "income" ? "Income" : "Expense"}
                    </span>
                  </div>

                  <strong className="recurring-amount">
                    {schedule.kind === "expense" ? "−" : "+"}
                    {formatPaisa(schedule.amount_paisa)}
                  </strong>

                  <div className="recurring-meta">
                    <span>{category?.name ?? "Unknown category"}</span>
                    <span>
                      {schedule.frequency.charAt(0).toUpperCase() +
                        schedule.frequency.slice(1)}
                    </span>
                    <span>Next due: {schedule.next_due_date}</span>
                    <span>Starts: {schedule.start_date}</span>
                    {schedule.end_date && (
                      <span>Ends: {schedule.end_date}</span>
                    )}
                    {schedule.frequency === "weekly" &&
                      schedule.weekday !== null && (
                        <span>
                          Every {WEEKDAYS[schedule.weekday]}
                        </span>
                      )}
                    {schedule.frequency !== "weekly" &&
                      schedule.day_of_month !== null && (
                        <span>Day {schedule.day_of_month}</span>
                      )}
                  </div>

                  {schedule.notes && (
                    <p className="muted recurring-notes">{schedule.notes}</p>
                  )}
                </div>

                <div className="recurring-item-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => startEditing(schedule)}
                    disabled={
                      busyId === schedule.id ||
                      schedule.status === "ended"
                    }
                  >
                    Edit
                  </button>

                  {schedule.status === "active" && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => changeStatus(schedule, "paused")}
                      disabled={busyId === schedule.id}
                    >
                      {busyId === schedule.id ? "Updating..." : "Pause"}
                    </button>
                  )}

                  {schedule.status === "paused" && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => changeStatus(schedule, "active")}
                      disabled={busyId === schedule.id}
                    >
                      {busyId === schedule.id ? "Updating..." : "Resume"}
                    </button>
                  )}

                  {schedule.status !== "ended" && (
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => changeStatus(schedule, "ended")}
                      disabled={busyId === schedule.id}
                    >
                      End
                    </button>
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
