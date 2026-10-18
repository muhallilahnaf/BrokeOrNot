
import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import { formatPaisa, parseTakaToPaisa } from "../lib/money";

type Kind = "income" | "expense";

type Category = {
  id: string;
  name: string;
  kind: Kind;
  is_active?: boolean;
};

type ExistingTransaction = {
  transaction_date: string;
  description: string;
  kind: Kind;
  amount_paisa: string | number;
  category_id: string;
};

type ImportRow = {
  rowNumber: number;
  cells: unknown[];
};

type Mapping = {
  date: string;
  description: string;
  debit: string;
  credit: string;
  category: string;
  notes: string;
};

type Props = {
  userId: string;
  openingBalanceDate: string;
  categories: Category[];
  onImported: () => void;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const BATCH_SIZE = 100;

const EMPTY_MAPPING: Mapping = {
  date: "",
  description: "",
  debit: "",
  credit: "",
  category: "",
  notes: "",
};

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function guessColumn(
  headers: string[],
  terms: string[]
): string {
  const index = headers.findIndex((header) => {
    const normalized = normalizeHeader(header);
    return terms.includes(normalized);
  });

  return index < 0 ? "" : String(index);
}

function parseDate(
  value: unknown,
  format: "dmy" | "mdy"
): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value);
    if (!parts) throw new Error("Invalid Excel date.");

    const year = String(parts.y).padStart(4, "0");
    const month = String(parts.m).padStart(2, "0");
    const day = String(parts.d).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = cellText(value);
  let year: number;
  let month: number;
  let day: number;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const separated = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
    if (!separated) {
      throw new Error("Use YYYY-MM-DD or the selected date format.");
    }

    if (format === "dmy") {
      day = Number(separated[1]);
      month = Number(separated[2]);
    } else {
      month = Number(separated[1]);
      day = Number(separated[2]);
    }
    year = Number(separated[3]);
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    year < 1900 ||
    year > 2200 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid calendar date.");
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}


function parseAmount(value: unknown): bigint | null {
  const text = cellText(value).replace(/[৳,\s]/g, "");

  if (!text) return null;

  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(
      "Invalid amount. Use a non-negative amount with up to two decimal places."
    );
  }

  // Banks often use 0.00 for the unused debit/credit column.
  if (/^0+(?:\.0{1,2})?$/.test(text)) {
    return null;
  }

  return parseTakaToPaisa(text);
}


function fingerprint(transaction: ExistingTransaction): string {
  return [
    transaction.transaction_date,
    transaction.description
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " "),
    transaction.kind,
    BigInt(transaction.amount_paisa).toString(),
    transaction.category_id,
  ].join("|");
}

export default function ImportTransactions({
  userId,
  openingBalanceDate,
  categories,
  onImported,
}: Props) {
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState<"csv_import" | "excel_import">(
    "csv_import"
  );
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [dateFormat, setDateFormat] = useState<"dmy" | "mdy">("dmy");
  const [existing, setExisting] = useState<ExistingTransaction[]>([]);
  const [existingLoaded, setExistingLoaded] = useState(false);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const activeCategories = useMemo(
    () => categories.filter((category) => category.is_active !== false),
    [categories]
  );

  const preview = useMemo(() => {
    const seen = new Set<string>();
    const existingKeys = new Set(existing.map(fingerprint));

    return rows.map((row) => {
      const issues: string[] = [];
      let transaction: {
        transaction_date: string;
        description: string;
        kind: Kind;
        amount_paisa: string;
        category_id: string;
        notes: string | null;
      } | null = null;

      try {
        const getCell = (key: keyof Mapping) => {
          const index = mapping[key];
          return index === "" ? "" : row.cells[Number(index)];
        };

        if (mapping.date === "") {
          throw new Error("Map a date column.");
        }
        if (mapping.description === "") {
          throw new Error("Map a description column.");
        }
        if (mapping.debit === "" || mapping.credit === "") {
          throw new Error("Map both debit and credit columns.");
        }

        const transactionDate = parseDate(getCell("date"), dateFormat);
        if (transactionDate < openingBalanceDate) {
          throw new Error(
            `Date is before the opening-balance date (${openingBalanceDate}).`
          );
        }

        const description = cellText(getCell("description"));
        if (!description) throw new Error("Description is required.");
        if (description.length > 240) {
          throw new Error("Description exceeds 240 characters.");
        }

        const debit = parseAmount(getCell("debit"));
        const credit = parseAmount(getCell("credit"));

        if (debit !== null && credit !== null) {
          throw new Error("Both debit and credit contain amounts.");
        }
        if (debit === null && credit === null) {
          throw new Error("No debit or credit amount was found.");
        }

        const kind: Kind = debit !== null ? "expense" : "income";
        const amount = debit ?? credit;
        if (amount === null) throw new Error("Amount is missing.");

        let category: Category | undefined;
        const categoryText = cellText(getCell("category"));

        if (categoryText) {
          category = activeCategories.find(
            (item) =>
              item.kind === kind &&
              item.name.trim().toLowerCase() === categoryText.toLowerCase()
          );

          if (!category) {
            throw new Error(
              `No active ${kind} category matches "${categoryText}".`
            );
          }
        } else {
          const fallbackName =
            kind === "income" ? "Other Income" : "Other Expense";

          category = activeCategories.find(
            (item) =>
              item.kind === kind &&
              item.name.trim().toLowerCase() === fallbackName.toLowerCase()
          );

          if (!category) {
            throw new Error(
              `Choose a category column or create the "${fallbackName}" category.`
            );
          }
        }

        const notes = cellText(getCell("notes"));
        if (notes.length > 5000) {
          throw new Error("Notes exceed 5,000 characters.");
        }

        transaction = {
          transaction_date: transactionDate,
          description,
          kind,
          amount_paisa: amount.toString(),
          category_id: category.id,
          notes: notes || null,
        };
      } catch (err) {
        issues.push(
          err instanceof Error ? err.message : "Invalid transaction."
        );
      }

      let duplicateReason = "";

      if (transaction && issues.length === 0) {
        const key = fingerprint({
          ...transaction,
          amount_paisa: transaction.amount_paisa,
        });

        if (existingKeys.has(key)) {
          duplicateReason = "Matches an existing transaction.";
        } else if (seen.has(key)) {
          duplicateReason = "Duplicate of another row in this file.";
        }

        seen.add(key);
      }

      return {
        rowNumber: row.rowNumber,
        transaction,
        issues,
        duplicateReason,
      };
    });
  }, [
    rows,
    mapping,
    dateFormat,
    openingBalanceDate,
    activeCategories,
    existing,
  ]);

  const validCount = preview.filter(
    (row) => row.transaction && row.issues.length === 0
  ).length;

  const invalidCount = preview.filter(
    (row) => row.issues.length > 0
  ).length;

  const duplicateCount = preview.filter(
    (row) => row.duplicateReason !== ""
  ).length;

  const importable = preview.filter(
    (row) =>
      row.transaction &&
      row.issues.length === 0 &&
      (allowDuplicates || !row.duplicateReason)
  );

  async function loadExistingTransactions() {
    const result: ExistingTransaction[] = [];
    const pageSize = 1000;

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("transactions")
        .select(
          "transaction_date, description, kind, amount_paisa, category_id"
        )
        .eq("user_id", userId)
        .gte("transaction_date", openingBalanceDate)
        .order("transaction_date", { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw error;

      const page = (data ?? []) as ExistingTransaction[];
      result.push(...page);

      if (page.length < pageSize) break;
    }

    return result;
  }

  async function handleFile(file?: File) {
    setError("");
    setMessage("");
    setRows([]);
    setHeaders([]);
    setExisting([]);
    setExistingLoaded(false);
    setFileName("");
    setMapping(EMPTY_MAPPING);

    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!["csv", "xlsx", "xls"].includes(extension ?? "")) {
      setError("Choose a CSV, XLS, or XLSX file.");
      return;
    }

    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setError("The file must be larger than 0 bytes and no bigger than 5 MB.");
      return;
    }

    setLoadingFile(true);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, {
        type: "array",
        cellDates: true,
      });

      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("The workbook has no worksheets.");

      const worksheet = workbook.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
        header: 1,
        raw: true,
        defval: "",
        blankrows: false,
      });

      if (matrix.length < 2) {
        throw new Error("The first worksheet needs a header row and data.");
      }

      const columnHeaders = matrix[0].map(cellText);
      if (!columnHeaders.some(Boolean)) {
        throw new Error("The first row must contain column headers.");
      }

      const dataRows = matrix.slice(1).filter((cells) =>
        cells.some((cell) => cellText(cell) !== "")
      );

      if (dataRows.length > MAX_ROWS) {
        throw new Error(`A maximum of ${MAX_ROWS} transactions is allowed per file.`);
      }

      const indexedRows = dataRows.map((cells, index) => ({
        rowNumber: index + 2,
        cells,
      }));

      const inferredMapping: Mapping = {
        date: guessColumn(columnHeaders, ["date", "transactiondate", "valuedate", "postingdate"]),
        description: guessColumn(columnHeaders, ["description", "details", "narration", "particulars", "remarks", "payee"]),
        debit: guessColumn(columnHeaders, ["debit", "withdrawal", "withdrawals", "dr", "paidout"]),
        credit: guessColumn(columnHeaders, ["credit", "deposit", "deposits", "cr", "paidin"]),
        category: guessColumn(columnHeaders, ["category", "transactioncategory"]),
        notes: guessColumn(columnHeaders, ["notes", "note", "memo"]),
      };

      setFileName(file.name);
      setSource(extension === "csv" ? "csv_import" : "excel_import");
      setHeaders(columnHeaders);
      setRows(indexedRows);
      setMapping(inferredMapping);

      const existingRows = await loadExistingTransactions();
      setExisting(existingRows);
      setExistingLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this file.");
      setRows([]);
      setHeaders([]);
    } finally {
      setLoadingFile(false);
    }
  }

  async function importTransactions() {
    setError("");
    setMessage("");

    if (!existingLoaded) {
      setError("Existing transactions have not finished loading.");
      return;
    }

    if (importable.length === 0) {
      setError("There are no rows eligible for import.");
      return;
    }

    const confirmed = window.confirm(
      `Import ${importable.length} transactions? ` +
      `${invalidCount} invalid rows and ` +
      `${allowDuplicates ? 0 : duplicateCount} duplicate-looking rows will be skipped.`
    );

    if (!confirmed) return;

    setImporting(true);
    let inserted = 0;

    try {
      const records = importable.map((row) => ({
        user_id: userId,
        ...row.transaction!,
        source,
      }));

      for (let start = 0; start < records.length; start += BATCH_SIZE) {
        const batch = records.slice(start, start + BATCH_SIZE);
        const { error } = await supabase.from("transactions").insert(batch);

        if (error) {
          throw new Error(
            `Import stopped after ${inserted} inserted rows. ` +
            `The next batch failed: ${error.message}. ` +
            `Review the history before retrying to avoid duplicates.`
          );
        }

        inserted += batch.length;
      }

      setMessage(`Successfully imported ${inserted} transactions.`);
      onImported();
      setRows([]);
      setHeaders([]);
      setFileName("");
      setExisting([]);
      setExistingLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      if (inserted > 0) onImported();
    } finally {
      setImporting(false);
    }
  }

  function columnSelect(
    label: string,
    key: keyof Mapping,
    required: boolean
  ) {
    return (
      <label className="import-field">
        <span>{label}{required ? " *" : ""}</span>
        <select
          value={mapping[key]}
          onChange={(event) =>
            setMapping((current) => ({
              ...current,
              [key]: event.target.value,
            }))
          }
        >
          <option value="">— Not mapped —</option>
          {headers.map((header, index) => (
            <option key={index} value={String(index)}>
              {header || `Column ${index + 1}`}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <section className="import-panel">
      <h2>Import bank statement</h2>
      <p className="muted">
        Upload a CSV or Excel statement with separate debit and credit columns.
        Debit becomes expense; credit becomes income.
      </p>

      <label className="import-field">
        <span>Choose a file</span>
        <input
          type="file"
          accept=".csv,.xls,.xlsx"
          disabled={loadingFile || importing}
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </label>

      {loadingFile && <p>Reading file and checking existing transactions…</p>}

      {fileName && (
        <>
          <p><strong>File:</strong> {fileName}</p>

          <div className="import-mapping">
            <h3>Map your columns</h3>
            {columnSelect("Transaction date", "date", true)}
            {columnSelect("Description", "description", true)}
            {columnSelect("Debit amount", "debit", true)}
            {columnSelect("Credit amount", "credit", true)}
            {columnSelect("Category (optional)", "category", false)}
            {columnSelect("Notes (optional)", "notes", false)}

            <label className="import-field">
              <span>Date format for text dates</span>
              <select
                value={dateFormat}
                onChange={(event) =>
                  setDateFormat(event.target.value as "dmy" | "mdy")
                }
              >
                <option value="dmy">DD/MM/YYYY</option>
                <option value="mdy">MM/DD/YYYY</option>
              </select>
            </label>

            <p className="small muted">
              ISO dates (YYYY-MM-DD) and Excel date cells are also supported.
              When category is unmapped or blank, the matching “Other Income”
              or “Other Expense” category is used.
            </p>
          </div>

          <h3>Preview</h3>
          <p>
            {validCount} valid · {invalidCount} invalid · {duplicateCount} duplicate-looking
          </p>

          <label className="import-duplicate-option">
            <input
              type="checkbox"
              checked={allowDuplicates}
              onChange={(event) => setAllowDuplicates(event.target.checked)}
            />
            Allow duplicate-looking rows (review carefully)
          </label>

          <div className="import-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 100).map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.transaction?.transaction_date ?? "—"}</td>
                    <td>{row.transaction?.description ?? "—"}</td>
                    <td>{row.transaction?.kind ?? "—"}</td>
                    <td>
                      {row.transaction
                        ? formatPaisa(row.transaction.amount_paisa)
                        : "—"}
                    </td>
                    <td>
                      {row.issues.length > 0
                        ? row.issues.join(" ")
                        : row.duplicateReason
                          ? row.duplicateReason
                          : "Ready"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.length > 100 && (
            <p className="small muted">
              Showing the first 100 rows of {preview.length}. All rows are validated.
            </p>
          )}

          <button
            type="button"
            className="primary-button"
            disabled={
              importing ||
              loadingFile ||
              !existingLoaded ||
              importable.length === 0
            }
            onClick={() => void importTransactions()}
          >
            {importing ? "Importing…" : `Import ${importable.length} transactions`}
          </button>
        </>
      )}

      {error && <p className="error-message" role="alert">{error}</p>}
      {message && <p className="success-message" role="status">{message}</p>}
    </section>
  );
}
