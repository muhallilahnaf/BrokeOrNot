
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatPaisa } from "../lib/money";
import "./CalendarForecast.css";

type Kind = "income" | "expense";
type WeekStart = "sunday" | "monday" | "saturday";
type OccurrenceStatus = "pending" | "paid" | "skipped" | "cancelled";

type Props = {
  userId: string;
  openingBalancePaisa: string | number;
  openingBalanceDate: string;
  weekStartsOn: WeekStart;
  forecastHorizonMonths: number;
};

type Transaction = {
  id: string;
  transaction_date: string;
  description: string;
  kind: Kind;
  amount_paisa: string | number;
  source: string;
};

type Schedule = {
  id: string;
  name: string;
  kind: Kind;
  amount_paisa: string | number;
};

type Occurrence = {
  id: string;
  schedule_id: string;
  due_date: string;
  status: OccurrenceStatus;
  transaction_id: string | null;
};

type CalendarEntry = {
  id: string;
  date: string;
  title: string;
  kind: Kind;
  amount: bigint;
  type: "transaction" | "scheduled";
  status?: OccurrenceStatus;
};

function dateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftMonth(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function monthStart(value: Date): string {
  return dateString(new Date(value.getFullYear(), value.getMonth(), 1));
}

function monthEnd(value: Date): string {
  return dateString(new Date(value.getFullYear(), value.getMonth() + 1, 0));
}

function monthLabel(value: Date): string {
  return value.toLocaleDateString("en-BD", {
    month: "long",
    year: "numeric",
  });
}

function safeAmount(value: string | number): bigint {
  return BigInt(value);
}

function moneyTotal(value: bigint): string {
  return formatPaisa(value);
}

function addSigned(
  balance: bigint,
  kind: Kind,
  amount: bigint,
): bigint {
  return kind === "income" ? balance + amount : balance - amount;
}

function getWeekdayIndex(start: WeekStart): number {
  if (start === "monday") return 1;
  if (start === "saturday") return 6;
  return 0;
}

export default function CalendarForecast({
  userId,
  openingBalancePaisa,
  openingBalanceDate,
  weekStartsOn,
  forecastHorizonMonths,
}: Props) {
  const [selectedMonth, setSelectedMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const today = dateString(new Date());

  const loadData = useCallback(async () => {
    const [transactionRows, occurrenceRows, scheduleRows] =
      await Promise.all([
          supabase
            .from("transactions")
            .select(
              "id,transaction_date,description,kind,amount_paisa,source",
            )
            .eq("user_id", userId)
            .gte("transaction_date", openingBalanceDate)
            .order("transaction_date", { ascending: true }),

          supabase
            .from("schedule_occurrences")
            .select("id,schedule_id,due_date,status,transaction_id")
            .eq("user_id", userId)
            .gte("due_date", openingBalanceDate)
            .order("due_date", { ascending: true }),

          supabase
            .from("recurring_schedules")
            .select("id,name,kind,amount_paisa")
            .eq("user_id", userId),
      ]);

    if (transactionRows.error) throw transactionRows.error;
    if (occurrenceRows.error) throw occurrenceRows.error;
    if (scheduleRows.error) throw scheduleRows.error;

    return {
      transactions: (transactionRows.data ?? []) as unknown as Transaction[],
      occurrences: (occurrenceRows.data ?? []) as unknown as Occurrence[],
      schedules: (scheduleRows.data ?? []) as unknown as Schedule[],
    };
  }, [userId, openingBalanceDate]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const data = await loadData();
        if (active) {
          setTransactions(data.transactions);
          setOccurrences(data.occurrences);
          setSchedules(data.schedules);
          setError("");
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Could not load calendar data.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void refresh();
    return () => { active = false; };
  }, [loadData, refreshKey]);

  const scheduleById = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, schedule])),
    [schedules],
  );

  const transactionEntries = useMemo<CalendarEntry[]>(
    () =>
      transactions.map((transaction) => ({
        id: `transaction-${transaction.id}`,
        date: transaction.transaction_date,
        title: transaction.description,
        kind: transaction.kind,
        amount: safeAmount(transaction.amount_paisa),
        type: "transaction",
      })),
    [transactions],
  );

  const scheduledEntries = useMemo<CalendarEntry[]>(
    () =>
      occurrences
        .filter((occurrence) => occurrence.status === "pending")
        .flatMap((occurrence) => {
          const schedule = scheduleById.get(occurrence.schedule_id);
          if (!schedule) return [];

          return [{
            id: `occurrence-${occurrence.id}`,
            date: occurrence.due_date,
            title: schedule.name,
            kind: schedule.kind,
            amount: safeAmount(schedule.amount_paisa),
            type: "scheduled" as const,
            status: occurrence.status,
          }];
        }),
    [occurrences, scheduleById],
  );

  const allEntries = useMemo(
    () => [...transactionEntries, ...scheduledEntries],
    [transactionEntries, scheduledEntries],
  );

  const selectedMonthEntries = useMemo(
    () =>
      allEntries.filter(
        (entry) =>
          entry.date >= monthStart(selectedMonth) &&
          entry.date <= monthEnd(selectedMonth),
      ),
    [allEntries, selectedMonth],
  );

  const monthTotals = useMemo(() => {
    let income = 0n;
    let expense = 0n;

    for (const entry of selectedMonthEntries) {
      if (entry.kind === "income") income += entry.amount;
      else expense += entry.amount;
    }

    return { income, expense, net: income - expense };
  }, [selectedMonthEntries]);

  // Actual balance through today, excluding future-dated transactions.
  const actualBalance = useMemo(() => {
    let balance = safeAmount(openingBalancePaisa);

    for (const transaction of transactions) {
      if (
        transaction.transaction_date >= openingBalanceDate &&
        transaction.transaction_date <= today
      ) {
        balance = addSigned(
          balance,
          transaction.kind,
          safeAmount(transaction.amount_paisa),
        );
      }
    }

    return balance;
  }, [
    transactions,
    openingBalancePaisa,
    openingBalanceDate,
    today,
  ]);

  // Forecast from today onward: future-dated recorded transactions plus
  // pending occurrences. Paid occurrences are not added again.
  const forecast = useMemo(() => {
    const horizon = Math.min(
      60,
      Math.max(1, Math.trunc(forecastHorizonMonths || 1)),
    );
    const horizonEnd = dateString(
      new Date(
        new Date().getFullYear(),
        new Date().getMonth() + horizon,
        new Date().getDate(),
      ),
    );

    const futureEntries = allEntries.filter(
      (entry) => entry.date > today && entry.date <= horizonEnd,
    );

    const byDate = new Map<string, CalendarEntry[]>();

    for (const entry of futureEntries) {
      const existing = byDate.get(entry.date) ?? [];
      existing.push(entry);
      byDate.set(entry.date, existing);
    }

    const days: { date: string; balance: bigint }[] = [];
    let balance = actualBalance;
    let day = parseDate(today);
    const lastDay = parseDate(horizonEnd);

    while (day <= lastDay) {
      const key = dateString(day);

      for (const entry of byDate.get(key) ?? []) {
        balance = addSigned(balance, entry.kind, entry.amount);
      }

      days.push({ date: key, balance });
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    }

    return {
      horizonEnd,
      endingBalance: balance,
      futureEntries,
      days,
    };
  }, [allEntries, actualBalance, today, forecastHorizonMonths]);

  const projectedBalanceByDate = useMemo(
    () => new Map(forecast.days.map((day) => [day.date, day.balance])),
    [forecast.days],
  );

  const calendarCells = useMemo(() => {
    const first = parseDate(monthStart(selectedMonth));
    const last = parseDate(monthEnd(selectedMonth));
    const offset =
      (first.getDay() - getWeekdayIndex(weekStartsOn) + 7) % 7;
    const cells: (string | null)[] = Array(offset).fill(null);

    for (let day = 1; day <= last.getDate(); day++) {
      cells.push(
        dateString(
          new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), day),
        ),
      );
    }

    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [selectedMonth, weekStartsOn]);

  const weekdayLabels = useMemo(() => {
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const start = getWeekdayIndex(weekStartsOn);
    return [...labels.slice(start), ...labels.slice(0, start)];
  }, [weekStartsOn]);

  function entriesForDate(date: string): CalendarEntry[] {
    return selectedMonthEntries
      .filter((entry) => entry.date === date)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "scheduled" ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
  }

  return (
    <section className="calendar-forecast">
      <div className="calendar-heading">
        <div>
          <h2>Calendar &amp; Cash-Flow Forecast</h2>
          <p>Recorded transactions and pending scheduled payments.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError("");
            setLoading(true);
            setRefreshKey((key) => key + 1);
          }}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <p className="cf-error">{error}</p>}

      <div className="cf-summary-grid">
        <article className="cf-summary">
          <span>Actual balance through today</span>
          <strong>{moneyTotal(actualBalance)}</strong>
        </article>
        <article className="cf-summary">
          <span>Selected month income</span>
          <strong className="cf-income">{moneyTotal(monthTotals.income)}</strong>
        </article>
        <article className="cf-summary">
          <span>Selected month expenses</span>
          <strong className="cf-expense">{moneyTotal(monthTotals.expense)}</strong>
        </article>
        <article className="cf-summary">
          <span>Selected month net</span>
          <strong>{moneyTotal(monthTotals.net)}</strong>
        </article>
      </div>

      <section className="cf-panel">
        <div className="cf-month-nav">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setSelectedMonth((month) => shiftMonth(month, -1))}
          >
            ←
          </button>
          <h3>{monthLabel(selectedMonth)}</h3>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setSelectedMonth((month) => shiftMonth(month, 1))}
          >
            →
          </button>
        </div>

        {loading ? (
          <p>Loading calendar…</p>
        ) : (
          <div className="cf-calendar">
            {weekdayLabels.map((label) => (
              <div className="cf-weekday" key={label}>{label}</div>
            ))}

            {calendarCells.map((date, index) => {
              if (!date) {
                return <div className="cf-day cf-empty" key={`empty-${index}`} />;
              }

              const entries = entriesForDate(date);
              const isToday = date === today;
              const projected = projectedBalanceByDate.get(date);

              return (
                <div
                  className={`cf-day${isToday ? " cf-today" : ""}`}
                  key={date}
                >
                  <div className="cf-day-number">{parseDate(date).getDate()}</div>

                  {entries.slice(0, 3).map((entry) => (
                    <div
                      className={`cf-event ${entry.kind === "income" ? "cf-event-income" : "cf-event-expense"
                        } ${entry.type === "scheduled" ? "cf-event-pending" : ""}`}
                      key={entry.id}
                      title={`${entry.title}: ${moneyTotal(entry.amount)}`}
                    >
                      <span>{entry.type === "scheduled" ? "◷ " : ""}{entry.title}</span>
                      <strong>
                        {entry.kind === "expense" ? "−" : "+"}
                        {moneyTotal(entry.amount)}
                      </strong>
                    </div>
                  ))}

                  {entries.length > 3 && (
                    <small>+{entries.length - 3} more</small>
                  )}

                  {projected !== undefined && (
                    <div className="cf-projected">
                      Projected: {moneyTotal(projected)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="cf-legend">
          <span><i className="cf-legend-income" /> Income</span>
          <span><i className="cf-legend-expense" /> Expense</span>
          <span><i className="cf-legend-pending" /> Pending schedule</span>
        </div>
      </section>

      <section className="cf-panel">
        <h3>Cash-flow forecast</h3>
        <p>
          From today through {forecast.horizonEnd} (
          {Math.min(60, Math.max(1, Math.trunc(forecastHorizonMonths || 1)))} months).
        </p>

        <div className="cf-forecast-result">
          <span>Projected ending balance</span>
          <strong>{moneyTotal(forecast.endingBalance)}</strong>
        </div>

        <h4>Upcoming projected events</h4>

        {forecast.futureEntries.length === 0 ? (
          <p>No future transactions or pending occurrences in this forecast window.</p>
        ) : (
          <div className="cf-upcoming-list">
            {[...forecast.futureEntries]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((entry) => (
                <div className="cf-upcoming-row" key={entry.id}>
                  <div>
                    <strong>{entry.title}</strong>
                    <small>
                      {entry.date} ·{" "}
                      {entry.type === "scheduled"
                        ? "Pending schedule"
                        : "Recorded transaction"}
                    </small>
                  </div>
                  <strong className={entry.kind === "income" ? "cf-income" : "cf-expense"}>
                    {entry.kind === "expense" ? "−" : "+"}
                    {moneyTotal(entry.amount)}
                  </strong>
                </div>
              ))}
          </div>
        )}
      </section>

      <section className="cf-panel">
        <h3>Selected month details</h3>

        {selectedMonthEntries.length === 0 ? (
          <p>No transactions or pending occurrences in this month.</p>
        ) : (
          <div className="cf-upcoming-list">
            {selectedMonthEntries
              .slice()
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((entry) => (
                <div className="cf-upcoming-row" key={entry.id}>
                  <div>
                    <strong>{entry.title}</strong>
                    <small>
                      {entry.date} ·{" "}
                      {entry.type === "scheduled"
                        ? "Pending schedule"
                        : "Recorded transaction"}
                    </small>
                  </div>
                  <strong className={entry.kind === "income" ? "cf-income" : "cf-expense"}>
                    {entry.kind === "expense" ? "−" : "+"}
                    {moneyTotal(entry.amount)}
                  </strong>
                </div>
              ))}
          </div>
        )}
      </section>
    </section>
  );
}
