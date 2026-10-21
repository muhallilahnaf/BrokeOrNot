
import { useState, type ChangeEvent } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import { parseTakaToPaisa, formatPaisa } from "../lib/money";
import { useToast, useToastFeedback } from "./toast-context";

type Category = {
  id: string;
  name: string;
  kind: "income" | "expense";
  is_active?: boolean;
};

type Props = {
  userId: string;
  openingBalanceDate: string;
  categories: Category[];
  onImported: () => void;
};

type Field =
  | "date"
  | "description"
  | "debit"
  | "credit"
  | "category"
  | "notes";

type Mapping = Record<Field, string>;

type TransactionInsert = {
  transaction_date: string;
  description: string;
  kind: "income" | "expense";
  amount_paisa: string;
  category_id: string;
  notes: string | null;
};

type PreviewRow = {
  rowNumber: number;
  transaction: TransactionInsert | null;
  error: string;
  duplicate: boolean;
  duplicateReason: string;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const BATCH_SIZE = 100;

const FIELD_LABELS: Record<Field, string> = {
  date: "Transaction date",
  description: "Description",
  debit: "Debit / withdrawal",
  credit: "Credit / deposit",
  category: "Category (optional)",
  notes: "Notes (optional)",
};

const EMPTY_MAPPING: Mapping = {
  date: "",
  description: "",
  debit: "",
  credit: "",
  category: "",
  notes: "",
};

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function suggestColumn(headers: string[], field: Field): string {
  const aliases: Record<Field, string[]> = {
    date: [
      "date",
      "transaction date",
      "txn date",
      "posting date",
      "value date",
    ],
    description: [
      "description",
      "narration",
      "details",
      "particulars",
      "transaction details",
    ],
    debit: ["debit", "withdrawal", "withdrawals", "dr", "paid out"],
    credit: ["credit", "deposit", "deposits", "cr", "paid in"],
    category: ["category", "transaction category"],
    notes: ["notes", "remarks", "memo"],
  };

  const index = headers.findIndex(
    (header) => aliases[field].includes(normalizeHeader(header))
  );

  return index === -1 ? "" : String(index);
}

function isBlank(value: unknown): boolean {
  return value === null ||
    value === undefined ||
    String(value).trim() === "";
}

function parseAmount(value: unknown): bigint | null {
  if (isBlank(value)) return null;

  let text = String(value)
    .trim()
    .replace(/[৳\s]/g, "");

  // Treat common empty-cell placeholders as no amount.
  if (["-", "—", "–"].includes(text)) return null;

  // Accept standard thousands separators, e.g. 12,500.75.
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(text)) {
    text = text.replace(/,/g, "");
  }

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(
      "Invalid amount. Use digits and at most two decimal places."
    );
  }

  const [whole, fraction = ""] = text.split(".");
  const paisa =
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));

  if (paisa === 0n) return null;

  return parseTakaToPaisa(text);
}

function parseTransactionDate(
  value: unknown,
  dateFormat: "dmy" | "mdy"
): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value);

    if (!parts || !parts.y || !parts.m || !parts.d) {
      throw new Error("Invalid Excel date.");
    }

    return `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
  }

  const text = String(value ?? "").trim();

  let year: number;
  let month: number;
  let day: number;

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const regional = text.match(
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/
    );

    if (!regional) {
      throw new Error(
        "Unsupported date. Use YYYY-MM-DD, an Excel date, or the selected regional format."
      );
    }

    const first = Number(regional[1]);
    const second = Number(regional[2]);
    year = Number(regional[3]);

    if (dateFormat === "dmy") {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    year < 1900 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("Invalid calendar date.");
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Category is intentionally excluded: a previously categorized
// transaction should still be flagged as a likely duplicate.
function fingerprint(transaction: TransactionInsert): string {
  return [
    transaction.transaction_date,
    transaction.description.trim().toLocaleLowerCase(),
    transaction.kind,
    transaction.amount_paisa,
  ].join("|");
}

export function ImportTransactions({
  userId,
  openingBalanceDate,
  categories,
  onImported,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [dateFormat, setDateFormat] = useState<"dmy" | "mdy">("dmy");
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const { setMessage, setError } = useToastFeedback();
  const notify = useToast();
  const [failedBatches, setFailedBatches] = useState<string[]>([]);

  const activeCategories = categories.filter(
    (category) => category.is_active !== false
  );

  function resetAnalysis() {
    setPreview([]);
    setMessage("");
    setError("");
    setFailedBatches([]);
  }

  async function handleFileChange(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const input = event.currentTarget;
    const selected = input.files?.[0];

    resetAnalysis();
    setFile(null);
    setHeaders([]);
    setRows([]);
    setMapping(EMPTY_MAPPING);

    if (!selected) return;

    const extension = selected.name.split(".").pop()?.toLowerCase();

    if (!["csv", "xlsx", "xls"].includes(extension ?? "")) {
      setError("Choose a CSV, XLSX, or XLS file.");
      input.value = "";
      return;
    }

    if (selected.size === 0 || selected.size > MAX_FILE_BYTES) {
      setError("The file must be non-empty and no larger than 5 MB.");
      input.value = "";
      return;
    }

    try {
      const workbook = XLSX.read(await selected.arrayBuffer(), {
        type: "array",
        cellDates: true,
      });

      const firstSheet = workbook.SheetNames[0];

      if (!firstSheet) {
        throw new Error("The workbook has no worksheets.");
      }

      const worksheet = workbook.Sheets[firstSheet];

      const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
        header: 1,
        defval: "",
        raw: true,
        blankrows: false,
      });

      if (matrix.length < 2) {
        throw new Error(
          "The first worksheet needs a header row and at least one data row."
        );
      }

      const columnHeaders = matrix[0].map((cell) =>
        String(cell ?? "").trim()
      );

      if (columnHeaders.every((header) => !header)) {
        throw new Error("The first row does not contain column headers.");
      }

      const dataRows = matrix.slice(1).filter((row) =>
        row.some((cell) => !isBlank(cell))
      );

      if (dataRows.length === 0) {
        throw new Error("No non-empty transaction rows were found.");
      }

      if (dataRows.length > MAX_ROWS) {
        throw new Error(
          `The file exceeds the ${MAX_ROWS.toLocaleString()}-row limit.`
        );
      }

      setFile(selected);
      setHeaders(columnHeaders);
      setRows(dataRows);

      setMapping({
        date: suggestColumn(columnHeaders, "date"),
        description: suggestColumn(columnHeaders, "description"),
        debit: suggestColumn(columnHeaders, "debit"),
        credit: suggestColumn(columnHeaders, "credit"),
        category: suggestColumn(columnHeaders, "category"),
        notes: suggestColumn(columnHeaders, "notes"),
      });

      setMessage(
        `Read ${dataRows.length} data rows from worksheet "${firstSheet}". Check the column mapping.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read the file."
      );
    }
  }

  function cell(row: unknown[], field: Field): unknown {
    const index = mapping[field];
    return index === "" ? "" : row[Number(index)] ?? "";
  }

  async function analyzeFile() {
    resetAnalysis();

    if (!file || rows.length === 0) {
      setError("Choose a valid file first.");
      return;
    }

    if (
      mapping.date === "" ||
      mapping.description === "" ||
      mapping.debit === "" ||
      mapping.credit === ""
    ) {
      setError("Map the date, description, debit, and credit columns.");
      return;
    }

    if (mapping.debit === mapping.credit) {
      setError("Debit and credit must use different columns.");
      return;
    }

    const requiredColumns = [
      mapping.date,
      mapping.description,
      mapping.debit,
      mapping.credit,
    ];

    if (new Set(requiredColumns).size !== requiredColumns.length) {
      setError(
        "Date, description, debit, and credit must each use a different column."
      );
      return;
    }

    setLoading(true);

    try {
      const existingFingerprints = new Set<string>();
      const pageSize = 1000;
      let offset = 0;

      while (true) {
        const { data, error: queryError } = await supabase
          .from("transactions")
          .select(
            "transaction_date, description, kind, amount_paisa, category_id, notes"
          )
          .eq("user_id", userId)
          .range(offset, offset + pageSize - 1);

        if (queryError) throw queryError;
        if (!data || data.length === 0) break;

        for (const item of data) {
          existingFingerprints.add(
            fingerprint({
              transaction_date: item.transaction_date,
              description: item.description,
              kind: item.kind,
              amount_paisa: String(item.amount_paisa),
              category_id: item.category_id,
              notes: item.notes,
            })
          );
        }

        offset += data.length;
        if (data.length < pageSize) break;
      }

      const seenInFile = new Set<string>();

      const analyzed: PreviewRow[] = rows.map((row, index) => {
        try {
          const rawDate = cell(row, "date");
          const rawDescription = cell(row, "description");

          if (isBlank(rawDate) || isBlank(rawDescription)) {
            throw new Error("Date and description are required.");
          }

          const transactionDate = parseTransactionDate(
            rawDate,
            dateFormat
          );

          if (transactionDate < openingBalanceDate) {
            throw new Error(
              `Date is before the opening-balance date (${openingBalanceDate}).`
            );
          }

          const description = String(rawDescription).trim();

          if (description.length > 240) {
            throw new Error("Description exceeds 240 characters.");
          }

          const debit = parseAmount(cell(row, "debit"));
          const credit = parseAmount(cell(row, "credit"));

          if (debit !== null && credit !== null) {
            throw new Error(
              "Both debit and credit contain amounts. Review this row."
            );
          }

          if (debit === null && credit === null) {
            throw new Error(
              "Neither debit nor credit contains a positive amount."
            );
          }

          const kind = credit !== null ? "income" : "expense";
          const amount = credit ?? debit;

          if (amount === null || amount <= 0n) {
            throw new Error("The transaction amount must be positive.");
          }

          const requestedCategory = String(
            cell(row, "category") ?? ""
          ).trim();

          let category: Category | undefined;

          if (requestedCategory) {
            category = activeCategories.find(
              (item) =>
                item.kind === kind &&
                item.name.trim().toLocaleLowerCase() ===
                  requestedCategory.toLocaleLowerCase()
            );

            if (!category) {
              throw new Error(
                `Category "${requestedCategory}" does not match an active ${kind} category.`
              );
            }
          } else {
            const defaultName =
              kind === "income" ? "Other Income" : "Other Expense";

            category = activeCategories.find(
              (item) =>
                item.kind === kind &&
                item.name.trim().toLocaleLowerCase() ===
                  defaultName.toLocaleLowerCase()
            );
          }

          if (!category) {
            throw new Error(
              `No suitable ${kind} category found. Map a category column or create the appropriate default category.`
            );
          }

          const notes = String(cell(row, "notes") ?? "").trim();

          if (notes.length > 5000) {
            throw new Error("Notes exceed 5,000 characters.");
          }

          const transaction: TransactionInsert = {
            transaction_date: transactionDate,
            description,
            kind,
            amount_paisa: amount.toString(),
            category_id: category.id,
            notes: notes || null,
          };

          const key = fingerprint(transaction);
          const exists = existingFingerprints.has(key);
          const repeated = seenInFile.has(key);

          seenInFile.add(key);

          return {
            rowNumber: index + 2,
            transaction,
            error: "",
            duplicate: exists || repeated,
            duplicateReason: exists
              ? "Matches an existing transaction"
              : repeated
                ? "Repeated in this file"
                : "",
          };
        } catch (err) {
          return {
            rowNumber: index + 2,
            transaction: null,
            error: err instanceof Error ? err.message : "Invalid row.",
            duplicate: false,
            duplicateReason: "",
          };
        }
      });

      setPreview(analyzed);

      const valid = analyzed.filter(
        (item) => item.transaction && !item.error
      );
      const duplicates = valid.filter((item) => item.duplicate).length;
      const ready = valid.filter((item) => !item.duplicate).length;
      const invalid = analyzed.filter((item) => item.error).length;

      setMessage(
        `Analysis complete: ${ready} ready, ${duplicates} suspected duplicates, ${invalid} invalid rows.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not analyze the file."
      );
    } finally {
      setLoading(false);
    }
  }

  async function importValidRows() {
    setError("");
    setMessage("");
    setFailedBatches([]);

    const ready = preview
      .filter(
        (item) => item.transaction && !item.error && !item.duplicate
      )
      .map((item) => item.transaction as TransactionInsert);

    if (ready.length === 0) {
      setError("There are no valid, non-duplicate transactions to import.");
      return;
    }

    if (
      !window.confirm(
        `Import ${ready.length} transaction(s)? Invalid rows and suspected duplicates will be skipped.`
      )
    ) {
      return;
    }

    setLoading(true);

    let succeeded = 0;
    const failures: string[] = [];
    const importedKeys = new Set<string>();

    const source = file?.name.toLowerCase().endsWith(".csv")
      ? "csv_import"
      : "excel_import";

    try {
      for (let start = 0; start < ready.length; start += BATCH_SIZE) {
        const batch = ready.slice(start, start + BATCH_SIZE);

        const { error: insertError } = await supabase
          .from("transactions")
          .insert(
            batch.map((transaction) => ({
              user_id: userId,
              ...transaction,
              source,
            }))
          );

        if (insertError) {
          failures.push(
            `Batch ${Math.floor(start / BATCH_SIZE) + 1}: ${insertError.message}`
          );
        } else {
          succeeded += batch.length;

          for (const transaction of batch) {
            importedKeys.add(fingerprint(transaction));
          }
        }
      }

      setFailedBatches(failures);

      // Mark confirmed successful rows so a later retry will not
      // include those same rows in this preview.
      setPreview((current) =>
        current.map((item) => {
          if (
            item.transaction &&
            importedKeys.has(fingerprint(item.transaction))
          ) {
            return {
              ...item,
              duplicate: true,
              duplicateReason: "Imported successfully in this session",
            };
          }

          return item;
        })
      );

      if (succeeded > 0) {
        onImported();
      }

      const importMessage =
        `Import finished: ${succeeded} transaction(s) inserted; ` +
        `${failures.length} batch(es) failed.`;
      notify(failures.length > 0 ? "warning" : "success", importMessage);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The import failed unexpectedly."
      );
    } finally {
      setLoading(false);
    }
  }

  const readyCount = preview.filter(
    (item) => item.transaction && !item.error && !item.duplicate
  ).length;

  return (
    <section className="panel">
      <h2>Import bank statement</h2>
      <p className="muted">
        Upload a CSV or Excel statement with separate Debit and Credit
        columns. The file is parsed in your browser.
      </p>

      <label className="field-label" htmlFor="transaction-import-file">
        Bank statement file
      </label>
      <input
        id="transaction-import-file"
        type="file"
        accept=".csv,.xlsx,.xls"
        onChange={handleFileChange}
        disabled={loading}
      />
      <p className="small muted">
        Maximum 5 MB and 5,000 non-empty data rows.
      </p>

      <label className="field-label">
        Date format for text dates
        <select
          value={dateFormat}
          onChange={(event) => {
            setDateFormat(event.target.value as "dmy" | "mdy");
            resetAnalysis();
          }}
          disabled={loading}
        >
          <option value="dmy">DD/MM/YYYY — e.g. 20/10/2026</option>
          <option value="mdy">MM/DD/YYYY — e.g. 10/20/2026</option>
        </select>
      </label>

      {headers.length > 0 && (
        <>
          <h3>Map spreadsheet columns</h3>

          <div className="import-mapping">
            {(Object.keys(FIELD_LABELS) as Field[]).map((field) => (
              <label className="field-label" key={field}>
                {FIELD_LABELS[field]}
                <select
                  value={mapping[field]}
                  onChange={(event) => {
                    setMapping((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }));
                    resetAnalysis();
                  }}
                  disabled={loading}
                >
                  <option value="">— Not mapped —</option>
                  {headers.map((header, index) => (
                    <option key={index} value={String(index)}>
                      {header || `Column ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <p className="small muted">
            Credit becomes income; Debit becomes expense. If you do not map
            a category column, the importer uses Other Income or Other
            Expense.
          </p>

          <button
            type="button"
            className="primary-button"
            onClick={() => void analyzeFile()}
            disabled={loading}
          >
            {loading ? "Working…" : "Analyze and preview"}
          </button>
        </>
      )}


      {preview.length > 0 && (
        <>
          <h3>Import preview</h3>

          <div className="import-summary">
            <span>{readyCount} ready</span>
            <span>
              {preview.filter((item) => item.duplicate).length} suspected
              duplicates
            </span>
            <span>
              {preview.filter((item) => item.error).length} invalid
            </span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>File row</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 200).map((item) => (
                  <tr key={item.rowNumber}>
                    <td>{item.rowNumber}</td>
                    <td>{item.transaction?.transaction_date ?? "—"}</td>
                    <td>{item.transaction?.description ?? "—"}</td>
                    <td>{item.transaction?.kind ?? "—"}</td>
                    <td>
                      {item.transaction
                        ? formatPaisa(item.transaction.amount_paisa)
                        : "—"}
                    </td>
                    <td>
                      {item.error
                        ? `Invalid: ${item.error}`
                        : item.duplicate
                          ? `Duplicate: ${item.duplicateReason}`
                          : "Ready"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.length > 200 && (
            <p className="small muted">
              Showing the first 200 of {preview.length} rows. All rows are
              included in validation and import counts.
            </p>
          )}

          <button
            type="button"
            className="primary-button"
            onClick={() => void importValidRows()}
            disabled={loading || readyCount === 0}
          >
            {loading
              ? "Importing…"
              : `Import ${readyCount} valid transaction(s)`}
          </button>


          {failedBatches.length > 0 && (
            <div className="error-message">
              <strong>
                Some batches failed. Review the errors before retrying.
              </strong>
              <ul>
                {failedBatches.map((failure) => (
                  <li key={failure}>{failure}</li>
                ))}
              </ul>
              Re-analyze the file against the database before retrying,
              because a network failure may leave the outcome uncertain.
            </div>
          )}
        </>
      )}
    </section>
  );
}
