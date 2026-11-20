[HANDOVER (43).md](https://github.com/user-attachments/files/35123804/HANDOVER.43.md)
# ContractorPOS — Build Handover

Last updated: 2026-11-19 · Current version: **ContractorPOS v1.20**

**ContractorPOS is a separate product from MultiPOS** (the store POS): its own GitHub repo, Render web service and database.
Changes to one never affect the other. It started as a copy of MultiPOS v1.10, so sections 1–9 describe that shared foundation
(read "ContractorPOS" where it says MultiPOS). Sections 10–11 are contractor-only. Attach this file and the latest
`contractorpos-v1.0.zip` to a new conversation to keep building.

---

## 1. What MultiPOS is

A web-based point of sale for **many businesses, each with many locations and registers**, run by one platform administrator (you), who provides it as a service to store owners.

- Runs in any browser (PC, tablet, phone). No app install.
- **Phones act as wireless barcode scanners**: scan a QR code on the register, and anything the phone's camera scans lands in that register's cart instantly.
- Built "basics first, extras later", one feature at a time, each tested end to end in a real browser against a real database before delivery.

---

## 2. Hosting, stack, deploy

| Piece | What's used |
|---|---|
| Code | GitHub repo `Petertoon/multipos`, branch `main` |
| Hosting | Render **Web Service** (`multipos`, Node), live at `https://multipos-hv55.onrender.com` |
| Database | Render **PostgreSQL** (connected via `DATABASE_URL`) |
| Runtime | Node 18+, Express 4, `pg`, `bcryptjs`, `cookie-parser`, `qrcode` |
| Scanner libraries | `barcode-detector@2.3.1` and `zxing-wasm@1.3.4` (exact versions pinned), served from `/vendor` |
| Front end | Plain HTML + JavaScript pages in `public/` — no React, no build step |

**Deploy flow:** upload changed files (or the whole zip) to GitHub → Render auto-deploys from `main`. The database schema creates/updates itself on startup — there are no manual migrations.

**Render environment variables**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (from the Render database) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | Intuit app keys (QuickBooks Online) |
| `QBO_ENVIRONMENT` | `sandbox` now; `production` later |
| `RESEND_API_KEY` | Email receipts (resend.com) |
| `RECEIPT_FROM_EMAIL` | Optional; defaults to `receipts@lokaalhub.com` |

Secrets go **only** into Render's Environment page — never into chat or GitHub.

---

## 3. File map and architecture

```
multipos/
  server.js        All API routes (~80): auth, businesses, locations, registers, cart, checkout,
                   products, pending items, rentals, refunds, gift cards, customers, quotes,
                   reports, deposits, sales, receipts. Live updates via Server-Sent Events.
  db.js            Whole database schema. Runs on every startup (CREATE ... IF NOT EXISTS,
                   ALTER ... ADD COLUMN IF NOT EXISTS). One multi-statement query.
  jobfiles.js      Job files (PDFs, photos) and "Estimate with Claude" (materials list from a plan or photo).
  jobs.js          Jobs add-on: job board columns, jobs, job items, job payments, discount, history, live updates.
  qbo.js           QuickBooks Online live sync (OAuth, account mapping, daily journal entries, deposits).
  email.js         Email receipts through Resend.
  package.json     Dependencies + "start": "node server.js"
  public/
    app.js         Shared browser helpers: api(), money(), toast(), receipt/quote layouts,
                   WhatsApp, text and email send dialogs.
    hours.js       Business hours + rental due-time math. Shared by server AND browser.
    style.css      Shared styles.
    checkout.html  The register screen (cart, pay, split pay, customers, PO/job site, fees,
                   quotes, rentals, phone-scanner QR, WhatsApp box).
    admin.html     "Manage" screens: Businesses (platform admin), Products, Pending items,
                   Refunds owed, Customers, Reports, Deposits, QuickBooks, Locations,
                   Employees, Sales, Settings.
    jobs.html      Contractor job board + job ticket (Jobs add-on).
    scan.html      Phone scanner page (camera, flashlight, add-unknown-item to pending).
    login.html, setup.html, index.html
    receipt.html, r.html (customer receipt link), quote.html, giftcard.html,
    statement.html (customer account statement), deposit.html (deposit slip), receipt.css
```

**Key patterns**
- **Accounts & roles:** `admin` (platform — you), `owner`, `manager`, `cashier`. The platform admin can "enter" any business (`acting_business_id`) to help set it up.
- **Sessions:** a `sessions` table + an httpOnly cookie named `mp_session`.
- **Every query is scoped by `business_id`**, so one store can never see another's data.
- **Live register:** each register's cart is stored in the database (JSONB). Phone scans and register changes push updates over Server-Sent Events.
- **Phone pairing:** the register shows a QR code for `/scan#<pair_token>`; "New code" rotates the token.
- **Add-ons switched on per business** by the platform admin: Rentals, QuickBooks.

---

## 4. Data model

Tables: `businesses`, `locations`, `registers`, `users`, `sessions`, `products`, `sales`, `sale_items`, `sale_payments`, `pending_items`, `rentals`, `gift_cards`, `refunds`, `customers`, `account_payments`, `deposits`, `quotes`, `qbo_connections`, `qbo_syncs`.

**Rules that matter**
- **Money is always whole cents (integers).** Never floats.
- Product photos are resized in the browser (JPEG, max 600 px) and stored in the database (BYTEA).
- `DATE` columns come back as plain strings (type parser `1082`) to avoid time-zone shifts.
- Payment-method CHECK constraints are defined **once, at the end of the schema**:
  - `sale_payments.method`: cash, card, other, gift_card, check, account
  - `sales.payment_method`: the same plus `split`
- Locations carry their own tax rate and (since v1.10) business hours (`hours` JSONB).

---

## 5. Features built (in order)

| Version | Added |
|---|---|
| v1.0 | Businesses/locations/registers/users, products, register checkout, cash/card/other, receipts, phone scanner pairing |
| | Product photos |
| | WhatsApp receipts (link to a customer receipt page) |
| | Scanner: green/red camera button, flashlight auto-on, directions; switched to `barcode-detector` + ZXing for reliable reads |
| | **Pending items**: unknown barcode → temporary name, photo, price → management approves into the product list |
| | WhatsApp box under the scanner that reuses one tab (app or web mode) |
| | **Split pay** (any mix of methods, split evenly) |
| | **Rentals add-on**: prepaid half day / day / week / month; late return = custom charge; early return refund as cash, gift card, or check (Refunds-owed ledger) |
| v1.x | **Contractor-style list**: PO #, quotes tied to a phone number, job site address/GPS, delivery fee, fuel charge (amount or %), customer list with **charge accounts** (credit limit, statements, payments), tax report (day/week/month/year), cash & checks collected, **deposit slips**, checks with check numbers |
| v1.7 | Constraint cleanup (fixes restart crash after gift-card/check/account sales) |
| v1.8 | **QuickBooks Online live sync** (phase 1) |
| v1.9 | **Text and email receipts** |
| v1.10 | **Business hours per location**; rental time skips closed hours |
| v1.11 | **Jobs add-on (contractor job board)** — see section 10 |

---

## 6. Integrations

**Phone scanner** — `scan.html` uses the camera with `barcode-detector` (ZXing WebAssembly underneath). Camera must be on HTTPS (Render provides it). Directions are shown on screen.

**WhatsApp** — opens WhatsApp (desktop app or one reused web tab) with the receipt text and link. No API cost.

**Text** — opens the device's Messages app with a short message + receipt link (`sms:` link). Free; works on phones/tablets (Windows needs Phone Link). Automatic server texting (Twilio, ~1¢/text + $1.15/mo number + one-time A2P 10DLC registration) was deferred.

**Email** — server sends via **Resend** from `receipts@lokaalhub.com` with the store's name as sender; replies go to the store's reply-to email (Settings) or the owner's login email. Free tier 3,000/month. Setup: verify `lokaalhub.com` in Resend (DNS records in Wix) → create API key → `RESEND_API_KEY` in Render.

**QuickBooks Online** (per business, OAuth2):
- Intuit developer app "Test App" in workspace "Petertoon" (sandbox). Redirect URI: `https://multipos-hv55.onrender.com/api/qbo/callback`. Scope `com.intuit.quickbooks.accounting`.
- One **journal entry per location per day** (DocNumber `MP<location>-<YYYYMMDD>`), updated or deleted if the day changes later (voids). Each MultiPOS **deposit** becomes a QuickBooks Deposit to the chosen bank.
- Uses MultiPOS clearing accounts instead of Undeposited Funds. "Create recommended accounts" makes 11 accounts.
- Hourly automatic sync; a day is sent after it ends. Tokens encrypted (AES-256-GCM).
- Connected and tested against **Sandbox Company US a760**.
- **Phase 2 (not built):** charge accounts as real QuickBooks Customers/Invoices/Payments (A/R); production keys (Intuit app review).

---

## 7. Lessons learned / gotchas

- **Build in small steps and test each one end to end** (real Postgres + real browser) before shipping.
- **The schema runs as one implicit transaction on startup** — one bad statement rolls back everything and the server won't start. Put constraints once, at the end.
- **Copying text from chat can add hidden characters** (line breaks/spaces) — the Intuit redirect URI failed until it was typed by hand (count characters: 51).
- Render's **Manual Deploy menu** doesn't save environment changes — use **Save, rebuild, and deploy**.
- Intuit permissions page shows Accounting/Payments **grayed out but on** — that's normal.
- **Never paste secrets into chat**; hide them before screenshots (Render's eye icon).
- Time zones: business days use `America/Chicago` by default; compute "days" in the business's zone, not the server's (UTC).
- Phone camera scanning needs good light, the barcode filling about half the frame, and HTTPS.

---

## 8. Starting a contractor POS from this

**Already done in MultiPOS that a contractor POS needs:** PO numbers, quotes by phone number, job site address/GPS, delivery & fuel charges, charge accounts with credit limits and statements, checks and deposit slips, tax reports, rentals (equipment), QuickBooks sync, phone scanner, receipts by WhatsApp/text/email.

**Decide first:** fork MultiPOS into a new repo (fastest — keep everything, add contractor features) **or** add a "contractor" business type to MultiPOS (one system to maintain). Recommended: decide based on whether contractor customers need a very different register screen.

**Likely new features to scope:**
- Jobs/projects as a first-class record (customer → job → sales, quotes, rentals, delivery)
- Quote → approval → convert to invoice/sale; deposits/progress billing
- Net-30 invoicing on charge accounts, aging report, late fees
- Contractor pricing tiers / per-customer price levels, bulk & unit-of-measure pricing (each, box, foot)
- Tax-exempt customers (resale/exemption certificates)
- Special orders / backorders, purchase orders to suppliers, receiving inventory
- Delivery scheduling and proof of delivery (photo/signature on phone)
- QuickBooks phase 2 (Customers, Invoices, Payments)

---

## 9. Starter prompt for the new thread

> I'm building a **contractor POS**. I previously built **MultiPOS** (multi-business web POS with phones as barcode scanners) — the handover and code are attached (`HANDOVER.md`, `multipos-v1.10.zip`). Use the same stack and approach: Node/Express/Postgres on Render, plain HTML/JS front end, money in cents, schema created on startup, deploy via GitHub. Basics first, extras later; test every feature end to end before delivering, and give me files I can upload to GitHub. First, help me decide whether to fork MultiPOS or add a contractor business type, then plan the first phase.

---

## 10. Jobs add-on — contractor job board (v1.11)

Always on in ContractorPOS (every business). Logging in opens `/jobs`.

**Board** — columns run left to right (default: Quoting, Scheduled, In Progress, Completed, Payment, Closed).
Each column has its own name, color and **up to 3 card buttons** (name, color, on/off, and "Just mark" or "Mark + move to next column").
Owners/managers change them with the ⚙ on a column or **Workflow setup** (add, reorder, remove empty columns; the last column always stays last).
- Jobs move **one column at a time** (drag, the › arrow, or Move to next). Only owners/managers move a job back.
- A job can only enter the last column when its balance is exactly $0 — that closes and locks it.
- Closed jobs leave the board after 60 days ("Older closed jobs" shows them).
- All open boards update live (Server-Sent Events, `/api/jobs/events`).

**Job ticket** (click a card) — POS-style: add inventory items (scan/type, stock is taken off), extra charges / change orders,
equipment rental (rental products at their half day/day/week/month rates). **Totals:** quoted price + added along the way
+ sales tax on taxable lines (job's location rate, or tax exempt) − discount = job total; − payments = balance owed.
- **Take payment** any number of times; each can be split across cash/card/check/other, can't exceed the balance.
- **Finish job:** owner/manager sets a final discount ("Finish at quoted price" fills it in), takes the final payment, closes.
- Every change goes into the job's **history**. Print gives a statement/invoice.
- Cash and check job payments show up in **Deposits** and the cash & checks report.

**Tables:** `job_columns`, `jobs`, `job_items`, `job_payments`, `job_history`; `businesses.jobs_enabled`.

**Not yet (next phases):** job on a charge account (A/R in QuickBooks);
rentals on jobs don't go on the "Rentals out" list; phone scanner pairing to a job; photos on jobs; text/email the statement.

---

## 11. QuickBooks for jobs (ContractorPOS v1.0)

Same connection and daily journal entry as MultiPOS (one entry per location per day, DocNumber `CP<location>-<YYYYMMDD>`), plus:
- **Payments on jobs:** debit the payment clearing account (cash & checks / card / other), credit **ContractorPOS Customer Job Deposits** (a liability: money held for jobs not finished).
- **On the day a job closes** (balance $0): debit Customer Job Deposits (job total) and **Job Discounts** (discount); credit **Job Income**
  (quoted price + extra charges), **Sales** (materials), **Rental Income** (equipment rental), **Sales Tax Collected** (tax on taxable lines).
- Reopening a job (moving it back out of the last column) or voiding a payment updates that day's entry on the next sync.
- Bank deposits include job checks ("Check #2045 from Maria Lopez").
- "Create recommended accounts" now makes 14 accounts (adds Customer Job Deposits, Job Income, Job Discounts).
- The **Sales tax report** counts each job on the day it closes (a "Jobs closed" column); discounts reduce the non-taxable amount.
- Tested against a stand-in Intuit API (env vars `QBO_API_BASE`, `QBO_TOKEN_URL`, `QBO_AUTH_URL` point the app at it). Still to do: a real sandbox run.

**Render environment for ContractorPOS:** same variable names as MultiPOS (`DATABASE_URL` from its own new database, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
`QBO_ENVIRONMENT`, `RESEND_API_KEY`). The Intuit app needs the new redirect URI added: `https://<contractor site>.onrender.com/api/qbo/callback`.

---

## 12. Plans, photos & Claude estimates (ContractorPOS v1.1)

On the job ticket (left side): **📄 Attach PDF**, **📷 Add photo**, **✨ Estimate materials with Claude**.
- Files are stored in the database (`job_files`, BYTEA), 20 MB max each. Photos are shrunk in the browser to 2000 px JPEG (readable blueprints, small uploads).
  Upload = the raw file as the request body (`POST /api/jobs/:id/files?name=`), not JSON. Board cards show 📎 file count.
- Anyone can attach; only the person who added a file, or an owner/manager, can remove it. Files can be added even after a job is closed.
- **Estimate with Claude:** the server sends the PDF (as a `document` block) or photo (`image` block) to the Claude Messages API with the job info,
  the contractor's note, and the store's product names (so Claude uses matching names). Claude answers with JSON: summary, materials
  (name, qty, unit, category, notes), assumptions, questions. It's saved on the job as an "estimate" file next to the plan it came from.
- The review screen matches each material to a product (best name match) or an extra charge (enter a price). Checked lines are added to the
  ticket; quantities round up to whole units. Materials added as charges are marked taxable.
- **Render environment:** `ANTHROPIC_API_KEY` (console.anthropic.com → API keys; billed per use to that account). Optional: `CLAUDE_MODEL`
  (default `claude-sonnet-5-5`), `CLAUDE_DAILY_LIMIT` (estimates per business per day, default 40).
- Tested against a stand-in Claude API (`ANTHROPIC_BASE_URL`). Still to do: a run with a real key and a real blueprint.

---

## 13. Crews per phase (ContractorPOS v1.2)

Job ticket → **👷 Crews** (header button, or the Crews bar at the top of the ticket). Crews are listed by phase (board column);
the current phase always shows, with "+ Add crew to <phase>".
- A crew = trade (Plumber, Electrician, Dirt work … or typed), name/company, phone (tap to call), amount, note, phase.
- **Part of the quote:** the amount is already in the quoted price — the total doesn't change. The panel shows "Part of the quote: $X of $quoted".
- **Cost plus** (v1.3): the amount is the crew's cost; add a markup as a percent of cost or a dollar amount. Cost + markup goes on the
  ticket as the crew's charge line, e.g. "Crew: Plumber — Mike's Plumbing (cost $4,500.00 + 15%)" = $5,175.00. Columns: `markup_type`
  (percent/dollar), `markup_percent`, `markup_cents`, `charge_cents` (what's on the ticket).
- **Up-charge:** the crew gets a linked charge line on the ticket ("Crew: Dirt work — Lone Star Dirt", not taxable), so the total and balance go up.
  Edit/remove the crew to change or take off that line (the line itself can't be edited or deleted from the ticket).
  Up-charges go to Job Income in QuickBooks like any extra charge.
- **✓ Done** marks a crew finished (greyed out). Board cards show the crews working in the job's current phase (not done).
- Table `job_crews`; `job_items.crew_id` links an up-charge line to its crew. Every change is in the job history.

---

## 14. Claude add-on: on/off per business + Ask Claude (ContractorPOS v1.4)

- **Per business:** platform admin → Businesses → **✨ Claude on/off** (`businesses.ai_enabled`, off by default). The button also shows
  how many Claude requests the business made this month. When off, the Claude buttons are hidden and the server refuses Claude requests.
  Both are needed: `ANTHROPIC_API_KEY` on Render AND the business switched on.
- **Ask Claude window** (job ticket → "✨ Ask Claude about a plan or photo", or "✨ Ask Claude" on a file): pick a PDF/photo (or attach one
  right there), type what you want (idea buttons: materials list, square footage, electrical count, check for missing info, scope of work,
  dirt work & concrete), then **✨ Ask Claude** (a written answer) or **📋 Materials list for the ticket** (the estimate from section 12).
- Answers are saved on the job as 💬 conversations (`job_files` kind `answer`, the Q&A in `estimate.thread`). Open one to read it and
  **ask follow-ups** (the file is sent again with the earlier questions and answers; up to 20 per conversation), or turn it into a
  materials list. Answers show headings, bold, lists and tables.
- Every Claude call is logged in `claude_requests` (business, job, user, kind ask/estimate, tokens, ok) — for usage and billing.
  `CLAUDE_DAILY_LIMIT` (default 40) now counts all Claude requests per business per day.

---

## 15. Cards sort by importance (ContractorPOS v1.5)

Customize column → each button has **"Card goes to: ⬆ Top / Middle / ⬇ Bottom"** (stored as `place` in the column's `buttons` JSON).
Cards in a column sort automatically: top group, then middle (including cards with no button pressed), then bottom; within each
group high-priority jobs first, then the job that has been in the column longest. Workflow setup lists each column's buttons with ⬆/⬇.
New boards start with "On Hold" set to bottom; existing boards start with every button at Middle.

---

## 16. Send the quote / statement (ContractorPOS v1.6)

Job ticket → **📤 Send** → WhatsApp, Text or Email (same tools as checkout receipts), plus "Preview what they'll see" and "Copy link".
- Each job gets a private link `/j#<share_token>` (public page `public/j.html`, API `GET /api/public/job/:token`, no login).
  It shows only what the customer should see: business, job info, quoted price, items/charges/rentals, tax, discount, total,
  payments received, balance. No history, no crews' internal costs, no staff names.
- The document is named by where the job is: **Quote** (first column, nothing paid), **Job statement** (after that), **Invoice** (closed).
  Print uses the same name.
- WhatsApp and Text open the app with an editable message and the link; the phone number comes from the job/customer.
- Email goes through Resend (`RESEND_API_KEY`), with an optional note, reply-to = the business; it saves the email on the customer
  if they had none. Max 50 emails per job. `jobs.statement_emailed_to` / `statement_email_count`.
- Every send is logged in the job history ("Emailed the quote to …", "Sent the quote by WhatsApp to …").

---

## 17. Column colors (ContractorPOS v1.7)

Customize column → **Colors**: header background + header letters, column background, card background + card letters, with
ready-made sets (Standard dark, Light cards, Blue, Green, Yellow, Orange, Red, Purple) and a live preview of the column.
Stored on `job_columns`: `color` (header), `text_color`, `bg_color`, `card_color`, `card_text_color` (empty = standard dark look).
The job ticket takes its column's colors (colored top bar, tinted background, colored pane edges), so it's obvious which phase you're in.
The middle **Job ticket** panel (what's on the ticket) uses the column's card colors; the left (add items) and right (totals, payments,
details) panels stay dark because they're information, not ticket lines.

## 18. From MultiPOS v1.11: pickup/delivery, notes, fuel by the gallon, invoices, statements (ContractorPOS v1.8)
Merged from MultiPOS v1.11 (three-way merge against v1.10, no conflicts).
- **Register bar:** 📦 Pickup / Delivery (delivery address, "Use customer's address", + Add delivery fee) and 🗒 Note. Stored on `sales.fulfillment` / `sales.invoice_note`; quotes keep `fulfillment` too.
- **Fuel charge** is gallons × price per gallon (price remembered); prints as "Fuel charge (12.5 gal @ $3.49/gal)".
- **Full-page invoice** `public/invoice.html` (`/invoice?id=`): SOLD TO box, deliver-to/job site, store, invoice #, PO, items, note, totals, "Charged to account" with signature line or "Paid in full". Note can be changed after the sale (`PUT /api/sales/:id/note`).
- **Statements:** `GET /api/customers/:id/statement?from=&to=` → previous balance, charges/payments with running balance, notes, balance due; statement note remembered per customer.
- Job-board payments do not use charge accounts, so statements only cover register sales and account payments.

## 19. Moving a job back needs a reason (ContractorPOS v1.8)
- Owners/managers can move a job back one column (‹ Move back on the ticket, or drag the card to the previous column). A dialog asks why; the server refuses a back move without a note (`POST /api/jobs/:id/move` with `direction:-1, reason`).
- Saved on `jobs.back_reason / back_at / back_by` and in history ("Moved back from X to Y · Reason: …"). The card and ticket header show an orange "↩ Moved back: …" tag; it clears when the job moves forward again. Never shown on the customer page.

## 20. Subcontracts: bids, change orders, payments to subs, sub files (ContractorPOS v1.9)
- A crew's **amount is the sub's bid** (their contract). On each crew row: "Bid · change orders · Paid · Owe" and a **💵 Sub** button.
- **Sub window:** Original bid, Change orders, Contract now, Paid to sub, Still owed.
  - **Payments to the sub:** amount, date, check/cash/card/bank transfer/other, check #, note. Void needs a reason. Can't pay more than is owed when there's a bid.
  - **Change orders:** numbered per sub (CO #1, #2…), amount that adds or credits, required note on what it's for. Optional **"Also charge the customer"** adds a "Change order: Trade: note" charge line to the job ticket (removed with the CO).
  - **Files for this sub:** PDFs/photos tagged to that crew (`job_files.crew_id`); also listed in the job's files with a 👷 tag.
- Right panel **Subcontractors** box: owed per sub, total contracts, paid to subs, still owed to subs.
- Rules: owners/managers only; allowed after the job is closed (except charging the customer); a crew with payments can't be deleted; a bid can't be lowered below what's been paid.
- Tables: `job_crew_payments`, `job_crew_changes`. Routes: `POST /api/jobs/:id/crews/:cid/payments`, `…/payments/:pid/void`, `…/changes`, `DELETE …/changes/:chid`; upload with `?crew_id=`.
- Not in QuickBooks yet (sub payments are money out: a future "bills/expenses" phase).

## 21. General Contractor add-on: GC Quote wizard (ContractorPOS v1.10)
- Switched on per business by the platform admin (Businesses list → **🏗 GC on/off**, `businesses.gc_enabled`). Off by default, so other contractors never see it.
- Job ticket header gets one **🏗 GC Quote** button. It opens a step-by-step screen, **one sub per screen**:
  - Trade (preset chips), subcontractor company, phone.
  - **Sub's bid (your cost)** and **Charge the customer**, with quick buttons (Bid + 10/15/20/25%, Same as bid). Shows the markup.
  - What's included (optional), **📄 Attach bid**, **📷 Add picture** (tagged to that sub).
  - ‹ Back · Close · **Review quote ✓** · **Next sub ›**. Numbered chips jump to any sub.
- **Review:** table of subs (bid, charge, markup, files) + "Your own work / overhead" amount and note → quote total → **Set as the quoted price** (`POST /api/jobs/:id/gc-quote`; quoted = sum of subs' `quote_cents` + `gc_own_cents`).
- Each sub is a normal crew (`billing='included'`, `amount_cents` = bid, new `job_crews.quote_cents` = customer charge), placed in the "In Progress" phase, so 💵 Sub payments and change orders work on it.
- Crew rows now wrap: buttons drop below the name when the middle column is narrow.

## 22. GC Quote on the board + detailed print behind a password (ContractorPOS v1.11)
- **🏗 GC Quote** button on the job board's top bar (GC add-on only): **+ Start a new job** (job form → "Next: add subs ›" → wizard) or pick a job in the first column to continue its GC quote.
- **🖨 Print** on a GC job with sub charges asks: **Customer copy: quoted price only** (default) or **🔒 Detailed: each trade's price**. Detailed needs the user's password (`POST /api/jobs/:id/detail-print`, 5 wrong tries → 15-minute lockout, logged in history). Lines: each sub's charge (trade + what's included), own work, and "Other / adjustment" if the quoted price was changed by hand. The detailed page is wiped from the screen after printing.
- The customer link (Send) still shows the quoted price only. Bids and markup are never printed or sent.

## 23. Bid Builder replaces the GC Quote wizard (ContractorPOS v1.12)
- **🏗 Bid Builder** (board top bar, and the ticket header) opens one screen styled after the user's mock-up (parchment, green header):
  - Toolbar: **New Bid** (new job → builder), **Open** (search open jobs), **Save**, **Print / PDF** (same total-only / 🔒 detailed choice), ✕.
  - Project and Date (job name and created date).
  - Table: #, Subcontractor / Scope, Subcontractor Amount, Your % Markup, Your Markup, Total (With Markup), ✎ and 🗑. Click the # to select rows; **＋ Add Contractor / Scope**, **Duplicate**, **Remove Selected**. Enter moves down / adds a line.
  - **Markup Settings:** individual % per line, or one overall %.
  - Totals: Subcontractor Total, Total Markup, **Project Total (Your Price)**; shows the current quoted price when it differs / not saved.
  - ✎ opens company, phone, what's included (shown on the detailed print), **Attach bid** PDF / **Add picture**, and **💵 Payments & change orders**.
- Saving: `POST /api/jobs/:id/bid` saves all lines at once (new/changed/removed crews, `billing='included'`), stores `job_crews.gc_markup_pct`, `jobs.gc_markup_each / gc_markup_all`, and sets the quoted price to the total. Lines with sub payments can't be removed.
- Leaving with unsaved changes asks first. The old one-sub-per-screen wizard is gone.

## 24. Bid Builder: attach on each line + Send / Print (ContractorPOS v1.13)
- Each bid line has **📎**: attach the sub's bid, an invoice, a blueprint or pictures (PDF or image, several at once). A new or changed line is saved first. Attached files show as chips under the line (picture thumbnail or 📄 + name) and open in a new tab, so they're there when the bid is reopened later. Stored as job files with `crew_id`.
- Toolbar **📤 Send / Print** (replaces Print / PDF) saves first, then opens the job's Send window: **WhatsApp, Text, Email, Print**. Print gives the same total-only / 🔒 detailed choice. The Send window on the job ticket now also has Print.

## 25. Ranch look as a theme setting (ContractorPOS v1.14)
- Settings → **Look of the program**: **Ranch** (parchment & green, the Bid Builder look) or **Dark**. Stored in `businesses.theme`; businesses that existed before v1.14 stay Dark (NULL) until switched, new businesses start on Ranch.
- `app.js applyBrand()` sets `<html data-theme>` (remembered in localStorage to avoid a flash). Ranch styles only apply to the three main screens (`<body class="cp">`: job board, checkout, Manage); invoices, statements, receipts and customer pages stay plain white.
- `style.css`: Ranch variables + `:where(...)` rules (low specificity so screen-specific button colors still win). `jobs.html`: a `html[data-theme=ranch]` block re-colors the board, ticket, dialogs, crews and sub windows. Column colors set in Workflow setup are unchanged.

## 26. New Dark look (ContractorPOS v1.15)
- **Dark** now matches the Lokaal menu style: charcoal (#121418 / panels #1d2027), lime green highlights (#7cc04a), gold section headings and table headers (#d9a93a). Navy is gone.
- Dark now covers checkout and Manage too (they were white before). Screen only (`@media screen`), so printed reports and receipts stay black on white.
- Two complete looks: **Dark** (default for businesses with no choice saved) and **Ranch**. Bid Builder keeps its parchment look in both.

## 27. Burgundy in the Ranch look (ContractorPOS v1.16)
- Ranch now uses the website's brick red/burgundy (`--burg: #7f3b33`, money-owed `#8b2e24`) alongside green and tan: section headings and page titles, the selected top-bar tab (burgundy pill, like the region button on Lokaal), balance owed / "Owe", High-priority flags, moved-back tags, delete (×/🗑) and error colors. Green stays for main buttons and table headers.
- Bid Builder (both themes): "Bid Builder" title and the barn/windmill footer in burgundy.

## 28. Security: support access codes + account recovery (ContractorPOS v1.17)
Same rules, numbers and wording as MultiPOS v1.15 (SECURITY-HANDOVER.md). Code is in **`security.js`** (new), wired from `server.js`.
- **Support access:** the admin's **🔒 Open** needs a one-time 6-digit code from the owner: **✉️ Email a code** (owner's email, backup, or both; max 5/hour), or the owner's **Settings → 🔒 Support access → Make a code for support**. Codes: SHA-256 only, once, 15 minutes, dead after 5 wrong tries. Access lasts 4 hours (`sessions.acting_until`, checked in `loadUser`); the banner shows "until 12:12 PM". Setup days: first 3 days after a business is created, no code needed (logged).
- **No back doors:** inside a business, support can't add logins, change passwords, or change/turn off an owner (`sec.noBackdoor` in `/api/users` POST/PUT), except during setup days (logged). Support can't make owner codes or see/erase anything else.
- **Log:** `support_access_log` → owner's **Who opened your account** (code emailed / owner made a code / opened with emailed code / owner's code / setup days / wrong code / left / password or backup email changed).
- **Account recovery:** `users.backup_email` (required for owners and admins; yellow "Add a backup email… Add it now" bar on every screen until added). Settings → **My login & backup email** (backup, new password, current password). **Forgot password?** on sign-in → `/api/password/forgot` (same answer for unknown emails, 5/hour per IP and email) emails a 30-minute one-time `/reset#token` link to the login and backup emails; only the newest link works. `/reset` page: new password ×2 + backup email (required for owners); saving signs out every device. Any password/backup change emails "Your login was changed" to the login, old and new backup emails.
- Tables: `support_codes`, `support_access_log`, `password_resets`; columns `sessions.acting_until`, `users.backup_email`. Needs `RESEND_API_KEY` for emailed codes/links (owner-made codes work without it).

## 29. Bid Builder: Add from Products (ContractorPOS v1.18)
- **📦 Add from Products** next to "+ Add Contractor / Scope": search the products list (rentals left out), click to add, click again for one more; ✓ shows how many are in the bid.
- Product lines show "📦 name · Qty [ ] × $price"; amount = qty × price (price saved when added). Markup starts at **0%** because the product price is already the selling price; change it per line, or the overall % applies.
- Stored in `job_bid_items` (not crews), saved by the same `POST /api/jobs/:id/bid` (`kind:'product'`, `removed_items`). Totals show Subcontractor Total and Products / Materials separately; the quoted price includes both. Detailed print lists them as "name (qty)".
- Products in a bid don't change stock; that happens when items are put on the job ticket or sold.

## 30. Top-left button set by the platform admin (ContractorPOS v1.19)
- The platform admin's **Settings → Top-left button (all accounts)** (only when not inside a business): picture address, link, words, live preview, Save / Remove. Stored in the new `platform_settings` table (`top_image_url`, `top_link_url`, `top_label`); `GET/PUT /api/admin/top-button` (admin only); links must start with https://.
- `/api/me` returns `top_button`; `app.js topButton(me)` puts it at the start of the top-left brand on the job board, checkout and Manage, opening the link in a new tab. Without a picture it shows the words as a button.
- Owners can't change it. Their "Logo image URL" setting is now "Logo on receipts & invoices" and no longer shows in the top-left.

## 31. Customer page buttons always shown (ContractorPOS v1.20)
- Manage → Customers → a customer: **Take payment**, **Print statement**, **Edit** always show at the top right. If the customer has no charge account, Take payment / Print statement ask "Turn it on now?" (owners and managers) and then carry on; cashiers are told to ask an owner/manager.
- Manage top menu: links no longer break onto two lines ("Refunds owed") or overlap (`#nav` is a wrapping flex row, links `nowrap`).
