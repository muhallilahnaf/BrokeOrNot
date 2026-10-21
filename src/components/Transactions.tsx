
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { useToastFeedback } from "./toast-context";
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

export type EditableTransaction = Transaction;

type Props = {
    userId: string;
    openingBalancePaisa: string | number;
    openingBalanceDate: string;
    categories: Category[];
    transactionToEdit: EditableTransaction | null;
    onEditCancelled: () => void;
    onTransactionChanged: () => void;
};

const PAGE_SIZE = 1000;

export default function Transactions({
    userId,
    openingBalancePaisa,
    openingBalanceDate,
    categories,
    transactionToEdit,
    onEditCancelled,
    onTransactionChanged,
}: Props) {
    const [kind, setKind] = useState<"expense" | "income">(
        () => transactionToEdit?.kind ?? "expense"
    );
    const [date, setDate] = useState(
        () => transactionToEdit?.transaction_date ?? getLocalDateString()
    );
    const [description, setDescription] = useState(
        () => transactionToEdit?.description ?? ""
    );
    const [amount, setAmount] = useState(() => transactionToEdit
        ? formatPaisa(transactionToEdit.amount_paisa).replace(/[^0-9.-]/g, "")
        : ""
    );
    const [categoryId, setCategoryId] = useState(
        () => transactionToEdit?.category_id ?? ""
    );
    const [notes, setNotes] = useState(() => transactionToEdit?.notes ?? "");

    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [saving, setSaving] = useState(false);
    const { setError, setMessage } = useToastFeedback();
    const [reloadKey, setReloadKey] = useState(0);

    const editingId = transactionToEdit?.id ?? null;


    const availableCategories = useMemo(
        () =>
            categories.filter(
                (category) =>
                    category.kind === kind &&
                    (category.is_active ||
                        category.id === transactionToEdit?.category_id)
            ),
        [categories, kind, transactionToEdit?.category_id]
    );

    // Keep the selected value valid without syncing derived state in an effect.
    const selectedCategoryId = availableCategories.some(
        (category) => category.id === categoryId
    ) ? categoryId : (availableCategories[0]?.id ?? "");

    const loadTransactions = useCallback(async () => {
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

            return allRows;
    }, [userId]);


    function cancelEditing() {
        onEditCancelled();
        setError("");
        setMessage("");
    }

    useEffect(() => {
        let active = true;

        async function refreshTransactions() {
            try {
                const rows = await loadTransactions();
                if (active) setTransactions(rows);
            } catch (err) {
                if (active) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Could not load transaction history."
                    );
                }
            }
        }

        void refreshTransactions();
        return () => { active = false; };
    }, [loadTransactions, reloadKey, setError]);

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
            !selectedCategoryId
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
                category_id: selectedCategoryId,
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

            setReloadKey((key) => key + 1);
            onTransactionChanged();
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
                        autoFocus={Boolean(transactionToEdit)}
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
                        value={selectedCategoryId}
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
                            ? "Savingâ€¦"
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

        </div>
    );
}

