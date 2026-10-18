
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../lib/supabase";
import {
    formatPaisa,
    getLocalDateString,
    parseTakaToPaisa,
} from "../lib/money";

type Category = {
    id: string;
    name: string;
    kind: "income" | "expense";
    is_active: boolean;
};

type Transaction = {
    id: string;
    transaction_date: string;
    description: string;
    kind: "income" | "expense";
    amount_paisa: string | number;
    category_id: string;
    notes: string | null;
    source: string;
};

type Props = {
    userId: string;
    openingBalancePaisa: string | number;
    openingBalanceDate: string;
    categories: Category[];
    refreshKey: number;
};

const PAGE_SIZE = 1000;

export default function Transactions({
    userId,
    openingBalancePaisa,
    openingBalanceDate,
    categories,
    refreshKey
}: Props) {
    const [kind, setKind] = useState<"expense" | "income">("expense");
    const [date, setDate] = useState(getLocalDateString());
    const [description, setDescription] = useState("");
    const [amount, setAmount] = useState("");
    const [categoryId, setCategoryId] = useState("");
    const [notes, setNotes] = useState("");

    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const [reloadKey, setReloadKey] = useState(0);

    const [editingId, setEditingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);


    const availableCategories = useMemo(
        () =>
            categories.filter(
                (category) =>
                    category.kind === kind && category.is_active
            ),
        [categories, kind]
    );

    const categoryNames = useMemo(
        () => new Map(categories.map((category) => [
            category.id,
            category.name,
        ])),
        [categories]
    );

    const loadTransactions = useCallback(async () => {
        setLoading(true);
        setError("");

        try {
            const allRows: Transaction[] = [];

            // Supabase can cap individual responses. Fetch in pages so
            // the balance isn't silently based on only the first page.
            for (let from = 0; ; from += PAGE_SIZE) {
                const { data, error } = await supabase
                    .from("transactions")
                    .select(
                        "id, transaction_date, description, kind, amount_paisa, category_id, notes, source"
                    )
                    .eq("user_id", userId)
                    .order("transaction_date", { ascending: false })
                    .order("created_at", { ascending: false })
                    .range(from, from + PAGE_SIZE - 1);

                if (error) throw error;

                const page = (data ?? []) as Transaction[];
                allRows.push(...page);

                if (page.length < PAGE_SIZE) break;
            }

            setTransactions(allRows);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not load transaction history."
            );
        } finally {
            setLoading(false);
        }
    }, [userId]);


    function startEditing(transaction: Transaction) {
        setEditingId(transaction.id);
        setKind(transaction.kind);
        setDate(transaction.transaction_date);
        setDescription(transaction.description);
        setAmount(
            formatPaisa(transaction.amount_paisa)
                .replace(/^৳/, "")
                .replace(/,/g, "")
        );
        setCategoryId(transaction.category_id);
        setNotes(transaction.notes ?? "");
        setError("");
        setMessage("");
        setConfirmDeleteId(null);

        // Move focus toward the form for a smoother editing workflow.
        document.getElementById("transaction-description")?.focus();
    }

    function cancelEditing() {
        setEditingId(null);
        setDescription("");
        setAmount("");
        setNotes("");
        setDate(getLocalDateString());
        setError("");
        setMessage("");
    }

    async function deleteTransaction(transactionId: string) {
        const transaction = transactions.find(
            (item) => item.id === transactionId
        );

        if (!transaction) {
            setError("This transaction is no longer in the displayed history.");
            setConfirmDeleteId(null);
            return;
        }

        setDeletingId(transactionId);
        setError("");
        setMessage("");

        try {
            const { data, error } = await supabase
                .from("transactions")
                .delete()
                .eq("id", transactionId)
                .eq("user_id", userId)
                .select("id")
                .maybeSingle();

            if (error) throw error;

            if (!data) {
                throw new Error(
                    "No transaction was deleted. It may already have been removed, or you may not have permission to access it."
                );
            }

            if (editingId === transactionId) {
                cancelEditing();
            }

            setConfirmDeleteId(null);
            setMessage("Transaction deleted.");
            setReloadKey((key) => key + 1);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not delete the transaction."
            );
        } finally {
            setDeletingId(null);
        }
    }


    useEffect(() => {
        void loadTransactions();
    }, [loadTransactions, reloadKey, refreshKey]);

    useEffect(() => {
        // Select a valid category when the type changes or categories load.
        if (!availableCategories.some((c) => c.id === categoryId)) {
            setCategoryId(availableCategories[0]?.id ?? "");
        }
    }, [availableCategories, categoryId]);

    const currentBalance = useMemo(() => {
        let balance = BigInt(openingBalancePaisa);

        for (const transaction of transactions) {
            // The opening balance is the balance at the START of its date.
            // Earlier transactions stay in history but aren't counted again.
            if (transaction.transaction_date < openingBalanceDate) continue;

            const amountPaisa = BigInt(transaction.amount_paisa);

            balance += transaction.kind === "income"
                ? amountPaisa
                : -amountPaisa;
        }

        return balance;
    }, [transactions, openingBalancePaisa, openingBalanceDate]);


    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError("");
        setMessage("");

        if (!description.trim()) {
            setError("Enter a transaction description.");
            return;
        }

        if (description.trim().length > 240) {
            setError("The description must be 240 characters or fewer.");
            return;
        }

        if (!date) {
            setError("Select a transaction date.");
            return;
        }

        if (date < openingBalanceDate) {
            setError(
                "The transaction date cannot be before your opening-balance date."
            );
            return;
        }

        if (
            !categoryId ||
            !availableCategories.some((category) => category.id === categoryId)
        ) {
            setError("Choose a valid category for this transaction.");
            return;
        }

        if (notes.length > 5000) {
            setError("Notes must be 5,000 characters or fewer.");
            return;
        }

        let amountPaisa: bigint;

        try {
            amountPaisa = parseTakaToPaisa(amount);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Enter a valid amount."
            );
            return;
        }

        setSaving(true);

        try {
            const values = {
                transaction_date: date,
                description: description.trim(),
                kind,
                amount_paisa: amountPaisa.toString(),
                category_id: categoryId,
                notes: notes.trim() || null,
            };

            if (editingId) {
                const { data, error } = await supabase
                    .from("transactions")
                    .update(values)
                    .eq("id", editingId)
                    .eq("user_id", userId)
                    .select("id")
                    .maybeSingle();

                if (error) throw error;

                if (!data) {
                    throw new Error(
                        "No transaction was updated. It may have been deleted, or you may not have permission to edit it."
                    );
                }

                setMessage("Transaction updated successfully.");
                setEditingId(null);
            } else {
                const { error } = await supabase
                    .from("transactions")
                    .insert({
                        user_id: userId,
                        ...values,
                        source: "manual",
                    });

                if (error) throw error;

                setMessage("Transaction saved successfully.");
            }

            setDescription("");
            setAmount("");
            setNotes("");
            setDate(getLocalDateString());
            setConfirmDeleteId(null);

            setReloadKey((key) => key + 1);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not save the transaction."
            );
        } finally {
            setSaving(false);
        }
    }


    return (
        <div className="transactions-layout">
            <section className="panel">
                <h2>{editingId ? "Edit transaction" : "Add a transaction"}</h2>

                <div className="tabs">
                    <button
                        type="button"
                        className={kind === "expense" ? "tab active" : "tab"}
                        onClick={() => setKind("expense")}
                    >
                        Expense
                    </button>
                    <button
                        type="button"
                        className={kind === "income" ? "tab active" : "tab"}
                        onClick={() => setKind("income")}
                    >
                        Income
                    </button>
                </div>

                <form onSubmit={handleSubmit}>
                    <label htmlFor="transaction-description">Description</label>
                    <input
                        id="transaction-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder={
                            kind === "income" ? "e.g. Monthly salary" : "e.g. Groceries"
                        }
                        maxLength={240}
                        required
                    />

                    <label htmlFor="transaction-amount">Amount (BDT)</label>
                    <input
                        id="transaction-amount"
                        type="text"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder="0.00"
                        autoComplete="off"
                        required
                    />

                    <label htmlFor="transaction-category">Category</label>
                    <select
                        id="transaction-category"
                        value={categoryId}
                        onChange={(event) => setCategoryId(event.target.value)}
                        required
                        disabled={availableCategories.length === 0}
                    >
                        {availableCategories.length === 0 ? (
                            <option value="">No categories available</option>
                        ) : (
                            availableCategories.map((category) => (
                                <option key={category.id} value={category.id}>
                                    {category.name}
                                </option>
                            ))
                        )}
                    </select>

                    <label htmlFor="transaction-date">Transaction date</label>
                    <input
                        id="transaction-date"
                        type="date"
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                        required
                    />

                    <label htmlFor="transaction-notes">Notes (optional)</label>
                    <textarea
                        id="transaction-notes"
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        placeholder="Additional details"
                        rows={2}
                    />

                    <button
                        className="primary-button"
                        type="submit"
                        disabled={saving || availableCategories.length === 0}
                    >
                        {saving
                            ? "Saving…"
                            : editingId
                                ? "Save changes"
                                : "Save transaction"}
                    </button>

                    {editingId && (
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={cancelEditing}
                            disabled={saving}
                        >
                            Cancel editing
                        </button>
                    )}
                </form>

                {error && <p className="error" role="alert">{error}</p>}
                {message && <p className="success" role="status">{message}</p>}
            </section>

            <section className="panel">
                <h2>Current tracked balance</h2>
                <p className="balance-amount">{formatPaisa(currentBalance)}</p>
                <p className="small muted">
                    Opening balance plus income minus expenses from{" "}
                    {openingBalanceDate}.
                </p>
                <p className="small muted">
                    Transactions before the opening-balance date remain in history
                    but are excluded from this balance.
                </p>
            </section>

            <section className="panel">
                <div className="history-heading">
                    <h2>Transaction history</h2>
                    <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setReloadKey((key) => key + 1)}
                        disabled={loading}
                    >
                        Refresh
                    </button>
                </div>

                {loading ? (
                    <p className="muted">Loading transactions…</p>
                ) : transactions.length === 0 ? (
                    <p className="muted">No transactions yet. Add your first one above.</p>
                ) : (
                    <div className="table-scroll">
                        <table className="transaction-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Description</th>
                                    <th>Category</th>
                                    <th>Type</th>
                                    <th className="amount-cell">Amount</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {transactions.map((transaction) => (
                                    <tr key={transaction.id}>
                                        <td>{transaction.transaction_date}</td>
                                        <td>
                                            <strong>{transaction.description}</strong>
                                            {transaction.notes && (
                                                <div className="small muted">{transaction.notes}</div>
                                            )}
                                        </td>
                                        <td>
                                            {categoryNames.get(transaction.category_id) ?? "Unknown"}
                                        </td>
                                        <td>{transaction.kind}</td>
                                        <td className="amount-cell">
                                            <span
                                                className={
                                                    transaction.kind === "income"
                                                        ? "income-amount"
                                                        : "expense-amount"
                                                }
                                            >
                                                {transaction.kind === "income" ? "+" : "−"}
                                                {formatPaisa(transaction.amount_paisa)}
                                            </span>
                                        </td>

                                        <td className="transaction-actions">
                                            <div className="action-buttons">
                                                <button
                                                    type="button"
                                                    className="secondary-button small-button"
                                                    onClick={() => startEditing(transaction)}
                                                    disabled={saving || deletingId !== null}
                                                >
                                                    Edit
                                                </button>

                                                <button
                                                    type="button"
                                                    className="danger-button small-button"
                                                    onClick={() => {
                                                        setConfirmDeleteId(transaction.id);
                                                        setError("");
                                                        setMessage("");
                                                    }}
                                                    disabled={saving || deletingId !== null}
                                                >
                                                    Delete
                                                </button>
                                            </div>

                                            {confirmDeleteId === transaction.id && (
                                                <div className="delete-confirmation">
                                                    <p>Delete this transaction permanently?</p>
                                                    <p className="small muted">
                                                        This will change your tracked balance.
                                                    </p>

                                                    <div className="action-buttons">
                                                        <button
                                                            type="button"
                                                            className="danger-button small-button"
                                                            onClick={() => void deleteTransaction(transaction.id)}
                                                            disabled={deletingId === transaction.id}
                                                        >
                                                            {deletingId === transaction.id
                                                                ? "Deleting…"
                                                                : "Confirm delete"}
                                                        </button>

                                                        <button
                                                            type="button"
                                                            className="secondary-button small-button"
                                                            onClick={() => setConfirmDeleteId(null)}
                                                            disabled={deletingId === transaction.id}
                                                        >
                                                            Keep transaction
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </td>

                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
