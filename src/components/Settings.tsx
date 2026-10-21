import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { formatPaisa } from "../lib/money";
import { useToastFeedback } from "./toast-context";

type WeekStartsOn = "sunday" | "monday" | "saturday";

export type UserSettings = {
  id: string;
  user_id: string;
  opening_balance_paisa: string | number;
  opening_balance_date: string;
  currency: string;
  week_starts_on: WeekStartsOn;
  forecast_horizon_months: number;
  updated_at: string;
};

type Props = {
  userId: string;
  settings: UserSettings;
  onSettingsChanged: () => Promise<void>;
};

const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
const MIN_PG_BIGINT = -9_223_372_036_854_775_808n;

function paisaToInput(value: string | number): string {
  const paisa = BigInt(value);
  const negative = paisa < 0n;
  const absolute = negative ? -paisa : paisa;
  const taka = absolute / 100n;
  const poisha = (absolute % 100n).toString().padStart(2, "0");

  return `${negative ? "-" : ""}${taka}.${poisha}`;
}

function parseOpeningBalance(input: string): bigint {
  const value = input.trim();

  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(
      "Enter a valid opening balance with no more than two decimal places."
    );
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [takaText, poishaText = ""] = unsigned.split(".");
  const taka = BigInt(takaText);
  const poisha = BigInt(poishaText.padEnd(2, "0") || "0");

  const paisa = taka * 100n + poisha;
  const signedPaisa = negative ? -paisa : paisa;

  if (
    signedPaisa > MAX_PG_BIGINT ||
    signedPaisa < MIN_PG_BIGINT
  ) {
    throw new Error("The opening balance exceeds the database limit.");
  }

  return signedPaisa;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export default function Settings({
  userId,
  settings,
  onSettingsChanged,
}: Props) {
  const [openingBalance, setOpeningBalance] = useState(() =>
    paisaToInput(settings.opening_balance_paisa)
  );
  const [openingBalanceDate, setOpeningBalanceDate] = useState(
    settings.opening_balance_date
  );
  const [weekStartsOn, setWeekStartsOn] =
    useState<WeekStartsOn>(settings.week_starts_on);
  const [forecastHorizon, setForecastHorizon] = useState(
    String(settings.forecast_horizon_months)
  );

  const [saving, setSaving] = useState(false);
  const { setError, setSuccess } = useToastFeedback();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    let openingBalancePaisa: bigint;

    try {
      openingBalancePaisa = parseOpeningBalance(openingBalance);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Enter a valid opening balance."
      );
      return;
    }

    if (!isValidDate(openingBalanceDate)) {
      setError("Choose a valid opening balance date.");
      return;
    }

    const horizon = Number(forecastHorizon);

    if (
      !Number.isInteger(horizon) ||
      horizon < 1 ||
      horizon > 60
    ) {
      setError("Forecast horizon must be between 1 and 60 months.");
      return;
    }

    setSaving(true);

    try {
      // Warn if transactions will fall before the new opening date.
      if (openingBalanceDate !== settings.opening_balance_date) {
        const { count, error: countError } = await supabase
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .lt("transaction_date", openingBalanceDate);

        if (countError) {
          throw new Error(
            `Could not check existing transactions: ${countError.message}`
          );
        }

        if (
          count &&
          !window.confirm(
            `${count} existing transaction(s) are dated before ` +
              `${openingBalanceDate}. They will not be included in the ` +
              "balance calculation while they are before the opening " +
              "balance date. Continue?"
          )
        ) {
          return;
        }
      }

      const { data, error: updateError } = await supabase
        .from("settings")
        .update({
          opening_balance_paisa: openingBalancePaisa.toString(),
          opening_balance_date: openingBalanceDate,
          week_starts_on: weekStartsOn,
          forecast_horizon_months: horizon,
        })
        .eq("user_id", userId)
        .select(
          "id, user_id, opening_balance_paisa, opening_balance_date, " +
            "currency, week_starts_on, forecast_horizon_months, updated_at"
        )
        .single();

      if (updateError) {
        throw new Error(
          `Could not save settings: ${updateError.message}`
        );
      }

      if (!data) {
        throw new Error("Settings were not returned after saving.");
      }

      // Supabase's generated query type is not configured for this project yet.
      const savedSettings = data as unknown as UserSettings;

      // Keep the form aligned with the saved values.
      setOpeningBalance(paisaToInput(savedSettings.opening_balance_paisa));
      setOpeningBalanceDate(savedSettings.opening_balance_date);
      setWeekStartsOn(savedSettings.week_starts_on);
      setForecastHorizon(String(savedSettings.forecast_horizon_months));

      try {
        await onSettingsChanged();
      } catch {
        setError(
          "Settings were saved, but the dashboard could not refresh. " +
            "Reload the page to retrieve the latest settings."
        );
        return;
      }

      setSuccess("Settings saved successfully.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred while saving settings."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-panel">
      <h2>Settings</h2>
      <p className="muted">
        Configure your starting balance and financial calendar.
        All amounts are in Bangladeshi taka (BDT).
      </p>

      <form onSubmit={handleSubmit} className="settings-form">
        <label className="field-label">
          Opening balance (৳)
          <input
            type="text"
            inputMode="decimal"
            value={openingBalance}
            onChange={(event) =>
              setOpeningBalance(event.target.value)
            }
            placeholder="e.g. 25000.00 or -500.00"
            autoComplete="off"
            required
          />
          <span className="muted">
            Use a negative amount for an overdraft or negative starting
            balance. Current saved value:{" "}
            {formatPaisa(settings.opening_balance_paisa)}
          </span>
        </label>

        <label className="field-label">
          Opening balance date
          <input
            type="date"
            value={openingBalanceDate}
            onChange={(event) =>
              setOpeningBalanceDate(event.target.value)
            }
            required
          />
          <span className="muted">
            Transactions dated before this date are excluded from the
            calculated balance.
          </span>
        </label>

        <label className="field-label">
          Week starts on
          <select
            value={weekStartsOn}
            onChange={(event) =>
              setWeekStartsOn(event.target.value as WeekStartsOn)
            }
            required
          >
            <option value="sunday">Sunday</option>
            <option value="monday">Monday</option>
            <option value="saturday">Saturday</option>
          </select>
        </label>

        <label className="field-label">
          Forecast horizon (months)
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={forecastHorizon}
            onChange={(event) =>
              setForecastHorizon(event.target.value)
            }
            required
          />
          <span className="muted">
            Used when future cash-flow forecasting is implemented.
          </span>
        </label>


        <button
          type="submit"
          className="primary-button"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
      </form>
    </section>
  );
}
