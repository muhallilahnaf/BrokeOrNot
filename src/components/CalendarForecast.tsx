
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatPaisa } from "../lib/money";
import type { EditableTransaction } from "./Transactions";
import "./CalendarForecast.css";

type Props = {
  userId: string;
  openingBalancePaisa: string | number;
  openingBalanceDate: string;
  weekStartsOn: "sunday" | "monday" | "saturday";
  forecastHorizonMonths: number;
  dataVersion: number;
  onEditTransaction: (transaction: EditableTransaction) => void;
  onTransactionChanged: () => void;
};

type Transaction = EditableTransaction;

type ScheduleOccurrence = {
  id: string;
  schedule_id: string;
  due_date: string;
  status: "pending" | "paid" | "skipped" | "cancelled";
  transaction_id: string | null;
};

type Schedule = {
  id: string;
  name: string;
  kind: "income" | "expense";
  amount_paisa: string | number;
};

type CalendarEntry = {
  id: string;
  date: string;
  description: string;
  kind: "income" | "expense";
  amount: bigint;
  type: "transaction" | "scheduled";
  source?: string;
  notes?: string | null;
};

type DailyTotals = {
  income: bigint;
  expense: bigint;
};

const PAGE_SIZE = 1000;

const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

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

function shiftMonth(value: string, amount: number): string {
  const date = parseDate(value);
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  return dateString(date);
}

function monthStart(value: string): string {
  const date = parseDate(value);
  date.setDate(1);
  return dateString(date);
}

function monthEnd(value: string): string {
  const date = parseDate(value);
  date.setMonth(date.getMonth() + 1, 0);
  return dateString(date);
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat("en-BD", {
    month: "long",
    year: "numeric",
  }).format(parseDate(value));
}

function fullDateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-BD", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseDate(value));
}

function safeAmount(value: string | number | bigint): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function moneyTotal(value: bigint): string {
  return formatPaisa(value);
}

function addSigned(
  balance: bigint,
  kind: "income" | "expense",
  amount: bigint,
): bigint {
  return kind === "income" ? balance + amount : balance - amount;
}

function getWeekdayIndex(
  weekStartsOn: Props["weekStartsOn"],
): number {
  if (weekStartsOn === "monday") return 1;
  if (weekStartsOn === "saturday") return 6;
  return 0;
}

function emptyTotals(): DailyTotals {
  return { income: 0n, expense: 0n };
}

function addToTotals(
  totals: DailyTotals,
  kind: "income" | "expense",
  amount: bigint,
): DailyTotals {
  if (kind === "income") {
    return { ...totals, income: totals.income + amount };
  }

  return { ...totals, expense: totals.expense + amount };
}

export default function CalendarForecast({
  userId,
  openingBalancePaisa,
  openingBalanceDate,
  weekStartsOn,
  forecastHorizonMonths,
  dataVersion,
  onEditTransaction,
  onTransactionChanged,
}: Props) {
  const today = dateString(new Date());
  const initialMonth = monthStart(today);

  const [visibleMonth, setVisibleMonth] = useState(initialMonth);
  const [selectedDate, setSelectedDate] = useState(today);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [occurrences, setOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [deletingTransactionId, setDeletingTransactionId] = useState<string | null>(null);

  const openingBalance = safeAmount(openingBalancePaisa);

  const horizonEnd = useMemo(() => {
    const date = parseDate(today);
    date.setMonth(date.getMonth() + forecastHorizonMonths);
    return dateString(date);
  }, [today, forecastHorizonMonths]);

  const loadData = useCallback(async () => {
      const loadedTransactions: Transaction[] = [];

      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error: transactionError } = await supabase
          .from("transactions")
          .select(
            "id,transaction_date,description,kind,amount_paisa,category_id,notes,source",
          )
          .eq("user_id", userId)
          .order("transaction_date", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);

        if (transactionError) throw transactionError;

        const page = (data ?? []) as Transaction[];
        loadedTransactions.push(...page);

        if (page.length < PAGE_SIZE) break;
      }

      const loadedOccurrences: ScheduleOccurrence[] = [];

      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error: occurrenceError } = await supabase
          .from("schedule_occurrences")
          .select("id,schedule_id,due_date,status,transaction_id")
          .eq("user_id", userId)
          .gte("due_date", openingBalanceDate)
          .lte("due_date", horizonEnd)
          .order("due_date", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);

        if (occurrenceError) throw occurrenceError;

        const page = (data ?? []) as ScheduleOccurrence[];
        loadedOccurrences.push(...page);

        if (page.length < PAGE_SIZE) break;
      }

      const { data: scheduleData, error: scheduleError } = await supabase
        .from("recurring_schedules")
        .select("id,name,kind,amount_paisa")
        .eq("user_id", userId);

      if (scheduleError) throw scheduleError;

      return {
        transactions: loadedTransactions,
        occurrences: loadedOccurrences,
        schedules: (scheduleData ?? []) as unknown as Schedule[],
      };
  }, [userId, openingBalanceDate, horizonEnd]);

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
          console.error("Failed to load calendar data:", err);
          setError(
            err instanceof Error
              ? err.message
              : "Could not load calendar and forecast data.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void refresh();
    return () => { active = false; };
  }, [loadData, refreshKey, dataVersion]);

  const scheduleById = useMemo(() => {
    return new Map(schedules.map((schedule) => [schedule.id, schedule]));
  }, [schedules]);

  const transactionEntries = useMemo<CalendarEntry[]>(() => {
    return transactions.map((transaction) => ({
      id: transaction.id,
      date: transaction.transaction_date,
      description: transaction.description,
      kind: transaction.kind,
      amount: safeAmount(transaction.amount_paisa),
      type: "transaction",
      source: transaction.source,
      notes: transaction.notes,
    }));
  }, [transactions]);

  // Pending occurrences are forecast items, not completed transactions.
  const scheduledEntries = useMemo<CalendarEntry[]>(() => {
    return occurrences.flatMap((occurrence) => {
      if (occurrence.status !== "pending") return [];

      const schedule = scheduleById.get(occurrence.schedule_id);
      if (!schedule) return [];

      return [
        {
          id: occurrence.id,
          date: occurrence.due_date,
          description: schedule.name,
          kind: schedule.kind,
          amount: safeAmount(schedule.amount_paisa),
          type: "scheduled" as const,
        },
      ];
    });
  }, [occurrences, scheduleById]);

  const allEntries = useMemo(
    () => [...transactionEntries, ...scheduledEntries],
    [transactionEntries, scheduledEntries],
  );

  const selectedMonthEntries = useMemo(() => {
    const monthKey = visibleMonth.slice(0, 7);

    return allEntries
      .filter(
        (entry) =>
          entry.date.startsWith(monthKey),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [allEntries, visibleMonth]);

  // Daily calendar totals combine recorded transactions and pending scheduled
  // occurrences, so each day provides a compact view of activity and plans.
  const dailyTotals = useMemo(() => {
    const totals = new Map<string, DailyTotals>();

    for (const entry of selectedMonthEntries) {
      const current = totals.get(entry.date) ?? emptyTotals();
      totals.set(
        entry.date,
        addToTotals(current, entry.kind, entry.amount),
      );
    }

    return totals;
  }, [selectedMonthEntries]);

  // Actual balance includes recorded transactions through today.
  const actualBalance = useMemo(() => {
    return transactions.reduce((balance, transaction) => {
      if (
        transaction.transaction_date < openingBalanceDate ||
        transaction.transaction_date > today
      ) {
        return balance;
      }

      return addSigned(
        balance,
        transaction.kind,
        safeAmount(transaction.amount_paisa),
      );
    }, openingBalance);
  }, [transactions, openingBalance, openingBalanceDate, today]);

  const actualBalanceByDate = useMemo(() => {
    const dailyChanges = new Map<string, bigint>();

    for (const transaction of transactions) {
      if (
        transaction.transaction_date < openingBalanceDate ||
        transaction.transaction_date > today
      ) {
        continue;
      }

      const previous = dailyChanges.get(transaction.transaction_date) ?? 0n;
      dailyChanges.set(
        transaction.transaction_date,
        addSigned(
          previous,
          transaction.kind,
          safeAmount(transaction.amount_paisa),
        ),
      );
    }

    const balances = new Map<string, bigint>();
    const cursor = parseDate(openingBalanceDate);
    const lastDate = parseDate(today);
    let balance = openingBalance;

    while (cursor <= lastDate) {
      const date = dateString(cursor);
      balance += dailyChanges.get(date) ?? 0n;
      balances.set(date, balance);
      cursor.setDate(cursor.getDate() + 1);
    }

    return balances;
  }, [transactions, openingBalance, openingBalanceDate, today]);

  // Balance at the start of today, before today's recorded transactions.
  const openingBalanceToday = useMemo(() => {
    return transactions.reduce((balance, transaction) => {
      if (
        transaction.transaction_date < openingBalanceDate ||
        transaction.transaction_date >= today
      ) {
        return balance;
      }

      return addSigned(
        balance,
        transaction.kind,
        safeAmount(transaction.amount_paisa),
      );
    }, openingBalance);
  }, [transactions, openingBalance, openingBalanceDate, today]);

  // Do not add today's recorded transactions again: actualBalance already
  // includes them. Pending scheduled occurrences due today remain forecast items.
  const forecastEntries = useMemo(
    () =>
      allEntries.filter(
        (entry) =>
          entry.date >= today &&
          entry.date <= horizonEnd &&
          !(entry.date === today && entry.type === "transaction"),
      ),
    [allEntries, today, horizonEnd],
  );

  const projectedBalanceByDate = useMemo(() => {
    const entriesByDate = new Map<string, CalendarEntry[]>();

    for (const entry of forecastEntries) {
      const existing = entriesByDate.get(entry.date) ?? [];
      existing.push(entry);
      entriesByDate.set(entry.date, existing);
    }

    const result = new Map<string, bigint>();
    let balance = actualBalance;
    const cursor = parseDate(today);
    const lastDate = parseDate(horizonEnd);

    while (cursor <= lastDate) {
      const currentDate = dateString(cursor);

      for (const entry of entriesByDate.get(currentDate) ?? []) {
        balance = addSigned(balance, entry.kind, entry.amount);
      }

      result.set(currentDate, balance);
      cursor.setDate(cursor.getDate() + 1);
    }

    return result;
  }, [forecastEntries, actualBalance, today, horizonEnd]);

  const calendarCells = useMemo(() => {
    const firstDate = parseDate(monthStart(visibleMonth));
    const lastDate = parseDate(monthEnd(visibleMonth));
    const firstWeekday = firstDate.getDay();
    const weekOffset =
      (firstWeekday - getWeekdayIndex(weekStartsOn) + 7) % 7;
    const cells: Array<string | null> = [];

    for (let index = 0; index < weekOffset; index++) {
      cells.push(null);
    }

    const cursor = new Date(firstDate);

    while (cursor <= lastDate) {
      cells.push(dateString(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    while (cells.length % 7 !== 0) {
      cells.push(null);
    }

    return cells;
  }, [visibleMonth, weekStartsOn]);

  const weekdayHeaders = useMemo(() => {
    const startIndex = getWeekdayIndex(weekStartsOn);

    return WEEKDAY_LABELS.map(
      (_, index) => WEEKDAY_LABELS[(startIndex + index) % 7],
    );
  }, [weekStartsOn]);

  const selectedDayEntries = useMemo(() => {
    return allEntries
      .filter((entry) => entry.date === selectedDate)
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "transaction" ? -1 : 1;
        }

        return a.description.localeCompare(b.description);
      });
  }, [allEntries, selectedDate]);

  const selectedActualTransactions = useMemo(
    () =>
      transactions.filter(
        (transaction) => transaction.transaction_date === selectedDate,
      ),
    [transactions, selectedDate],
  );

  const transactionById = useMemo(
    () => new Map(transactions.map((transaction) => [transaction.id, transaction])),
    [transactions],
  );

  const selectedScheduledEntries = useMemo(
    () => selectedDayEntries.filter((entry) => entry.type === "scheduled"),
    [selectedDayEntries],
  );

  const selectedActualTotals = useMemo(() => {
    return selectedActualTransactions.reduce(
      (totals, transaction) =>
        addToTotals(
          totals,
          transaction.kind,
          safeAmount(transaction.amount_paisa),
        ),
      emptyTotals(),
    );
  }, [selectedActualTransactions]);

  const selectedScheduledTotals = useMemo(() => {
    return selectedScheduledEntries.reduce(
      (totals, entry) => addToTotals(totals, entry.kind, entry.amount),
      emptyTotals(),
    );
  }, [selectedScheduledEntries]);

  const selectedOpeningBalance = useMemo(() => {
    if (selectedDate < openingBalanceDate) return null;

    if (selectedDate === today) return openingBalanceToday;

    if (selectedDate < today) {
      return transactions.reduce((balance, transaction) => {
        if (
          transaction.transaction_date < openingBalanceDate ||
          transaction.transaction_date >= selectedDate
        ) {
          return balance;
        }

        return addSigned(
          balance,
          transaction.kind,
          safeAmount(transaction.amount_paisa),
        );
      }, openingBalance);
    }

    const previousDate = dateString(
      new Date(
        parseDate(selectedDate).getFullYear(),
        parseDate(selectedDate).getMonth(),
        parseDate(selectedDate).getDate() - 1,
      ),
    );

    if (previousDate < today) return actualBalance;

    return projectedBalanceByDate.get(previousDate) ?? null;
  }, [
    selectedDate,
    openingBalanceDate,
    today,
    openingBalanceToday,
    transactions,
    openingBalance,
    actualBalance,
    projectedBalanceByDate,
  ]);

  const selectedActualClosingBalance = useMemo(() => {
    if (
      selectedDate < openingBalanceDate ||
      selectedDate > today
    ) {
      return null;
    }

    return transactions.reduce((balance, transaction) => {
      if (
        transaction.transaction_date < openingBalanceDate ||
        transaction.transaction_date > selectedDate
      ) {
        return balance;
      }

      return addSigned(
        balance,
        transaction.kind,
        safeAmount(transaction.amount_paisa),
      );
    }, openingBalance);
  }, [
    transactions,
    openingBalance,
    openingBalanceDate,
    selectedDate,
    today,
  ]);

  const selectedProjectedBalance =
    projectedBalanceByDate.get(selectedDate) ?? null;

  const canShowProjection =
    selectedDate >= today && selectedDate <= horizonEnd;

  function goToMonth(amount: number) {
    const nextMonth = shiftMonth(visibleMonth, amount);
    setVisibleMonth(nextMonth);
    setSelectedDate(nextMonth);
  }

  function selectDay(date: string) {
    setSelectedDate(date);
  }

  async function deleteTransaction(transaction: Transaction) {
    if (!window.confirm(`Delete "${transaction.description}" permanently? This will change your tracked balance.`)) {
      return;
    }

    setDeletingTransactionId(transaction.id);
    setError("");

    try {
      const { data, error: deleteError } = await supabase
        .from("transactions")
        .delete()
        .eq("id", transaction.id)
        .eq("user_id", userId)
        .select("id")
        .maybeSingle();

      if (deleteError) throw deleteError;
      if (!data) {
        throw new Error("The transaction was not deleted. It may already have been removed.");
      }

      onTransactionChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not delete the transaction.",
      );
    } finally {
      setDeletingTransactionId(null);
    }
  }

  function transactionActions(transaction: Transaction) {
    return (
      <div className="cf-transaction-actions">
        <button
          type="button"
          className="secondary-button small-button"
          onClick={() => onEditTransaction(transaction)}
          disabled={deletingTransactionId !== null}
        >
          Edit
        </button>
        <button
          type="button"
          className="danger-button small-button"
          onClick={() => void deleteTransaction(transaction)}
          disabled={deletingTransactionId !== null}
        >
          {deletingTransactionId === transaction.id ? "Deleting…" : "Delete"}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <section className="cf-container">
        <p className="cf-status">Loading calendar and forecast…</p>
      </section>
    );
  }

  return (
    <section className="cf-container">
      <div className="cf-header">
        <div>
          <h2>Calendar &amp; Cash-Flow Forecast</h2>
          <p>
            See daily income, expenses, and how your balance may change.
          </p>
        </div>

        <button
          type="button"
          className="cf-refresh-button"
          onClick={() => {
            setError("");
            setLoading(true);
            setRefreshKey((key) => key + 1);
          }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="cf-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setError("");
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}

      <div className="cf-legend">
        <span className="cf-legend-income">Income</span>
        <span className="cf-legend-expense">Expense</span>
        <span className="cf-legend-actual">Actual balance</span>
        <span className="cf-legend-projected">Projected balance</span>
      </div>

      <div className="cf-month-navigation">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => goToMonth(-1)}
        >
          ‹
        </button>

        <h3>{monthLabel(visibleMonth)}</h3>

        <button
          type="button"
          aria-label="Next month"
          onClick={() => goToMonth(1)}
        >
          ›
        </button>

        <button
          type="button"
          className="cf-today-button"
          onClick={() => {
            setVisibleMonth(initialMonth);
            setSelectedDate(today);
          }}
        >
          Today
        </button>
      </div>

      <div className="cf-calendar-grid">
        {weekdayHeaders.map((day) => (
          <div className="cf-weekday" key={day}>
            {day}
          </div>
        ))}

        {calendarCells.map((date, index) => {
          if (!date) {
            return (
              <div
                className="cf-day cf-empty-day"
                key={`empty-${index}`}
                aria-hidden="true"
              />
            );
          }

          const totals = dailyTotals.get(date) ?? emptyTotals();
          const actual = actualBalanceByDate.get(date);
          const projected = projectedBalanceByDate.get(date);
          const isSelected = date === selectedDate;
          const isToday = date === today;
          const isBeforeOpening = date < openingBalanceDate;
          const hasEntries =
            totals.income > 0n || totals.expense > 0n;

          return (
            <button
              type="button"
              className={[
                "cf-day",
                isSelected ? "cf-day-selected" : "",
                isToday ? "cf-day-today" : "",
                isBeforeOpening ? "cf-day-before-opening" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={date}
              onClick={() => selectDay(date)}
              aria-pressed={isSelected}
              aria-label={`${fullDateLabel(date)}. Income ${moneyTotal(
                totals.income,
              )}, expense ${moneyTotal(totals.expense)}${actual !== undefined
                  ? `, actual balance ${moneyTotal(actual)}`
                  : ""
                }${projected !== undefined
                  ? `, projected balance ${moneyTotal(projected)}`
                  : ""
                }. Click to view details.`}
            >
              <span className="cf-day-number">
                {parseDate(date).getDate()}
                {isToday && <span className="cf-today-dot" />}
              </span>

              {totals.income > 0n && (
                <span className="cf-daily-total cf-daily-income">
                  <span>Income</span>
                  <strong>+{moneyTotal(totals.income)}</strong>
                </span>
              )}

              {totals.expense > 0n && (
                <span className="cf-daily-total cf-daily-expense">
                  <span>Expense</span>
                  <strong>−{moneyTotal(totals.expense)}</strong>
                </span>
              )}

              {actual !== undefined && (
                <span className="cf-actual">
                  <span>Actual</span>
                  <strong>{moneyTotal(actual)}</strong>
                </span>
              )}

              {projected !== undefined && (
                <span className="cf-projected">
                  <span>Projected</span>
                  <strong>{moneyTotal(projected)}</strong>
                </span>
              )}

              {!hasEntries && actual === undefined && projected === undefined && (
                <span className="cf-no-activity">No activity</span>
              )}
            </button>
          );
        })}
      </div>

      <p className="cf-calendar-help">
        Select any day to view its opening balance, detailed transactions,
        actual closing balance, and projected closing balance when available.
      </p>

      <section className="cf-detail-card" aria-live="polite">
        <div className="cf-detail-header">
          <div>
            <p className="cf-detail-eyebrow">Selected day</p>
            <h3>{fullDateLabel(selectedDate)}</h3>
          </div>

          {selectedDate === today && (
            <span className="cf-date-badge">Today</span>
          )}
        </div>

        {selectedDate < openingBalanceDate ? (
          <>
            <div className="cf-empty-state">
              This date is before your opening-balance date (
              {fullDateLabel(openingBalanceDate)}). No balance can be calculated
              from the configured opening balance for this day.
            </div>
            <div className="cf-detail-section">
              <div className="cf-section-heading">
                <h4>Transactions from this date</h4>
                <span>{selectedActualTransactions.length} recorded</span>
              </div>
              {selectedActualTransactions.length === 0 ? (
                <div className="cf-empty-state">No transactions on this date.</div>
              ) : (
                <div className="cf-transaction-list">
                  {selectedActualTransactions.map((transaction) => (
                    <div className="cf-transaction-row" key={transaction.id}>
                      <div className="cf-transaction-main">
                        <span
                          className={`cf-kind-indicator ${transaction.kind === "income" ? "cf-kind-income" : "cf-kind-expense"}`}
                          aria-hidden="true"
                        />
                        <div className="cf-transaction-description">
                          <strong>{transaction.description}</strong>
                          <span>Recorded transaction</span>
                          {transaction.notes && <span>{transaction.notes}</span>}
                        </div>
                      </div>
                      <strong className={transaction.kind === "income" ? "cf-text-income" : "cf-text-expense"}>
                        {transaction.kind === "income" ? "+" : "−"}
                        {moneyTotal(safeAmount(transaction.amount_paisa))}
                      </strong>
                      {transactionActions(transaction)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="cf-balance-summary">
              <div className="cf-balance-tile">
                <span>Opening balance</span>
                <strong>
                  {selectedOpeningBalance === null
                    ? "—"
                    : moneyTotal(selectedOpeningBalance)}
                </strong>
              </div>

              <div className="cf-balance-tile cf-balance-actual">
                <span>Actual closing balance</span>
                <strong>
                  {selectedActualClosingBalance === null
                    ? "Not available"
                    : moneyTotal(selectedActualClosingBalance)}
                </strong>
                <small>
                  {selectedDate > today
                    ? "Future date"
                    : "Based on recorded transactions"}
                </small>
              </div>

              <div className="cf-balance-tile cf-balance-projection">
                <span>Projected closing balance</span>
                <strong>
                  {selectedProjectedBalance === null
                    ? "Outside forecast range"
                    : moneyTotal(selectedProjectedBalance)}
                </strong>
                <small>
                  {canShowProjection
                    ? "Includes pending scheduled items"
                    : `Forecast horizon: ${forecastHorizonMonths} month(s)`}
                </small>
              </div>
            </div>

            <div className="cf-day-totals">
              <div className="cf-total-line">
                <span>Recorded income</span>
                <strong className="cf-text-income">
                  +{moneyTotal(selectedActualTotals.income)}
                </strong>
              </div>

              <div className="cf-total-line">
                <span>Recorded expenses</span>
                <strong className="cf-text-expense">
                  −{moneyTotal(selectedActualTotals.expense)}
                </strong>
              </div>

              <div className="cf-total-line">
                <span>Scheduled income (pending)</span>
                <strong className="cf-text-income">
                  +{moneyTotal(selectedScheduledTotals.income)}
                </strong>
              </div>

              <div className="cf-total-line">
                <span>Scheduled expenses (pending)</span>
                <strong className="cf-text-expense">
                  −{moneyTotal(selectedScheduledTotals.expense)}
                </strong>
              </div>
            </div>

            <div className="cf-detail-section">
              <div className="cf-section-heading">
                <h4>Income &amp; expense details</h4>
                <span>
                  {selectedActualTransactions.length} recorded ·{" "}
                  {selectedScheduledEntries.length} scheduled
                </span>
              </div>

              {selectedDayEntries.length === 0 ? (
                <div className="cf-empty-state">
                  No recorded transactions or pending scheduled items for this
                  day.
                </div>
              ) : (
                <div className="cf-transaction-list">
                  {selectedDayEntries.map((entry) => (
                    <div
                      className="cf-transaction-row"
                      key={`${entry.type}-${entry.id}`}
                    >
                      <div className="cf-transaction-main">
                        <span
                          className={[
                            "cf-kind-indicator",
                            entry.kind === "income"
                              ? "cf-kind-income"
                              : "cf-kind-expense",
                          ].join(" ")}
                          aria-hidden="true"
                        />

                        <div className="cf-transaction-description">
                          <strong>{entry.description}</strong>
                          <span>
                            {entry.type === "scheduled"
                              ? "Scheduled · Pending"
                              : `Recorded transaction${entry.source
                                ? ` · ${entry.source.replaceAll("_", " ")}`
                                : ""
                              }`}
                          </span>
                          {entry.notes && <span>{entry.notes}</span>}
                        </div>
                      </div>

                      <strong
                        className={
                          entry.kind === "income"
                            ? "cf-text-income"
                            : "cf-text-expense"
                        }
                      >
                        {entry.kind === "income" ? "+" : "−"}
                        {moneyTotal(entry.amount)}
                      </strong>

                      {entry.type === "transaction" &&
                        transactionById.get(entry.id) &&
                        transactionActions(transactionById.get(entry.id)!)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <p className="cf-footnote">
        Projected balances are estimates, not confirmed bank balances. Pending
        scheduled occurrences are included in projections until their status
        changes. Recorded transactions affect actual balances.
      </p>
    </section>
  );
}
