# ShopPOS

Offline-first inventory and point of sale for one shop, packaged as a Windows app that updates itself from GitHub releases.

- Owner instructions: [docs/OWNER-GUIDE.md](docs/OWNER-GUIDE.md)
- Developer and release instructions: [docs/RELEASE.md](docs/RELEASE.md)

## Stack

Tauri 2 (Windows shell, signed auto updates), Rust core with SQLite (`crates/pos-core`), React and TypeScript screens (`src`).

## Design notes

- **Owner-defined catalog.** Categories, fields (text, long notes, whole numbers, decimals with units, money, dates, yes/no, choice lists) and per-item fields are rows, not columns. Values are stored typed (`item_values.v_text / v_int / v_num`) so filters compare numbers as numbers and dates as dates.
- **Money** is an integer number of cents. Every split (discounts, partial returns, FIFO lots) uses integer allocation so totals add up exactly.
- **Stock ledger.** Every purchase, sale, return, correction and reversal writes the transaction, its lines and its stock movements in one SQLite transaction. Each movement points at the purchase lot it came from.
- **Costing.** One of a kind items carry their own purchase cost. Quantity items use FIFO by business date; the cost of each sale is fixed when it is posted and stored on the line.
- **Nothing is deleted.** Database triggers refuse DELETE on business tables and UPDATE on posted transactions. Corrections are linked reversals, returns or stock corrections with a reason. Item edits are written to `audit_log`.
- **Double posting.** Every post carries a client token with a UNIQUE constraint; a retry returns the original record.
- **Receipts** keep a snapshot of descriptions, printed fields and shop branding at the time they were issued.
- **Backups** use the SQLite online backup API, content-addressed photo storage, a manifest of hashes, verification before a backup counts as successful, and a guided restore.
- **Updates** happen before the database is opened. Migrations are versioned, run in transactions, and are preceded by a verified safety copy.
