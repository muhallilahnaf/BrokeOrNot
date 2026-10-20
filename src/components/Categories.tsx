
import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

type CategoryKind = "income" | "expense";

type Category = {
  id: string;
  name: string;
  kind: CategoryKind;
  is_active: boolean;
};

type Props = {
  userId: string;
  categories: Category[];
  onCategoriesChanged: () => Promise<void>;
};

const MAX_CATEGORY_NAME_LENGTH = 80;

export default function Categories({
  userId,
  categories,
  onCategoriesChanged,
}: Props) {
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<CategoryKind>("expense");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const sortedCategories = [...categories].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }

    if (a.is_active !== b.is_active) {
      return a.is_active ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  const visibleCategories = sortedCategories.filter(
    (category) => showInactive || category.is_active
  );

  function clearFeedback() {
    setError("");
    setMessage("");
  }

  function validateName(value: string): string {
    const name = value.trim();

    if (!name) {
      return "Enter a category name.";
    }

    if (name.length > MAX_CATEGORY_NAME_LENGTH) {
      return `Category names cannot exceed ${MAX_CATEGORY_NAME_LENGTH} characters.`;
    }

    for (const character of name) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f) {
        return "Category names cannot contain control characters.";
      }
    }

    return "";
  }

  function isDuplicate(
    name: string,
    kind: CategoryKind,
    excludeId?: string
  ): boolean {
    const normalizedName = name.trim().toLocaleLowerCase();

    return categories.some(
      (category) =>
        category.id !== excludeId &&
        category.kind === kind &&
        category.name.trim().toLocaleLowerCase() === normalizedName
    );
  }

  function getDatabaseError(errorMessage: string): string {
    if (errorMessage.includes("23505")) {
      return "A category with that name already exists for this type.";
    }

    if (errorMessage.includes("42501")) {
      return "Permission denied. Check your Supabase RLS policies.";
    }

    return errorMessage;
  }

  async function refreshCategories() {
    await onCategoriesChanged();
  }

  async function handleAddCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();

    const name = newName.trim();
    const validationError = validateName(name);

    if (validationError) {
      setError(validationError);
      return;
    }

    if (isDuplicate(name, newKind)) {
      setError(
        "A category with that name already exists for this type."
      );
      return;
    }

    setBusy(true);

    try {
      const { error: insertError } = await supabase
        .from("categories")
        .insert({
          user_id: userId,
          name,
          kind: newKind,
          is_active: true,
        });

      if (insertError) {
        throw new Error(getDatabaseError(insertError.message));
      }

      setNewName("");
      setNewKind("expense");
      setMessage("Category added successfully.");

      await refreshCategories();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not add the category."
      );
    } finally {
      setBusy(false);
    }
  }

  function startEditing(category: Category) {
    clearFeedback();
    setEditingId(category.id);
    setEditingName(category.name);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditingName("");
  }

  async function handleRename(
  event: FormEvent<HTMLFormElement>,
  category: Category
) {
    event.preventDefault();
    clearFeedback();

    const name = editingName.trim();
    const validationError = validateName(name);

    if (validationError) {
      setError(validationError);
      return;
    }

    if (isDuplicate(name, category.kind, category.id)) {
      setError(
        "A category with that name already exists for this type."
      );
      return;
    }

    if (name === category.name) {
      cancelEditing();
      return;
    }

    setBusy(true);

    try {
      const { data, error: updateError } = await supabase
        .from("categories")
        .update({ name })
        .eq("id", category.id)
        .eq("user_id", userId)
        .select("id");

      if (updateError) {
        throw new Error(getDatabaseError(updateError.message));
      }

      if (!data || data.length === 0) {
        throw new Error(
          "The category was not updated. It may no longer exist or you may not have permission to update it."
        );
      }

      cancelEditing();
      setMessage("Category renamed successfully.");

      await refreshCategories();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not rename the category."
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(category: Category) {
    clearFeedback();

    const confirmed = window.confirm(
      category.is_active
        ? `Deactivate "${category.name}"? Existing transactions will keep this category, but it will no longer be available for new transactions.`
        : `Reactivate "${category.name}"? It will become available for new transactions again.`
    );

    if (!confirmed) return;

    setBusy(true);

    try {
      const { data, error: updateError } = await supabase
        .from("categories")
        .update({ is_active: !category.is_active })
        .eq("id", category.id)
        .eq("user_id", userId)
        .eq("is_active", category.is_active)
        .select("id");

      if (updateError) {
        throw new Error(getDatabaseError(updateError.message));
      }

      if (!data || data.length === 0) {
        throw new Error(
          "The category was not changed. Refresh the page and try again."
        );
      }

      setMessage(
        category.is_active
          ? "Category deactivated. Historical transactions are preserved."
          : "Category reactivated successfully."
      );

      await refreshCategories();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not update the category status."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel categories-panel">
      <h2>Manage categories</h2>

      <p className="muted">
        Create and organize your income and expense categories.
        Deactivated categories remain attached to historical records.
      </p>

      <form className="category-create-form" onSubmit={handleAddCategory}>
        <label className="field-label" htmlFor="new-category-name">
          Category name
          <input
            id="new-category-name"
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            maxLength={MAX_CATEGORY_NAME_LENGTH}
            placeholder="e.g. Medical Insurance"
            disabled={busy}
            required
          />
        </label>

        <label className="field-label" htmlFor="new-category-kind">
          Type
          <select
            id="new-category-kind"
            value={newKind}
            onChange={(event) =>
              setNewKind(event.target.value as CategoryKind)
            }
            disabled={busy}
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </label>

        <button
          type="submit"
          className="primary-button"
          disabled={busy}
        >
          {busy ? "Please wait…" : "Add category"}
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}

      <div className="category-management-toolbar">
        <h3>Existing categories ({categories.length})</h3>

        <label className="category-inactive-toggle">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
            disabled={busy}
          />
          Show inactive categories
        </label>
      </div>

      {visibleCategories.length === 0 ? (
        <p className="muted">
          {showInactive
            ? "No categories exist yet."
            : "No active categories to display."}
        </p>
      ) : (
        <div className="category-management-list">
          {visibleCategories.map((category) => (
            <article
              className={`category-management-item ${
                category.is_active ? "" : "category-inactive"
              }`}
              key={category.id}
            >
              {editingId === category.id ? (
                <form
                  className="category-rename-form"
                  onSubmit={(event) =>
                    void handleRename(event, category)
                  }
                >
                  <label
                    className="field-label"
                    htmlFor={`rename-category-${category.id}`}
                  >
                    Rename category
                    <input
                      id={`rename-category-${category.id}`}
                      type="text"
                      value={editingName}
                      onChange={(event) =>
                        setEditingName(event.target.value)
                      }
                      maxLength={MAX_CATEGORY_NAME_LENGTH}
                      disabled={busy}
                      autoFocus
                      required
                    />
                  </label>

                  <div className="category-actions">
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={busy}
                    >
                      Save
                    </button>

                    <button
                      type="button"
                      className="secondary-button"
                      onClick={cancelEditing}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="category-management-details">
                    <strong>{category.name}</strong>

                    <div className="category-management-badges">
                      <span className="pill">
                        {category.kind === "income"
                          ? "Income"
                          : "Expense"}
                      </span>

                      {!category.is_active && (
                        <span className="category-status-inactive">
                          Inactive
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="category-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => startEditing(category)}
                      disabled={busy}
                    >
                      Rename
                    </button>

                    <button
                      type="button"
                      className={
                        category.is_active
                          ? "danger-button"
                          : "secondary-button"
                      }
                      onClick={() => void handleToggleActive(category)}
                      disabled={busy}
                    >
                      {category.is_active
                        ? "Deactivate"
                        : "Reactivate"}
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
