
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import "./index.css";
import Transactions, {
  type EditableTransaction,
} from "./components/Transactions";
import Categories from "./components/Categories";
import Settings, {
  type UserSettings,
} from "./components/Settings";
import RecurringSchedules from "./components/RecurringSchedules";
import RecurringOccurrences from "./components/RecurringOccurrences";
import CalendarForecast from "./components/CalendarForecast";
import FinancialDashboard from "./components/FinancialDashboard";
import { ImportTransactions } from "./components/ImportTransactions";

type Category = {
  id: string;
  name: string;
  kind: "income" | "expense";
  is_active: boolean;
};

type AuthMode = "signin" | "signup";
type AppScreen =
  | "dashboard"
  | "transactions"
  | "categories"
  | "import_export"
  | "recurring"
  | "settings";

const APP_SCREENS: { id: AppScreen; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "transactions", label: "Transactions" },
  { id: "categories", label: "Categories" },
  { id: "import_export", label: "Import / Export" },
  { id: "recurring", label: "Recurring" },
  { id: "settings", label: "Settings" },
];

function formatBDT(paisa: number | string) {
  return new Intl.NumberFormat("en-BD", {
    style: "currency",
    currency: "BDT",
  }).format(Number(paisa) / 100);
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);

  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [transactionRefreshKey, setTransactionRefreshKey] = useState(0);
  const [transactionToEdit, setTransactionToEdit] =
    useState<EditableTransaction | null>(null);
  const [activeScreen, setActiveScreen] = useState<AppScreen>("dashboard");

  function handleTransactionsChanged() {
    setTransactionToEdit(null);
    setTransactionRefreshKey((key) => key + 1);
  }

  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession();

      if (!active) return;

      if (error) {
        setError(error.message);
      }

      setSession(data.session);
      setAuthLoading(false);
    }

    void loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
      setError("");
      setMessage("");
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) {
      return;
    }
    const currentUserId: string = userId;

    let active = true;

    async function loadUserData() {
      setError("");

      try {
        const [settingsResult, categoriesResult] = await Promise.all([
          supabase
            .from("settings")
            .select(
              "id, user_id, opening_balance_paisa, opening_balance_date, " +
              "currency, week_starts_on, forecast_horizon_months, updated_at"
            )
            .eq("user_id", currentUserId)
            .maybeSingle(),

          supabase
            .from("categories")
            .select("id, name, kind, is_active")
            .eq("user_id", currentUserId)
            .order("kind")
            .order("name"),
        ]);

        if (!active) return;

        if (settingsResult.error) {
          throw new Error(
            `Could not load settings: ${settingsResult.error.message}`
          );
        }

        if (categoriesResult.error) {
          throw new Error(
            `Could not load categories: ${categoriesResult.error.message}`
          );
        }

        setSettings(settingsResult.data as unknown as UserSettings | null);
        setCategories(categoriesResult.data ?? []);

        if (!settingsResult.data) {
          setError(
            "Your settings row is missing. Check the database initialization trigger."
          );
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not load your data."
          );
        }
      } finally {
        if (active) setLoadedUserId(currentUserId);
      }
    }

    void loadUserData();

    return () => {
      active = false;
    };
  }, [userId]);

  const dataLoading = Boolean(userId && loadedUserId !== userId);

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }

    if (mode === "signup" && password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }

    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });

      if (error) {
        setError(error.message);
        return;
      }

      if (data.session) {
        setMessage("Account created. Your BrokeOrNot setup is ready.");
      } else {
        setMessage(
          "Account created. Check your email to confirm your account, then sign in."
        );
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setError(error.message);
      }
    }
  }

  async function handleSignOut() {
    setError("");
    setMessage("");

    const { error } = await supabase.auth.signOut();

    if (error) setError(error.message);
  }

  async function refreshCategories(): Promise<void> {
    const userId = session?.user.id;

    if (!userId) return;

    const { data, error } = await supabase
      .from("categories")
      .select("id, name, kind, is_active")
      .eq("user_id", userId)
      .order("kind")
      .order("name");

    if (error) {
      setError(`Could not refresh categories: ${error.message}`);
      return;
    }

    setCategories(data ?? []);
  }

  async function refreshSettings(): Promise<void> {
    const currentUserId = session?.user.id;

    if (!currentUserId) {
      throw new Error("No signed-in user was found.");
    }

    const { data, error } = await supabase
      .from("settings")
      .select(
        "id, user_id, opening_balance_paisa, opening_balance_date, " +
        "currency, week_starts_on, forecast_horizon_months, updated_at"
      )
      .eq("user_id", currentUserId)
      .single();

    if (error) {
      throw new Error(`Could not refresh settings: ${error.message}`);
    }

    if (!data) {
      throw new Error("No settings record was found for this account.");
    }

    setSettings(data as unknown as UserSettings);
  }

  async function checkOtherUserReadIsolation() {
    if (!session) return;

    const otherUserId = window
      .prompt("Enter the other test account's User ID:")
      ?.trim();

    if (!otherUserId) return;

    if (otherUserId === session.user.id) {
      setError("Use the other account's User ID, not your own.");
      return;
    }

    setError("");
    setMessage("");

    const { data, error } = await supabase
      .from("categories")
      .select("id, name")
      .eq("user_id", otherUserId);

    if (error) {
      setError(`RLS test inconclusive: ${error.message}`);
      return;
    }

    if (data.length === 0) {
      setMessage(
        "Read-isolation test passed: no categories from the other account were visible."
      );
    } else {
      setError(
        `RLS WARNING: ${data.length} category row(s) from the other account were visible. Stop testing and review RLS policies.`
      );
    }
  }

  if (authLoading) {
    return (
      <main className="page">
        <p>Loading BrokeOrNotâ€¦</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="page">
        <section className="panel auth-panel">
          <p className="eyebrow">PERSONAL FINANCE TRACKER</p>
          <h1>BrokeOrNot</h1>
          <p className="muted">
            Track your balance, transactions, and upcoming expenses.
          </p>

          <div className="tabs">
            <button
              type="button"
              className={mode === "signin" ? "tab active" : "tab"}
              onClick={() => {
                setMode("signin");
                setError("");
                setMessage("");
              }}
            >
              Sign in
            </button>

            <button
              type="button"
              className={mode === "signup" ? "tab active" : "tab"}
              onClick={() => {
                setMode("signup");
                setError("");
                setMessage("");
              }}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleAuth}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={
                mode === "signup"
                  ? "new-password"
                  : "current-password"
              }
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            <button className="primary-button" type="submit">
              {mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          {message && <p className="success">{message}</p>}
          {error && <p className="error">{error}</p>}

          <p className="small muted">
            Your financial records are private to your account.
          </p>
        </section>
      </main>
    );
  }

  const incomeCount = categories.filter(
    (category) => category.kind === "income"
  ).length;

  const expenseCount = categories.filter(
    (category) => category.kind === "expense"
  ).length;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">YOUR PERSONAL FINANCES</p>
          <h1>BrokeOrNot</h1>
        </div>

        <button
          type="button"
          className="secondary-button"
          onClick={handleSignOut}
        >
          Sign out
        </button>
      </header>
      <nav className="screen-nav" aria-label="Main navigation">
        {APP_SCREENS.map((screen) => (
          <button
            key={screen.id}
            type="button"
            className={activeScreen === screen.id ? "screen-tab active" : "screen-tab"}
            aria-current={activeScreen === screen.id ? "page" : undefined}
            onClick={() => setActiveScreen(screen.id)}
          >
            {screen.label}
          </button>
        ))}
      </nav>



      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}

      {dataLoading ? (
        <p>Loading your financial setup...</p>
      ) : !settings ? (
        <section className="panel">
          <h2>Financial setup unavailable</h2>
          <p className="muted">
            Your settings could not be loaded. Check the message above or reload the app.
          </p>
        </section>
      ) : (
        <>
          {activeScreen === "dashboard" && (
            <>
              <section className="summary-grid">
                <article className="panel">
                  <p className="muted">Opening balance</p>
                  <h2>{formatBDT(settings.opening_balance_paisa)}</h2>
                  <p className="small muted">{settings.opening_balance_date}</p>
                </article>
                <article className="panel">
                  <p className="muted">Income categories</p>
                  <h2>{incomeCount}</h2>
                </article>
                <article className="panel">
                  <p className="muted">Expense categories</p>
                  <h2>{expenseCount}</h2>
                </article>
              </section>
              <FinancialDashboard
                key={`${session.user.id}:${transactionRefreshKey}`}
                userId={session.user.id}
                openingBalancePaisa={settings.opening_balance_paisa}
                openingBalanceDate={settings.opening_balance_date}
                forecastHorizonMonths={settings.forecast_horizon_months}
              />
            </>
          )}

          {activeScreen === "transactions" && (
            <>
              <Transactions
                key={`${settings.opening_balance_paisa}:${settings.opening_balance_date}:${transactionRefreshKey}:${transactionToEdit?.id ?? "new"}`}
                userId={session.user.id}
                openingBalancePaisa={settings.opening_balance_paisa}
                openingBalanceDate={settings.opening_balance_date}
                categories={categories}
                transactionToEdit={transactionToEdit}
                onEditCancelled={() => setTransactionToEdit(null)}
                onTransactionChanged={handleTransactionsChanged}
              />
              <CalendarForecast
                key={session.user.id}
                userId={session.user.id}
                openingBalancePaisa={settings.opening_balance_paisa}
                openingBalanceDate={settings.opening_balance_date}
                weekStartsOn={settings.week_starts_on}
                forecastHorizonMonths={settings.forecast_horizon_months}
                dataVersion={transactionRefreshKey}
                onEditTransaction={setTransactionToEdit}
                onTransactionChanged={handleTransactionsChanged}
              />
            </>
          )}

          {activeScreen === "categories" && (
            <Categories
              userId={session.user.id}
              categories={categories}
              onCategoriesChanged={refreshCategories}
            />
          )}

          {activeScreen === "import_export" && (
            <>
              <ImportTransactions
                userId={session.user.id}
                openingBalanceDate={settings.opening_balance_date}
                categories={categories}
                onImported={handleTransactionsChanged}
              />
              <section className="panel">
                <h2>Export transactions</h2>
                <p className="muted">
                  Export options will be available in a future update.
                </p>
                <button className="secondary-button" type="button" disabled>
                  Export transactions
                </button>
              </section>
            </>
          )}

          {activeScreen === "recurring" && (
            <>
              <RecurringSchedules
                key={`${session.user.id}:schedules`}
                userId={session.user.id}
                categories={categories}
              />
              <RecurringOccurrences
                key={`${session.user.id}:occurrences`}
                userId={session.user.id}
                categories={categories}
                onTransactionCreated={handleTransactionsChanged}
              />
            </>
          )}

          {activeScreen === "settings" && (
            <>
              <section className="panel">
                <h2>Signed in as</h2>
                <strong>{session.user.email}</strong>
                <p className="small muted">
                  User ID: <code>{session.user.id}</code>
                </p>
              </section>
              <Settings
                userId={session.user.id}
                settings={settings}
                onSettingsChanged={refreshSettings}
              />
              <section className="panel">
                <h2>Security check</h2>
                <p className="muted">
                  Test whether another user's categories are hidden by database security policies.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={checkOtherUserReadIsolation}
                >
                  Test RLS read isolation
                </button>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

