# BrokeOrNot

[brokeornot.vercel.app](https://brokeornot.vercel.app/)

BrokeOrNot is a personal finance and cash-flow tracking web app designed
with a calendar view to help users understand their current balance, 
review spending, manage recurring transactions, and forecast upcoming cash flow. 
It supports importing transaction history from CSV and Excel files.

## Features

### Calendar cash-flow forecast

-   Displays daily income and expense totals in a compact calendar.
-   Shows projected balances for calendar days.
-   Opens a day-detail view when a date is selected.
-   Shows the day's opening balance, recorded income and expenses,
    actual balance, and projected balance.
-   Uses pending scheduled occurrences to help estimate future cash
    flow.

### Transaction management

-   Add income and expense transactions manually.
-   Assign transactions to categories.
-   Edit or delete existing transactions.
-   View transaction history and keep dashboard totals updated after
    changes.
-   Track transaction dates, descriptions, amounts, categories, and
    source information.

### Recurring schedules

-   Configure recurring income or expense schedules.
-   Support weekly, monthly, quarterly, and yearly frequencies.
-   Generate scheduled occurrences for future dates.
-   Mark an occurrence as paid, skipped, or cancelled.
-   Record scheduled payments as transactions and connect them to their
    originating occurrence.

### Dashboard and financial overview

-   Displays the current balance based on the opening balance and
    recorded transactions.
-   Summarizes income, expenses, and net cash flow for a selected month.
-   Supports navigating between months.
-   Breaks down recorded expenses by category.
-   Shows upcoming pending scheduled occurrences.
-   Estimates the lowest projected balance over the configured forecast
    horizon.
-   Includes a monthly spending progress bar showing available money,
    amount spent, and remaining money.

### CSV and Excel import

-   Import transaction history from CSV and Excel spreadsheets.
-   Supports separate Debit and Credit columns.
-   Recognizes common date formats and Excel date cells.
-   Maps debit entries to expenses and credit entries to income.
-   Validates rows and flags potential duplicates or invalid entries
    before import.
-   Rejects problematic files and excessive imports according to
    configured size and row limits.

### Categories

-   Create income and expense categories.
-   Rename categories.
-   Deactivate categories to remove them from new-entry choices without
    hiding historical transactions.
-   Reactivate previously deactivated categories.
-   Prevent duplicate category names within the same transaction type.

### Settings and account isolation

-   Configure an opening balance and its effective date.
-   Configure the forecast horizon and week-start preference.
-   Uses email-based authentication through Supabase.
-   Applies Supabase Row Level Security (RLS) so authenticated users can
    access only their own records.

## Technology

-   **Frontend:** React, TypeScript, and Vite
-   **Backend and database:** Supabase
-   **Authentication:** Supabase Auth (email-based)
-   **Database access:** Supabase JavaScript client
-   **Spreadsheet import:** SheetJS (`xlsx`)
-   **Styling:** Component-specific CSS

## Money and balance handling

-   Monetary amounts are stored as integer paisa to avoid floating-point
    rounding errors in financial calculations.
-   Balances are calculated from the configured opening balance and
    applicable transactions.
-   Forecasts combine recorded future-dated transactions with pending
    scheduled occurrences, according to the selected forecast period.
-   Pending scheduled payments are forecasts, not completed
    transactions, until they are marked as paid.

## Getting started

These instructions assume you have the project source code and a
configured Supabase project.

### Prerequisites

-   Node.js and npm
-   A Supabase project
-   The project's environment configuration and database schema

### Install dependencies

From the project directory, run:

``` bash
npm install
```

### Configure Supabase

Create or review the project's environment file according to the
variables referenced by `src/lib/supabase.ts`. For a typical Vite setup,
the public project URL and publishable/anon key are supplied through
`VITE_`-prefixed environment variables.

For example, if these are the variable names used by your code:

``` env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_or_anon_key
```

Use the exact variable names expected by your existing
`src/lib/supabase.ts`. Never place a Supabase service-role key in
frontend environment variables or commit secrets to version control.

The Supabase database must have the tables, constraints, indexes, Row
Level Security policies, and database functions required by the
application. Refer to the SQL migrations or setup scripts maintained
with your project.

### Run locally

``` bash
npm run dev
```

Vite will print a local development URL in the terminal.

### Build for production

``` bash
npm run build
```

To run the production build locally, use:

``` bash
npm run preview
```

## Project structure

The structure below describes the main areas of the application;
filenames may vary slightly as the project evolves.

``` text
src/
├── components/
│   ├── FinancialDashboard.tsx
│   ├── CalendarForecast.tsx
│   ├── CalendarForecast.css
│   └── ...other feature components
├── lib/
│   ├── supabase.ts
│   └── money.ts
├── App.tsx
└── ...
```

-   `src/App.tsx` mounts the authenticated app and its main features.
-   `src/lib/supabase.ts` initializes the Supabase client.
-   `src/lib/money.ts` contains shared money-formatting and conversion
    utilities.
-   Feature components handle the dashboard, calendar, transactions,
    categories, settings, and recurring schedules.

## Security notes

-   Keep Row Level Security enabled on user-owned tables.
-   Review every table policy and database function when changing the
    schema.
-   Do not expose service-role credentials in the browser.
-   Validate imported data before inserting it into the database.
-   Test with separate user accounts when modifying queries or policies.

## Current scope and future improvements

BrokeOrNot currently focuses on manual and imported transaction
tracking, recurring cash flows, and balance forecasting. Potential
future improvements include:

-   Automated backup and restore.
-   More comprehensive data-integrity and regression tests.
-   More detailed monthly reports and comparisons.
-   Additional usability and mobile-layout refinements.

## Disclaimer

BrokeOrNot is a personal tracking and forecasting tool. Forecasts depend
on the accuracy of entered transactions, opening-balance settings, and
recurring schedules. They should not be treated as guaranteed future
balances or professional financial advice.
