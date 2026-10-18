
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;

export function parseTakaToPaisa(input: string): bigint {
  const value = input.trim();

  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(
      "Enter a valid amount, with no more than two decimal places."
    );
  }

  const [takaText, poishaText = ""] = value.split(".");
  const taka = BigInt(takaText);
  const poisha = BigInt(poishaText.padEnd(2, "0") || "0");
  const paisa = taka * 100n + poisha;

  if (paisa <= 0n) {
    throw new Error("The amount must be greater than zero.");
  }

  if (paisa > MAX_PG_BIGINT) {
    throw new Error("The amount exceeds the database's supported limit.");
  }

  return paisa;
}

export function formatPaisa(paisaValue: string | number | bigint): string {
  const paisa = BigInt(paisaValue);
  const negative = paisa < 0n;
  const absolute = negative ? -paisa : paisa;

  const taka = absolute / 100n;
  const poisha = (absolute % 100n).toString().padStart(2, "0");

  const formattedTaka = new Intl.NumberFormat("en-BD", {
    maximumFractionDigits: 0,
  }).format(taka);

  return `${negative ? "-" : ""}৳${formattedTaka}.${poisha}`;
}

/** Local calendar date, avoiding UTC date shifts. */
export function getLocalDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
