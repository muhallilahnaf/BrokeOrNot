
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useToast, useToastFeedback } from "./toast-context";
import { formatPaisa } from "../lib/money";
import "./FinancialDashboard.css";

type Props = {
  userId: string;
  openingBalancePaisa: string | number;
  openingBalanceDate: string;
  forecastHorizonMonths: number;
};

type Transaction = {
  id: string;
  transaction_date: string;
  description: string;
  kind: "income" | "expense";
  amount_paisa: string | number;
  category_id: string;
};

type Category = {
  id: string;
  name: string;
  kind: "income" | "expense";
};

type Occurrence = {
  id: string;
  schedule_id: string;
  due_date: string;
  status: "pending" | "paid" | "skipped" | "cancelled";
};

type Schedule = {
  id: string;
  name: string;
  kind: "income" | "expense";
  amount_paisa: string | number;
  category_id: string;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  status: "active" | "paused" | "ended";
};

type UpcomingItem = {
  id: string;
  date: string;
  name: string;
  kind: "income" | "expense";
  amount: bigint;
  frequency: string;
};

const PAGE_SIZE = 1000;

function getToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftMonth(value: string, amount: number): string {
  const date = parseDate(value);
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  return dateString(date);
}

function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function monthEnd(value: string): string {
  const date = parseDate(monthStart(value));
  date.setMonth(date.getMonth() + 1, 0);
  return dateString(date);
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat("en-BD", {
    month: "long",
    year: "numeric",
  }).format(parseDate(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parseDate(value));
}

function amount(value: string | number | bigint): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function signedAmount(
  balance: bigint,
  kind: "income" | "expense",
  value: bigint,
): bigint {
  return kind === "income" ? balance + value : balance - value;
}

function formatMoney(value: bigint): string {
  return formatPaisa(value);
}

function frequencyLabel(frequency: string): string {
  const labels: Record<string, string> = {
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
  };

  return labels[frequency] ?? frequency;
}

export default function FinancialDashboard({
  userId,
  openingBalancePaisa,
  openingBalanceDate,
  forecastHorizonMonths,
}: Props) {
  const today = getToday();

  const [selectedMonth, setSelectedMonth] = useState(
    monthStart(today),
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const { setError } = useToastFeedback();
  const notify = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const monthPickerRef = useRef<HTMLInputElement>(null);

  const openingBalance = amount(openingBalancePaisa);

  const horizonEnd = useMemo(() => {
    const date = parseDate(today);
    date.setMonth(date.getMonth() + forecastHorizonMonths);
    return dateString(date);
  }, [today, forecastHorizonMonths]);

  const loadDashboard = useCallback(async () => {
    const allTransactions: Transaction[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error: queryError } = await supabase
        .from("transactions")
        .select(
          "id,transaction_date,description,kind,amount_paisa,category_id",
        )
        .eq("user_id", userId)
        .gte("transaction_date", openingBalanceDate)
        .order("transaction_date", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (queryError) throw queryError;

      const page = (data ?? []) as Transaction[];
      allTransactions.push(...page);

      if (page.length < PAGE_SIZE) break;
    }

    const { data: categoryData, error: categoryError } =
      await supabase
        .from("categories")
        .select("id,name,kind")
        .eq("user_id", userId);

    if (categoryError) throw categoryError;

    const allOccurrences: Occurrence[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error: occurrenceError } = await supabase
        .from("schedule_occurrences")
        .select("id,schedule_id,due_date,status")
        .eq("user_id", userId)
        .gte("due_date", today)
        .lte("due_date", horizonEnd)
        .order("due_date", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (occurrenceError) throw occurrenceError;

      const page = (data ?? []) as Occurrence[];
      allOccurrences.push(...page);

      if (page.length < PAGE_SIZE) break;
    }

    const { data: scheduleData, error: scheduleError } =
      await supabase
        .from("recurring_schedules")
        .select(
          "id,name,kind,amount_paisa,category_id,frequency,status",
        )
        .eq("user_id", userId);

    if (scheduleError) throw scheduleError;

    return {
      transactions: allTransactions,
      categories: (categoryData ?? []) as unknown as Category[],
      occurrences: allOccurrences,
      schedules: (scheduleData ?? []) as unknown as Schedule[],
    };
  }, [userId, openingBalanceDate, today, horizonEnd]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const data = await loadDashboard();
        if (active) {
          setTransactions(data.transactions);
          setCategories(data.categories);
          setOccurrences(data.occurrences);
          setSchedules(data.schedules);
          setError("");
        }
      } catch (err) {
        if (active) {
          console.error("Failed to load financial dashboard:", err);
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load dashboard data.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void refresh();
    return () => { active = false; };
  }, [loadDashboard, refreshKey, setError]);

  function refreshDashboard() {
    setError("");
    setLoading(true);
    setRefreshKey((key) => key + 1);
  }

  function openMonthPicker() {
    const picker = monthPickerRef.current;
    if (!picker) return;

    if (typeof picker.showPicker === "function") picker.showPicker();
    else picker.click();
  }

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const scheduleById = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, schedule])),
    [schedules],
  );

  const currentBalance = useMemo(() => {
    return transactions.reduce((balance, transaction) => {
      if (transaction.transaction_date > today) return balance;

      return signedAmount(
        balance,
        transaction.kind,
        amount(transaction.amount_paisa),
      );
    }, openingBalance);
  }, [transactions, openingBalance, today]);

  const monthlyTransactions = useMemo(() => {
    const start = monthStart(selectedMonth);
    const end = monthEnd(selectedMonth);

    return transactions.filter(
      (transaction) =>
        transaction.transaction_date >= start &&
        transaction.transaction_date <= end &&
        transaction.transaction_date >= openingBalanceDate,
    );
  }, [transactions, selectedMonth, openingBalanceDate]);

  const monthlyIncome = useMemo(
    () =>
      monthlyTransactions.reduce(
        (total, transaction) =>
          transaction.kind === "income"
            ? total + amount(transaction.amount_paisa)
            : total,
        0n,
      ),
    [monthlyTransactions],
  );

  const monthlyExpenses = useMemo(
    () =>
      monthlyTransactions.reduce(
        (total, transaction) =>
          transaction.kind === "expense"
            ? total + amount(transaction.amount_paisa)
            : total,
        0n,
      ),
    [monthlyTransactions],
  );

  const monthlyNet = monthlyIncome - monthlyExpenses;

  const monthlyOpeningBalance = (() => {
    const monthStartDate = monthStart(selectedMonth);

    if (monthStartDate < openingBalanceDate) {
      return 0n;
    }

    return transactions.reduce((balance, transaction) => {
      if (
        transaction.transaction_date < openingBalanceDate ||
        transaction.transaction_date >= monthStartDate
      ) {
        return balance;
      }

      return signedAmount(
        balance,
        transaction.kind,
        amount(transaction.amount_paisa),
      );
    }, openingBalance);
  })();

  const monthlyAvailable = monthlyOpeningBalance + monthlyIncome;
  const monthlyRemaining = monthlyAvailable - monthlyExpenses;

  const monthlySpentPercent =
    monthlyAvailable > 0n
      ? Number((monthlyExpenses * 10000n) / monthlyAvailable) / 100
      : monthlyExpenses > 0n
        ? 100
        : 0;

  const monthlyProgressWidth = Math.min(100, monthlySpentPercent);

  const categorySpending = useMemo(() => {
    const totals = new Map<string, bigint>();

    for (const transaction of monthlyTransactions) {
      if (transaction.kind !== "expense") continue;

      const categoryId = transaction.category_id;
      totals.set(
        categoryId,
        (totals.get(categoryId) ?? 0n) +
        amount(transaction.amount_paisa),
      );
    }

    return Array.from(totals.entries())
      .map(([categoryId, total]) => ({
        id: categoryId,
        name: categoryById.get(categoryId)?.name ?? "Unknown category",
        total,
      }))
      .sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0));
  }, [monthlyTransactions, categoryById]);

  const largestCategoryExpense = useMemo(
    () =>
      categorySpending.reduce(
        (largest, item) => (item.total > largest ? item.total : largest),
        0n,
      ),
    [categorySpending],
  );

  const upcomingItems = useMemo<UpcomingItem[]>(() => {
    return occurrences
      .filter((occurrence) => occurrence.status === "pending")
      .flatMap((occurrence) => {
        const schedule = scheduleById.get(occurrence.schedule_id);
        if (!schedule) return [];

        return [
          {
            id: occurrence.id,
            date: occurrence.due_date,
            name: schedule.name,
            kind: schedule.kind,
            amount: amount(schedule.amount_paisa),
            frequency: schedule.frequency,
          },
        ];
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [occurrences, scheduleById]);

  const lowestProjectedBalance = useMemo(() => {
    const entriesByDate = new Map<string, Array<{
      kind: "income" | "expense";
      amount: bigint;
    }>>();

    // Today's recorded transactions are already reflected in currentBalance.
    // Exclude them from the forecast to avoid double-counting.
    for (const transaction of transactions) {
      if (
        transaction.transaction_date <= today ||
        transaction.transaction_date > horizonEnd
      ) {
        continue;
      }

      const list = entriesByDate.get(transaction.transaction_date) ?? [];
      list.push({
        kind: transaction.kind,
        amount: amount(transaction.amount_paisa),
      });
      entriesByDate.set(transaction.transaction_date, list);
    }

    for (const occurrence of occurrences) {
      if (occurrence.status !== "pending") continue;

      const schedule = scheduleById.get(occurrence.schedule_id);
      if (!schedule) continue;

      const list = entriesByDate.get(occurrence.due_date) ?? [];
      list.push({
        kind: schedule.kind,
        amount: amount(schedule.amount_paisa),
      });
      entriesByDate.set(occurrence.due_date, list);
    }

    let balance = currentBalance;
    let lowestBalance = currentBalance;
    let lowestDate = today;

    const cursor = parseDate(today);
    const end = parseDate(horizonEnd);

    while (cursor <= end) {
      const date = dateString(cursor);

      for (const entry of entriesByDate.get(date) ?? []) {
        balance = signedAmount(balance, entry.kind, entry.amount);
      }

      if (balance < lowestBalance) {
        lowestBalance = balance;
        lowestDate = date;
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return { balance: lowestBalance, date: lowestDate };
  }, [
    transactions,
    occurrences,
    scheduleById,
    currentBalance,
    today,
    horizonEnd,
  ]);

  useEffect(() => {
    if (!loading && lowestProjectedBalance.balance < 0n) {
      notify(
        "warning",
        "Your projected balance becomes negative within the forecast period. Review upcoming expenses and expected income."
      );
    }
  }, [loading, lowestProjectedBalance.balance, notify]);

  const monthIsFuture = monthStart(selectedMonth) > monthStart(today);
  const monthIsBeforeOpening =
    monthEnd(selectedMonth) < openingBalanceDate;

  if (loading) {
    return (
      <section className="fd-container">
        <p className="fd-status">Loading financial dashboard…</p>
      </section>
    );
  }

  return (
    <section className="fd-container">
      <header className="fd-header">
        <div>
          <h2>Financial Dashboard</h2>
          <p>Your balance, monthly performance, and upcoming cash flow.</p>
        </div>

        <button
          type="button"
          className="fd-refresh-button"
          onClick={refreshDashboard}
        >
          Refresh
        </button>
      </header>

      <div className="fd-current-balance">
        <span>Current balance</span>
        <strong>{formatMoney(currentBalance)}</strong>
        <small>
          Opening balance plus recorded transactions through{" "}
          {formatDate(today)}
        </small>
      </div>

      <div className="fd-month-navigation">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() =>
            setSelectedMonth((month) => shiftMonth(month, -1))
          }
        >
          ‹
        </button>

        <button
          type="button"
          className="fd-month-picker-button"
          onClick={openMonthPicker}
          aria-label={`Choose month, currently ${monthLabel(selectedMonth)}`}
        >
          {monthLabel(selectedMonth)}
        </button>
        <input
          ref={monthPickerRef}
          className="fd-month-picker-input"
          type="month"
          value={selectedMonth.slice(0, 7)}
          aria-label="Choose dashboard month"
          tabIndex={-1}
          onChange={(event) => {
            if (event.target.value) setSelectedMonth(`${event.target.value}-01`);
          }}
        />

        <button
          type="button"
          aria-label="Next month"
          onClick={() =>
            setSelectedMonth((month) => shiftMonth(month, 1))
          }
        >
          ›
        </button>

        <button
          type="button"
          className="fd-this-month-button"
          onClick={() => setSelectedMonth(monthStart(today))}
        >
          This month
        </button>
      </div>

      {monthIsBeforeOpening && (
        <p className="fd-info">
          This month is before your configured opening-balance date. No
          monthly transactions are included.
        </p>
      )}

      {monthIsFuture && (
        <p className="fd-info">
          This is a future month. The monthly totals below include any
          transactions already recorded with dates in this month; pending
          scheduled items are shown separately.
        </p>
      )}

      <div className="fd-metric-grid">
        <article className="fd-metric-card">
          <span>Monthly income</span>
          <strong className="fd-income">
            {formatMoney(monthlyIncome)}
          </strong>
          <small>Recorded transactions</small>
        </article>

        <article className="fd-metric-card">
          <span>Monthly expenses</span>
          <strong className="fd-expense">
            {formatMoney(monthlyExpenses)}
          </strong>
          <small>Recorded transactions</small>
        </article>

        <article className="fd-metric-card">
          <span>Net cash flow</span>
          <strong
            className={
              monthlyNet >= 0n ? "fd-income" : "fd-expense"
            }
          >
            {monthlyNet > 0n ? "+" : ""}
            {formatMoney(monthlyNet)}
          </strong>
          <small>Income minus expenses</small>
        </article>
      </div>


      <section className="fd-panel fd-spending-panel">
        <div className="fd-panel-header">
          <div>
            <h3>Monthly spending progress</h3>
            <p>
              How much of your available money has been spent in{" "}
              {monthLabel(selectedMonth)}.
            </p>
          </div>
        </div>

        <div className="fd-spending-summary">
          <div>
            <span>Available money</span>
            <strong>{formatMoney(monthlyAvailable)}</strong>
          </div>

          <div>
            <span>Spent</span>
            <strong className="fd-expense">
              {formatMoney(monthlyExpenses)}
            </strong>
          </div>

          <div>
            <span>Remaining</span>
            <strong
              className={
                monthlyRemaining < 0n ? "fd-expense" : "fd-income"
              }
            >
              {formatMoney(monthlyRemaining)}
            </strong>
          </div>
        </div>

        <div
          className="fd-spending-track"
          role="progressbar"
          aria-label="Monthly spending progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={monthlyProgressWidth}
          aria-valuetext={`${monthlySpentPercent.toFixed(1)}% of available money spent`}
        >
          <div
            className={[
              "fd-spending-fill",
              monthlyRemaining < 0n ? "fd-spending-over" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ width: `${monthlyProgressWidth}%` }}
          />
        </div>

        <div className="fd-spending-footer">
          <strong>{monthlySpentPercent.toFixed(1)}% spent</strong>
          <span>
            {monthlyRemaining < 0n
              ? "Spending exceeds available money."
              : `${monthlySpentPercent < 100 ? (100 - monthlySpentPercent).toFixed(1) : "0.0"}% remaining`}
          </span>
        </div>
      </section>


      <div className="fd-content-grid">
        <section className="fd-panel">
          <div className="fd-panel-header">
            <div>
              <h3>Expense breakdown</h3>
              <p>Recorded expenses by category for {monthLabel(selectedMonth)}.</p>
            </div>
          </div>

          {categorySpending.length === 0 ? (
            <div className="fd-empty">
              No recorded expenses for this month.
            </div>
          ) : (
            <div className="fd-category-list">
              {categorySpending.map((item) => {
                const percentage =
                  largestCategoryExpense > 0n
                    ? Number(
                      (item.total * 10000n) /
                      largestCategoryExpense,
                    ) / 100
                    : 0;

                return (
                  <div className="fd-category-row" key={item.id}>
                    <div className="fd-category-label">
                      <span>{item.name}</span>
                      <strong>{formatMoney(item.total)}</strong>
                    </div>

                    <div
                      className="fd-category-bar"
                      role="img"
                      aria-label={`${item.name}: ${percentage}% of the largest category`}
                    >
                      <span style={{ width: `${percentage}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="fd-panel fd-forecast-panel">
          <div className="fd-panel-header">
            <div>
              <h3>Cash-flow outlook</h3>
              <p>Based on current balance and known future items.</p>
            </div>
          </div>

          <div className="fd-lowest-balance">
            <span>Lowest projected balance</span>
            <strong
              className={
                lowestProjectedBalance.balance < 0n
                  ? "fd-expense"
                  : ""
              }
            >
              {formatMoney(lowestProjectedBalance.balance)}
            </strong>
            <small>
              Expected on {formatDate(lowestProjectedBalance.date)}
            </small>
          </div>

          <p className="fd-forecast-note">
            Forecast horizon: {forecastHorizonMonths} month(s), through{" "}
            {formatDate(horizonEnd)}. Future-dated recorded transactions and
            pending scheduled items are included.
          </p>
        </section>
      </div>

      <section className="fd-panel fd-upcoming-panel">
        <div className="fd-panel-header">
          <div>
            <h3>Upcoming scheduled items</h3>
            <p>Pending recurring income and expenses within your forecast horizon.</p>
          </div>
          <span className="fd-count">{upcomingItems.length}</span>
        </div>

        {upcomingItems.length === 0 ? (
          <div className="fd-empty">
            No pending scheduled items found within the forecast horizon.
            You can create or review schedules in the Recurring Schedules
            section.
          </div>
        ) : (
          <div className="fd-upcoming-list">
            {upcomingItems.slice(0, 10).map((item) => (
              <div className="fd-upcoming-row" key={item.id}>
                <div className="fd-upcoming-date">
                  <strong>{parseDate(item.date).getDate()}</strong>
                  <span>
                    {new Intl.DateTimeFormat("en-BD", {
                      month: "short",
                    }).format(parseDate(item.date))}
                  </span>
                </div>

                <div className="fd-upcoming-description">
                  <strong>{item.name}</strong>
                  <span>
                    {frequencyLabel(item.frequency)} · Pending
                  </span>
                </div>

                <strong
                  className={
                    item.kind === "income" ? "fd-income" : "fd-expense"
                  }
                >
                  {item.kind === "income" ? "+" : "−"}
                  {formatMoney(item.amount)}
                </strong>
              </div>
            ))}

            {upcomingItems.length > 10 && (
              <p className="fd-more-items">
                Showing 10 of {upcomingItems.length} upcoming items.
                Review the Recurring Occurrences section for the full list.
              </p>
            )}
          </div>
        )}
      </section>

      <p className="fd-footnote">
        Monthly totals use recorded transactions only. Pending scheduled
        occurrences are shown separately and included in the forecast, not
        treated as completed transactions. Forecasts are estimates and depend
        on the occurrences generated in your database.
      </p>
    </section>
  );
}
