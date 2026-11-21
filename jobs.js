// Jobs add-on: the contractor job board.
// A job is a card on the board. Its columns (phases) and card buttons are set by each company.
// Opening a card shows the job ticket: quoted price, everything added along the way
// (inventory items, extra charges, equipment rental), payments over time, a final discount, and the balance.
const crypto = require('crypto');

const BLUE = '#3b82f6', GOLD = '#e0a526', GREEN = '#22c55e', GRAY = '#94a3b8';
const DEFAULT_COLUMNS = [
  { name: 'Quoting', color: '#2f4fd8', buttons: [['Quoting', BLUE], ['Submitted', GOLD], ['On Hold', GRAY, 'bottom']] },
  { name: 'Scheduled', color: '#2e8b3e', buttons: [['Ready', GREEN], ['Reschedule', GRAY]] },
  { name: 'In Progress', color: '#c9921a', buttons: [['Working', BLUE]] },
  { name: 'Completed', color: '#7a3cc4', buttons: [['Final Check', BLUE], ['Punch List', GOLD], ['Approve', GREEN]] },
  { name: 'Payment', color: '#1f7f9e', buttons: [['Invoice', BLUE], ['Paid', GREEN]] },
  { name: 'Closed', color: '#4b5a6a', buttons: [['Closed', GRAY]] },
];
const METHODS = ['cash', 'card', 'check', 'other'];
const METHOD_NAMES = { cash: 'Cash', card: 'Card', check: 'Check', other: 'Other' };
const PERIODS = { half_day: 'Half day', day: 'Day', week: 'Week', month: 'Month' };
const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

module.exports = function setupJobs(app, deps) {
  const { pool, wrap, fail, text, cents, requireLogin, requireBusiness, requireRole, barcodeVariants, publicOrigin, token, feats } = deps;
  const biz = [requireLogin, requireBusiness];
  const isManager = (u) => ['admin', 'owner', 'manager'].includes(u.role);
  const needManager = (u) => { if (!isManager(u)) fail(403, 'Only an owner or manager can do this'); };

  const jobsOn = wrap(async (req, res, next) => {
    const b = await pool.query('SELECT jobs_enabled FROM businesses WHERE id=$1', [req.user.business_id]);
    if (!b.rows[0] || !b.rows[0].jobs_enabled) fail(403, 'The job board is not turned on for this business');
    next();
  });
  const J = [...biz, jobsOn];

  // ---------- live updates: every open board in a business hears about changes ----------
  const listeners = new Map(); // businessId -> Set(res)
  function notify(businessId, payload) {
    const set = listeners.get(businessId);
    if (!set) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const r of set) r.write(data);
  }
  app.get('/api/jobs/events', ...J, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('data: {"type":"hello"}\n\n');
    const id = req.user.business_id;
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); listeners.get(id)?.delete(res); });
  });

  // ---------- helpers ----------
  const cleanButtons = (list) => (Array.isArray(list) ? list : []).slice(0, 3).map((b) => ({
    label: text(b && b.label, 'Button name', { required: false, max: 24 }) || 'Button',
    enabled: !!(b && b.enabled),
    action: b && b.action === 'next' ? 'next' : 'mark',
    color: /^#[0-9a-fA-F]{6}$/.test((b && b.color) || '') ? b.color : BLUE,
    // Where a card with this status sits in the column: top, middle (default) or bottom.
    place: ['top', 'bottom'].includes(b && b.place) ? b.place : 'middle',
  }));
  const cleanColor = (c, fallback) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : fallback);

  async function columns(db, businessId) {
    const sql = 'SELECT * FROM job_columns WHERE business_id=$1 ORDER BY position, id';
    let r = await db.query(sql, [businessId]);
    if (!r.rows.length) {
      // First time: set up the standard six phases (in its own transaction, locked so two screens can't both do it).
      // The company can change them in Workflow setup.
      await withTx(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock(4242, $1)', [businessId]);
        if ((await t.query(sql, [businessId])).rows.length) return;
        for (const [i, c] of DEFAULT_COLUMNS.entries()) {
          await t.query('INSERT INTO job_columns (business_id, name, color, position, buttons) VALUES ($1,$2,$3,$4,$5)',
            [businessId, c.name, c.color, i + 1,
              JSON.stringify(c.buttons.map(([label, color, place]) => ({ label, enabled: true, action: 'mark', color, place: place || 'middle' })))]);
        }
      });
      r = await db.query(sql, [businessId]);
    }
    return r.rows;
  }
  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  const log = (db, jobId, user, action) => db.query(
    'INSERT INTO job_history (job_id, user_id, user_name, action) VALUES ($1,$2,$3,$4)', [jobId, user.id, user.name, action]);

  // Quote + everything added + tax − discount = total; total − payments = balance.
  function totals(job, extras, taxable, paid) {
    const rate = job.tax_exempt ? 0 : Number(job.tax_rate);
    const tax = Math.round((taxable * rate) / 100 + 1e-9);
    const subtotal = job.quoted_cents + extras;
    const total = subtotal + tax - job.discount_cents;
    return { quoted_cents: job.quoted_cents, extras_cents: extras, taxable_cents: taxable, tax_rate: rate, tax_cents: tax,
      subtotal_cents: subtotal, discount_cents: job.discount_cents, total_cents: total, paid_cents: paid, balance_cents: total - paid };
  }
  const JOB_SUMS = `
    COALESCE((SELECT sum(i.qty * i.unit_cents) FROM job_items i WHERE i.job_id = j.id), 0)::bigint AS extras,
    COALESCE((SELECT sum(i.qty * i.unit_cents) FROM job_items i WHERE i.job_id = j.id AND i.taxable), 0)::bigint AS taxable_sum,
    COALESCE((SELECT sum(p.amount_cents) FROM job_payments p WHERE p.job_id = j.id AND NOT p.voided), 0)::bigint AS paid`;
  const withTotals = (j) => {
    const t = totals(j, Number(j.extras), Number(j.taxable_sum), Number(j.paid));
    delete j.extras; delete j.taxable_sum; delete j.paid;
    return { ...j, ...t };
  };
  // Loads one job (locked for update when inside a transaction) with its totals and column place.
  async function loadJob(db, id, businessId, lock = false) {
    const r = await db.query(`SELECT j.* FROM jobs j WHERE j.id=$1 AND j.business_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, businessId]);
    if (!r.rows[0]) fail(404, 'Job not found');
    const s = await db.query(`SELECT ${JOB_SUMS} FROM jobs j WHERE j.id=$1`, [id]);
    const job = withTotals({ ...r.rows[0], ...s.rows[0] });
    const cols = await columns(db, businessId);
    const idx = cols.findIndex((c) => c.id === job.column_id);
    job.column_index = idx;
    job.is_closed = idx === cols.length - 1;
    return { job, cols };
  }
  const notClosed = (job) => { if (job.is_closed) fail(400, 'This job is closed. Move it back out of the last column to change it.'); };

  // ---------- board ----------
  app.get('/api/jobs/board', ...J, wrap(async (req, res) => {
    const cols = await columns(pool, req.user.business_id);
    const last = cols[cols.length - 1];
    // Closed jobs drop off the board after 60 days unless asked for.
    const params = [req.user.business_id];
    let where = 'j.business_id = $1';
    if (req.query.closed !== 'all' && last) {
      params.push(last.id);
      where += ` AND NOT (j.column_id = $2 AND j.column_entered_at < now() - interval '60 days')`;
    }
    const { rows } = await pool.query(
      `SELECT j.id, j.job_number, j.name, j.description, j.customer_name, j.customer_phone, j.job_address, j.column_id,
              j.status_label, j.priority, j.crew, j.start_date, j.progress, j.quoted_cents, j.tax_rate, j.tax_exempt,
              j.discount_cents, j.column_entered_at, j.closed_at, j.updated_at, j.back_reason, j.back_at, j.back_by, ${JOB_SUMS},
              (SELECT count(*) FROM job_files f WHERE f.job_id = j.id)::int AS file_count,
              (SELECT string_agg(c.trade || COALESCE(' · ' || c.name, ''), ', ' ORDER BY c.id) FROM job_crews c
                WHERE c.job_id = j.id AND c.column_id = j.column_id AND NOT c.done) AS crews_now
         FROM jobs j WHERE ${where} ORDER BY (j.priority = 'high') DESC, j.column_entered_at, j.id`, params);
    // A job whose column was removed goes back to the first column.
    const ids = new Set(cols.map((c) => c.id));
    const jobs = rows.map(withTotals).map((j) => (ids.has(j.column_id) ? j : { ...j, column_id: cols[0].id }));
    res.json({ columns: cols, jobs });
  }));

  // ---------- workflow setup (columns and their buttons) ----------
  app.put('/api/job-columns/:id', ...J, feats.needs('workflow'), wrap(async (req, res) => {
    needManager(req.user);
    const c = await pool.query('SELECT * FROM job_columns WHERE id=$1 AND business_id=$2', [req.params.id, req.user.business_id]);
    if (!c.rows[0]) fail(404, 'Column not found');
    // Optional colors: a #rrggbb value, or empty to use the standard look.
    const opt = (k) => (k in req.body ? (/^#[0-9a-fA-F]{6}$/.test(req.body[k] || '') ? req.body[k] : null) : c.rows[0][k]);
    await pool.query('UPDATE job_columns SET name=$1, color=$2, buttons=$3, text_color=$4, bg_color=$5, card_color=$6, card_text_color=$7 WHERE id=$8',
      [text(req.body.name, 'Column name', { max: 40 }), cleanColor(req.body.color, c.rows[0].color),
        JSON.stringify(cleanButtons(req.body.buttons)), opt('text_color'), opt('bg_color'), opt('card_color'), opt('card_text_color'), c.rows[0].id]);
    notify(req.user.business_id, { type: 'columns' });
    res.json({ ok: true });
  }));
  app.post('/api/job-columns', ...J, feats.needs('workflow'), wrap(async (req, res) => {
    needManager(req.user);
    const id = await withTx(async (db) => {
      const cols = await columns(db, req.user.business_id);
      if (cols.length >= 12) fail(400, '12 columns is the most a board can have');
      // New columns go just before the last (closing) column unless a place is given.
      let at = cols.length - 1;
      if (req.body.after_id) {
        const i = cols.findIndex((c) => c.id === Number(req.body.after_id));
        if (i >= 0) at = Math.min(i + 1, cols.length - 1);
      }
      const order = cols.map((c) => c.id);
      const r = await db.query('INSERT INTO job_columns (business_id, name, color, position, buttons) VALUES ($1,$2,$3,0,$4) RETURNING id',
        [req.user.business_id, text(req.body.name, 'Column name', { max: 40 }), cleanColor(req.body.color, '#2563c9'),
          JSON.stringify(cleanButtons(req.body.buttons))]);
      order.splice(at, 0, r.rows[0].id);
      for (const [i, cid] of order.entries()) await db.query('UPDATE job_columns SET position=$1 WHERE id=$2', [i + 1, cid]);
      return r.rows[0].id;
    });
    notify(req.user.business_id, { type: 'columns' });
    res.json({ id });
  }));
  app.post('/api/job-columns/:id/move', ...J, feats.needs('workflow'), wrap(async (req, res) => {
    needManager(req.user);
    await withTx(async (db) => {
      const cols = await columns(db, req.user.business_id);
      const i = cols.findIndex((c) => c.id === Number(req.params.id));
      if (i < 0) fail(404, 'Column not found');
      const j = i + (Number(req.body.direction) < 0 ? -1 : 1);
      if (j < 0 || j >= cols.length) return;
      if (i === cols.length - 1 || j === cols.length - 1) fail(400, 'The last column is where finished jobs close; it stays last');
      [cols[i], cols[j]] = [cols[j], cols[i]];
      for (const [k, c] of cols.entries()) await db.query('UPDATE job_columns SET position=$1 WHERE id=$2', [k + 1, c.id]);
    });
    notify(req.user.business_id, { type: 'columns' });
    res.json({ ok: true });
  }));
  app.delete('/api/job-columns/:id', ...J, feats.needs('workflow'), wrap(async (req, res) => {
    needManager(req.user);
    await withTx(async (db) => {
      const cols = await columns(db, req.user.business_id);
      const i = cols.findIndex((c) => c.id === Number(req.params.id));
      if (i < 0) fail(404, 'Column not found');
      if (cols.length <= 2) fail(400, 'A board needs at least two columns');
      if (i === cols.length - 1) fail(400, 'The last column is where finished jobs close; it cannot be removed');
      const n = await db.query('SELECT count(*)::int AS n FROM jobs WHERE column_id=$1', [cols[i].id]);
      if (n.rows[0].n) fail(400, `Move the ${n.rows[0].n} job(s) out of "${cols[i].name}" first`);
      await db.query('DELETE FROM job_columns WHERE id=$1', [cols[i].id]);
    });
    notify(req.user.business_id, { type: 'columns' });
    res.json({ ok: true });
  }));

  // ---------- jobs ----------
  async function jobFields(db, req, current) {
    const b = req.body;
    const f = {
      name: text(b.name, 'Job name', { max: 120 }),
      description: text(b.description, 'Description', { required: false, max: 1000 }) || null,
      customer_name: text(b.customer_name, 'Customer name', { required: false, max: 120 }) || null,
      customer_phone: text(b.customer_phone, 'Customer phone', { required: false, max: 40 }) || null,
      job_address: text(b.job_address, 'Job site address', { required: false, max: 300 }) || null,
      po_number: text(b.po_number, 'PO #', { required: false, max: 60 }) || null,
      crew: text(b.crew, 'Crew', { required: false, max: 60 }) || null,
      priority: b.priority === 'high' ? 'high' : 'normal',
      progress: Math.max(0, Math.min(100, parseInt(b.progress, 10) || 0)),
      start_date: /^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') ? b.start_date : null,
      quoted_cents: b.quoted_cents == null || b.quoted_cents === '' ? 0 : cents(b.quoted_cents, 'Quoted price'),
      tax_exempt: !!b.tax_exempt,
      customer_id: null,
    };
    if (b.customer_id) {
      const c = await db.query('SELECT id, name, phone FROM customers WHERE id=$1 AND business_id=$2', [b.customer_id, req.user.business_id]);
      if (!c.rows[0]) fail(404, 'Customer not found');
      f.customer_id = c.rows[0].id;
      f.customer_name = f.customer_name || c.rows[0].name;
      f.customer_phone = f.customer_phone || c.rows[0].phone;
    }
    // Location decides the sales tax rate on taxable items.
    const locId = b.location_id || (current && current.location_id);
    const l = await db.query(
      `SELECT id, tax_rate FROM locations WHERE business_id=$1 AND ($2::int IS NULL OR id=$2) ORDER BY (id=$2) DESC NULLS LAST, id LIMIT 1`,
      [req.user.business_id, locId ? Number(locId) : null]);
    f.location_id = l.rows[0] ? l.rows[0].id : null;
    f.tax_rate = l.rows[0] ? l.rows[0].tax_rate : 0;
    return f;
  }

  app.post('/api/jobs', ...J, wrap(async (req, res) => {
    const out = await withTx(async (db) => {
      const f = await jobFields(db, req);
      const cols = await columns(db, req.user.business_id);
      await db.query('SELECT pg_advisory_xact_lock(4243, $1)', [req.user.business_id]);
      const n = await db.query('SELECT COALESCE(max(job_number), 1000) + 1 AS n FROM jobs WHERE business_id=$1', [req.user.business_id]);
      const r = await db.query(
        `INSERT INTO jobs (business_id, location_id, job_number, name, description, customer_id, customer_name, customer_phone,
           job_address, po_number, column_id, priority, crew, start_date, progress, quoted_cents, tax_rate, tax_exempt, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, job_number`,
        [req.user.business_id, f.location_id, n.rows[0].n, f.name, f.description, f.customer_id, f.customer_name, f.customer_phone,
          f.job_address, f.po_number, cols[0].id, f.priority, f.crew, f.start_date, f.progress, f.quoted_cents, f.tax_rate,
          f.tax_exempt, req.user.id]);
      await log(db, r.rows[0].id, req.user, `Job created in ${cols[0].name}` + (f.quoted_cents ? ` · quoted ${usd(f.quoted_cents)}` : ''));
      return r.rows[0];
    });
    notify(req.user.business_id, { type: 'job', id: out.id });
    res.json(out);
  }));

  app.get('/api/jobs/:id', ...J, wrap(async (req, res) => {
    const { job, cols } = await loadJob(pool, req.params.id, req.user.business_id);
    const items = await pool.query('SELECT * FROM job_items WHERE job_id=$1 ORDER BY id', [job.id]);
    const payments = await pool.query(
      `SELECT p.*, u.name AS taken_by FROM job_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.job_id=$1 ORDER BY p.id`, [job.id]);
    const history = await pool.query('SELECT * FROM job_history WHERE job_id=$1 ORDER BY id DESC LIMIT 300', [job.id]);
    const loc = await pool.query('SELECT name, address, phone FROM locations WHERE id=$1', [job.location_id]);
    const crews = await pool.query(
      `SELECT c.*, k.name AS column_name, k.position AS column_position,
              COALESCE((SELECT sum(amount_cents) FROM job_crew_changes x WHERE x.crew_id = c.id), 0)::int AS co_cents,
              (SELECT count(*) FROM job_crew_changes x WHERE x.crew_id = c.id)::int AS co_count,
              COALESCE((SELECT sum(amount_cents) FROM job_crew_payments p WHERE p.crew_id = c.id AND NOT p.voided), 0)::int AS sub_paid_cents,
              (SELECT count(*) FROM job_files f WHERE f.crew_id = c.id)::int AS file_count
         FROM job_crews c LEFT JOIN job_columns k ON k.id = c.column_id
        WHERE c.job_id=$1 ORDER BY k.position NULLS LAST, c.id`, [job.id]);
    const subPays = await pool.query(
      `SELECT p.*, u.name AS taken_by FROM job_crew_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.job_id=$1 ORDER BY p.paid_on, p.id`, [job.id]);
    const crewMats = await pool.query('SELECT id, crew_id, product_id, name, qty, unit, note FROM job_crew_materials WHERE job_id=$1 ORDER BY crew_id, position, id', [job.id]);
    const subChanges = await pool.query(
      `SELECT x.*, u.name AS taken_by FROM job_crew_changes x LEFT JOIN users u ON u.id = x.created_by WHERE x.job_id=$1 ORDER BY x.id`, [job.id]);
    for (const c of crews.rows) {
      c.contract_cents = c.amount_cents + c.co_cents;
      c.sub_owed_cents = c.contract_cents - c.sub_paid_cents;
      c.payments = subPays.rows.filter((p) => p.crew_id === c.id);
      c.changes = subChanges.rows.filter((x) => x.crew_id === c.id);
      c.parts = crewMats.rows.filter((x) => x.crew_id === c.id).map((x) => ({ ...x, qty: Number(x.qty) }));
    }
    res.json({ ...job, column: cols[job.column_index] || null, columns_count: cols.length, columns: cols.map((c) => ({ id: c.id, name: c.name, color: c.color })),
      location: loc.rows[0] || null, items: items.rows, payments: payments.rows, history: history.rows, crews: crews.rows,
      bid_items: (await pool.query('SELECT * FROM job_bid_items WHERE job_id=$1 ORDER BY id', [job.id])).rows });
  }));

  app.put('/api/jobs/:id', ...J, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      const f = await jobFields(db, req, job);
      if (job.is_closed && f.quoted_cents !== job.quoted_cents) fail(400, 'This job is closed; the quoted price can no longer change');
      if (f.quoted_cents !== job.quoted_cents && job.paid_cents > 0 && !isManager(req.user)) {
        fail(403, 'Payments have been taken on this job; only an owner or manager can change the quoted price');
      }
      await db.query(
        `UPDATE jobs SET name=$1, description=$2, customer_id=$3, customer_name=$4, customer_phone=$5, job_address=$6, po_number=$7,
           priority=$8, crew=$9, start_date=$10, progress=$11, quoted_cents=$12, location_id=$13, tax_rate=$14, tax_exempt=$15,
           updated_at=now() WHERE id=$16`,
        [f.name, f.description, f.customer_id, f.customer_name, f.customer_phone, f.job_address, f.po_number, f.priority, f.crew,
          f.start_date, f.progress, f.quoted_cents, f.location_id, f.tax_rate, f.tax_exempt, job.id]);
      const changes = [];
      if (f.quoted_cents !== job.quoted_cents) changes.push(`quoted price ${usd(job.quoted_cents)} → ${usd(f.quoted_cents)}`);
      if (f.progress !== job.progress) changes.push(`progress ${f.progress}%`);
      if ((f.crew || '') !== (job.crew || '')) changes.push(`crew ${f.crew || 'none'}`);
      if (f.tax_exempt !== job.tax_exempt) changes.push(f.tax_exempt ? 'marked tax exempt' : 'tax exempt removed');
      if (f.priority !== job.priority) changes.push(`priority ${f.priority}`);
      await log(db, job.id, req.user, changes.length ? `Details changed: ${changes.join(', ')}` : 'Details updated');
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  app.delete('/api/jobs/:id', ...J, wrap(async (req, res) => {
    needManager(req.user);
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      const p = await db.query('SELECT count(*)::int AS n FROM job_payments WHERE job_id=$1', [job.id]);
      if (p.rows[0].n) fail(400, 'This job has payments recorded, so it cannot be deleted. Move it to the last column instead.');
      // Put inventory back.
      const items = await db.query('SELECT * FROM job_items WHERE job_id=$1 AND stock_taken', [job.id]);
      for (const it of items.rows) await db.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id=$2 AND track_stock', [it.qty, it.product_id]);
      await db.query('DELETE FROM jobs WHERE id=$1', [job.id]);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id), deleted: true });
    res.json({ ok: true });
  }));

  // Moves a job one column left or right. Jobs can't skip columns.
  async function moveJob(db, job, cols, direction, user, reason) {
    const from = job.column_index < 0 ? 0 : job.column_index;
    const to = from + (direction < 0 ? -1 : 1);
    if (to < 0 || to >= cols.length) fail(400, direction < 0 ? 'This job is already in the first column' : 'This job is already in the last column');
    const last = cols.length - 1;
    if (direction < 0 && !isManager(user)) fail(403, 'Only an owner or manager can move a job back');
    const why = direction < 0 ? text(reason, 'Reason for moving back', { required: false, max: 500 }) : null;
    if (direction < 0 && (!why || why.length < 3)) fail(400, 'Write a note explaining why this job is moving back');
    if (to === last) {
      if (job.balance_cents > 0) fail(400, `${usd(job.balance_cents)} is still owed on this job. Take the payment or finish with a discount first.`);
      if (job.balance_cents < 0) fail(400, `The customer has paid ${usd(-job.balance_cents)} more than the total. Void a payment or lower the discount first.`);
    }
    await db.query(
      `UPDATE jobs SET column_id=$1, status_label=NULL, column_entered_at=now(), updated_at=now(),
         closed_at = CASE WHEN $2 THEN now() ELSE NULL END, back_reason=$4, back_at=CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
       back_by=$5 WHERE id=$3`, [cols[to].id, to === last, job.id, why, why ? user.name : null]);
    await log(db, job.id, user, `Moved ${direction < 0 ? 'back ' : ''}from ${cols[from].name} to ${cols[to].name}` + (to === last ? ' (job closed)' : '')
      + (why ? ` · Reason: ${why}` : ''));
  }
  app.post('/api/jobs/:id/move', ...J, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { job, cols } = await loadJob(db, req.params.id, req.user.business_id, true);
      let direction = Number(req.body.direction);
      // Dragging to a column: only the next or previous column is allowed.
      if (req.body.column_id) {
        const target = cols.findIndex((c) => c.id === Number(req.body.column_id));
        if (target < 0) fail(404, 'Column not found');
        const diff = target - Math.max(0, job.column_index);
        if (diff === 0) return;
        if (Math.abs(diff) > 1) fail(400, `Jobs move one column at a time. Next for this job is "${cols[Math.max(0, job.column_index) + Math.sign(diff)].name}".`);
        direction = diff;
      }
      if (direction !== 1 && direction !== -1) fail(400, 'Choose which way to move the job');
      await moveJob(db, job, cols, direction, req.user, req.body.reason);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // A card button: marks the job with that status, and (if set up that way) moves it to the next column.
  app.post('/api/jobs/:id/button', ...J, wrap(async (req, res) => {
    let moved = false;
    await withTx(async (db) => {
      const { job, cols } = await loadJob(db, req.params.id, req.user.business_id, true);
      const col = cols[Math.max(0, job.column_index)];
      const btn = (col.buttons || [])[Number(req.body.index)];
      if (!btn || !btn.enabled) fail(400, 'That button is not turned on for this column');
      await db.query('UPDATE jobs SET status_label=$1, updated_at=now() WHERE id=$2', [btn.label, job.id]);
      await log(db, job.id, req.user, `${btn.label} (in ${col.name})`);
      if (btn.action === 'next' && job.column_index < cols.length - 1) {
        await moveJob(db, job, cols, 1, req.user);
        moved = true;
      }
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true, moved });
  }));

  // ---------- job ticket: items, charges, equipment rental ----------
  app.post('/api/jobs/:id/items', ...J, wrap(async (req, res) => {
    const b = req.body;
    const out = await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const qty = Math.max(1, Math.min(9999, parseInt(b.qty, 10) || 1));
      const kind = ['item', 'charge', 'rental'].includes(b.kind) ? b.kind : (b.code ? 'item' : fail(400, 'Choose what to add'));
      if (kind === 'charge') {
        const name = text(b.name, 'Description', { max: 120 });
        const unit = cents(b.unit_cents, 'Amount');
        if (unit <= 0) fail(400, 'Enter the amount');
        const r = await db.query(
          `INSERT INTO job_items (job_id, kind, name, qty, unit_cents, taxable, created_by) VALUES ($1,'charge',$2,$3,$4,$5,$6) RETURNING *`,
          [job.id, name, qty, unit, !!b.taxable, req.user.id]);
        await log(db, job.id, req.user, `Added charge: ${name}${qty > 1 ? ` × ${qty}` : ''} ${usd(unit * qty)}`);
        return { item: r.rows[0] };
      }
      // Inventory item (by product, or by scanning/typing its barcode) or a rental product.
      let p;
      if (b.code) {
        const r = await db.query(
          `SELECT * FROM products WHERE business_id=$1 AND active AND barcode = ANY($2) LIMIT 1`,
          [req.user.business_id, barcodeVariants(text(b.code, 'Code', { max: 100 }))]);
        if (!r.rows[0]) return { found: false };
        p = r.rows[0];
      } else {
        const r = await db.query('SELECT * FROM products WHERE id=$1 AND business_id=$2 AND active', [b.product_id, req.user.business_id]);
        p = r.rows[0] || fail(404, 'Product not found');
      }
      // A rental product scanned or picked as an item: the screen asks for the rental period instead.
      if (kind === 'item' && p.is_rental) return { found: true, rental: { id: p.id, name: p.name } };
      if (kind === 'rental') {
        if (!p.is_rental) fail(400, `${p.name} is not a rental item`);
        const period = PERIODS[b.period] ? b.period : fail(400, 'Choose a rental period');
        const count = period === 'half_day' ? 1 : Math.max(1, Math.min(365, parseInt(b.count, 10) || 1));
        const rate = p['rate_' + period];
        if (rate == null) fail(400, `${p.name} has no ${PERIODS[period].toLowerCase()} rate`);
        const label = period === 'half_day' ? 'half day' : `${count} ${period}${count === 1 ? '' : 's'}`;
        const name = `Equipment rental: ${p.name} · ${label}`;
        const r = await db.query(
          `INSERT INTO job_items (job_id, kind, product_id, barcode, name, qty, unit_cents, taxable, created_by)
           VALUES ($1,'rental',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [job.id, p.id, p.barcode, name, qty, rate * count, p.taxable, req.user.id]);
        await log(db, job.id, req.user, `Added ${name}${qty > 1 ? ` × ${qty}` : ''} ${usd(rate * count * qty)}`);
        return { item: r.rows[0] };
      }
      // Same product again: add to the quantity already on the job.
      const ex = await db.query(`SELECT * FROM job_items WHERE job_id=$1 AND kind='item' AND product_id=$2 AND unit_cents=$3 LIMIT 1`,
        [job.id, p.id, p.price_cents]);
      let item;
      if (ex.rows[0]) {
        item = (await db.query('UPDATE job_items SET qty = qty + $1, stock_taken = $2 WHERE id=$3 RETURNING *',
          [qty, p.track_stock || ex.rows[0].stock_taken, ex.rows[0].id])).rows[0];
      } else {
        item = (await db.query(
          `INSERT INTO job_items (job_id, kind, product_id, barcode, name, qty, unit_cents, taxable, stock_taken, created_by)
           VALUES ($1,'item',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [job.id, p.id, p.barcode, p.name, qty, p.price_cents, p.taxable, p.track_stock, req.user.id])).rows[0];
      }
      if (p.track_stock) await db.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id=$2', [qty, p.id]);
      await log(db, job.id, req.user, `Added ${p.name}${qty > 1 ? ` × ${qty}` : ''} ${usd(p.price_cents * qty)}`);
      return { found: true, item };
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json(out);
  }));

  app.put('/api/jobs/:id/items/:itemId', ...J, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const r = await db.query('SELECT * FROM job_items WHERE id=$1 AND job_id=$2', [req.params.itemId, job.id]);
      const it = r.rows[0] || fail(404, 'Line not found');
      if (it.crew_id) fail(400, 'This line comes from a crew. Change it under Crews.');
      const qty = Math.max(1, Math.min(9999, parseInt(req.body.qty, 10) || 1));
      if (qty === it.qty) return;
      await db.query('UPDATE job_items SET qty=$1 WHERE id=$2', [qty, it.id]);
      if (it.stock_taken && it.product_id) await db.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id=$2 AND track_stock', [qty - it.qty, it.product_id]);
      await log(db, job.id, req.user, `Changed ${it.name} quantity ${it.qty} → ${qty}`);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  app.delete('/api/jobs/:id/items/:itemId', ...J, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const chk = await db.query('SELECT crew_id FROM job_items WHERE id=$1 AND job_id=$2', [req.params.itemId, job.id]);
      if (chk.rows[0] && chk.rows[0].crew_id) fail(400, 'This line comes from a crew. Remove it or change it to "part of the quote" under Crews.');
      const r = await db.query('DELETE FROM job_items WHERE id=$1 AND job_id=$2 RETURNING *', [req.params.itemId, job.id]);
      const it = r.rows[0] || fail(404, 'Line not found');
      if (it.stock_taken && it.product_id) await db.query('UPDATE products SET stock_qty = stock_qty + $1 WHERE id=$2 AND track_stock', [it.qty, it.product_id]);
      await log(db, job.id, req.user, `Removed ${it.name}${it.qty > 1 ? ` × ${it.qty}` : ''} (${usd(it.qty * it.unit_cents)})`);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // ---------- payments (split pay; any number over the life of the job) ----------
  app.post('/api/jobs/:id/payments', ...J, wrap(async (req, res) => {
    const out = await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const list = Array.isArray(req.body.payments) ? req.body.payments : [];
      if (!list.length) fail(400, 'Add a payment');
      if (list.length > 10) fail(400, 'Too many payments at once (10 max)');
      const parts = list.map((p) => {
        const method = METHODS.includes(p.method) ? p.method : fail(400, 'Choose how they paid');
        const amount = cents(p.amount_cents, 'Payment amount');
        if (amount <= 0) fail(400, 'Each payment must be more than $0.00');
        let tendered = null, change = null;
        if (method === 'cash') {
          tendered = p.tendered_cents == null || p.tendered_cents === '' ? amount : cents(p.tendered_cents, 'Cash received');
          if (tendered < amount) fail(400, 'Cash received is less than the cash payment');
          change = tendered - amount;
        }
        const check = method === 'check' ? (text(p.check_number, 'Check number', { required: false, max: 40 }) || null) : null;
        return { method, amount, tendered, change, check };
      });
      const sum = parts.reduce((a, p) => a + p.amount, 0);
      if (sum > job.balance_cents) {
        fail(400, job.balance_cents <= 0 ? 'Nothing is owed on this job right now'
          : `That is ${usd(sum - job.balance_cents)} more than the ${usd(job.balance_cents)} owed`);
      }
      const note = text(req.body.note, 'Note', { required: false, max: 200 }) || null;
      const batch = crypto.randomBytes(6).toString('hex');
      for (const p of parts) {
        await db.query(
          `INSERT INTO job_payments (job_id, business_id, location_id, batch, method, amount_cents, tendered_cents, change_cents,
             check_number, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [job.id, req.user.business_id, job.location_id, batch, p.method, p.amount, p.tendered, p.change, p.check, note, req.user.id]);
      }
      const desc = parts.map((p) => `${METHOD_NAMES[p.method]}${p.check ? ' #' + p.check : ''} ${usd(p.amount)}`).join(' + ');
      await log(db, job.id, req.user, `Payment ${usd(sum)} (${desc}) · balance now ${usd(job.balance_cents - sum)}` + (note ? ` · ${note}` : ''));
      return { paid_cents: sum, balance_cents: job.balance_cents - sum, change_cents: parts.reduce((a, p) => a + (p.change || 0), 0) };
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json(out);
  }));

  app.post('/api/jobs/:id/payments/:pid/void', ...J, wrap(async (req, res) => {
    needManager(req.user);
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const r = await db.query(
        'UPDATE job_payments SET voided=TRUE WHERE id=$1 AND job_id=$2 AND NOT voided AND deposit_id IS NULL RETURNING *',
        [req.params.pid, job.id]);
      const p = r.rows[0] || fail(400, 'Payment not found, already voided, or already in a bank deposit');
      await log(db, job.id, req.user, `Voided payment ${METHOD_NAMES[p.method]} ${usd(p.amount_cents)}`);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // ---------- final discount (when the project came in smaller than quoted) ----------
  app.put('/api/jobs/:id/discount', ...J, wrap(async (req, res) => {
    needManager(req.user);
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const d = req.body.discount_cents == null || req.body.discount_cents === '' ? 0 : cents(req.body.discount_cents, 'Discount');
      const before = job.subtotal_cents + job.tax_cents;
      if (d > before) fail(400, `The discount can't be more than the job total of ${usd(before)}`);
      const note = text(req.body.note, 'Reason', { required: false, max: 200 }) || null;
      await db.query('UPDATE jobs SET discount_cents=$1, discount_note=$2, updated_at=now() WHERE id=$3', [d, note, job.id]);
      await log(db, job.id, req.user, d ? `Discount ${usd(d)}${note ? ` (${note})` : ''} · total now ${usd(before - d)}` : 'Discount removed');
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // ---------- crews on the job (per phase) ----------
  async function crewFields(db, req, cols, current) {
    const b = req.body;
    const f = {
      trade: text(b.trade, 'Trade', { max: 60 }),
      name: text(b.name, 'Name', { required: false, max: 100 }) || null,
      phone: text(b.phone, 'Phone', { required: false, max: 40 }) || null,
      amount_cents: b.amount_cents == null || b.amount_cents === '' ? 0 : cents(b.amount_cents, 'Amount'),
      billing: ['extra', 'costplus'].includes(b.billing) ? b.billing : 'included',
      note: text(b.note, 'Note', { required: false, max: 300 }) || null,
      quote_cents: b.quote_cents == null || b.quote_cents === '' ? (current ? current.quote_cents : 0) : cents(b.quote_cents, 'Charge to the customer'),
      done: 'done' in b ? !!b.done : !!(current && current.done),
      column_id: null,
    };
    const col = cols.find((c) => c.id === Number(b.column_id));
    f.column_id = col ? col.id : (current ? current.column_id : null);
    if (f.billing !== 'included' && (!current || current.billing !== f.billing)) await feats.check(req, 'crew_billing');
    if (f.billing === 'extra' && !f.amount_cents) fail(400, 'Enter the amount to charge for this crew');
    // Cost plus: cost + markup (percent or dollars) is what goes on the ticket.
    f.markup_type = null; f.markup_percent = null; f.markup_cents = null;
    if (f.billing === 'costplus') {
      if (!f.amount_cents) fail(400, "Enter the crew's cost");
      f.markup_type = b.markup_type === 'dollar' ? 'dollar' : 'percent';
      if (f.markup_type === 'percent') {
        const pct = Number(b.markup_percent);
        if (!(pct >= 0 && pct <= 1000)) fail(400, 'Markup percent is not valid');
        f.markup_percent = Math.round(pct * 1000) / 1000;
      } else {
        f.markup_cents = b.markup_cents == null || b.markup_cents === '' ? 0 : cents(b.markup_cents, 'Markup');
      }
    }
    f.charge_cents = f.billing === 'extra' ? f.amount_cents
      : f.billing === 'costplus' ? f.amount_cents + (f.markup_type === 'percent' ? Math.round((f.amount_cents * f.markup_percent) / 100 + 1e-9) : f.markup_cents)
      : 0;
    return f;
  }
  const markupText = (c) => (c.markup_type === 'dollar' ? usd(c.markup_cents || 0) : `${Number(c.markup_percent || 0)}%`);
  // Up-charge and cost-plus crews have one "charge" line on the ticket; a crew that's part of the quote has none.
  async function syncCrewLine(db, crew, userId) {
    const label = (`Crew: ${crew.trade}${crew.name ? ' — ' + crew.name : ''}` +
      (crew.billing === 'costplus' ? ` (cost ${usd(crew.amount_cents)} + ${markupText(crew)})` : '')).slice(0, 120);
    if (crew.billing !== 'included' && crew.charge_cents > 0) {
      const u = await db.query('UPDATE job_items SET name=$1, unit_cents=$2, qty=1 WHERE crew_id=$3 RETURNING id', [label, crew.charge_cents, crew.id]);
      if (!u.rowCount) {
        await db.query(`INSERT INTO job_items (job_id, kind, name, qty, unit_cents, taxable, crew_id, created_by) VALUES ($1,'charge',$2,1,$3,FALSE,$4,$5)`,
          [crew.job_id, label, crew.charge_cents, crew.id, userId]);
      }
    } else {
      await db.query('DELETE FROM job_items WHERE crew_id=$1', [crew.id]);
    }
  }
  const crewText = (c) => `${c.trade}${c.name ? ' (' + c.name + ')' : ''}` + (c.billing === 'costplus'
    ? ` cost plus: ${usd(c.amount_cents)} + ${markupText(c)} = ${usd(c.charge_cents)}`
    : (c.amount_cents ? ` ${usd(c.amount_cents)} ${c.billing === 'extra' ? 'up-charge' : 'part of quote'}` : ''));

  app.post('/api/jobs/:id/crews', ...J, wrap(async (req, res) => {
    const id = await withTx(async (db) => {
      const { job, cols } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const f = await crewFields(db, req, cols);
      if (!f.column_id) f.column_id = job.column_id;
      const n = await db.query('SELECT count(*)::int AS n FROM job_crews WHERE job_id=$1', [job.id]);
      if (n.rows[0].n >= 100) fail(400, 'This job already has 100 crews');
      const r = await db.query(
        `INSERT INTO job_crews (job_id, column_id, trade, name, phone, amount_cents, billing, note, markup_type, markup_percent, markup_cents, charge_cents, created_by, quote_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [job.id, f.column_id, f.trade, f.name, f.phone, f.amount_cents, f.billing, f.note, f.markup_type, f.markup_percent, f.markup_cents, f.charge_cents, req.user.id, f.quote_cents]);
      await syncCrewLine(db, r.rows[0], req.user.id);
      const col = cols.find((c) => c.id === f.column_id);
      await log(db, job.id, req.user, `Crew added${col ? ' to ' + col.name : ''}: ${crewText(r.rows[0])}`);
      return r.rows[0].id;
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ id });
  }));
  app.put('/api/jobs/:id/crews/:cid', ...J, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { job, cols } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const cur = (await db.query('SELECT * FROM job_crews WHERE id=$1 AND job_id=$2', [req.params.cid, job.id])).rows[0] || fail(404, 'Crew not found');
      const sent = Object.keys(req.body);
      // Only the fields sent change (e.g. just { done: true } from the Done button).
      req.body = { ...cur, ...req.body };
      const f = await crewFields(db, req, cols, cur);
      if (f.amount_cents !== cur.amount_cents) {
        const bal = await subBalance(db, cur);
        if (f.amount_cents + (bal.contract - cur.amount_cents) < bal.paid) fail(400, `${usd(bal.paid)} has already been paid to this crew, so the amount can't go below that`);
      }
      const r = await db.query(
        `UPDATE job_crews SET column_id=$1, trade=$2, name=$3, phone=$4, amount_cents=$5, billing=$6, note=$7, done=$8,
           markup_type=$9, markup_percent=$10, markup_cents=$11, charge_cents=$12, quote_cents=$14 WHERE id=$13 RETURNING *`,
        [f.column_id, f.trade, f.name, f.phone, f.amount_cents, f.billing, f.note, f.done, f.markup_type, f.markup_percent, f.markup_cents, f.charge_cents, cur.id, f.quote_cents]);
      await syncCrewLine(db, r.rows[0], req.user.id);
      const what = f.done !== cur.done && sent.length === 1 ? (f.done ? 'Crew finished' : 'Crew back on the job') : 'Crew changed';
      await log(db, job.id, req.user, `${what}: ${crewText(r.rows[0])}`);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));
  app.delete('/api/jobs/:id/crews/:cid', ...J, wrap(async (req, res) => {
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const paid = await db.query('SELECT count(*)::int AS n FROM job_crew_payments WHERE crew_id=$1 AND job_id=$2 AND NOT voided', [req.params.cid, job.id]);
      if (paid.rows[0].n) fail(400, 'This crew has payments recorded. Void them first, or mark the crew Done instead.');
      await db.query(`DELETE FROM job_items WHERE id IN (SELECT job_item_id FROM job_crew_changes WHERE crew_id=$1 AND job_id=$2)`, [req.params.cid, job.id]);
      const r = await db.query('DELETE FROM job_crews WHERE id=$1 AND job_id=$2 RETURNING *', [req.params.cid, job.id]);
      const c = r.rows[0] || fail(404, 'Crew not found');
      await log(db, job.id, req.user, `Crew removed: ${crewText(c)}${c.billing !== 'included' && c.charge_cents ? ' (its charge was taken off the ticket)' : ''}`);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // ---------- General Contractor quote: subs' charges + the GC's own amount become the quoted price ----------
  app.post('/api/jobs/:id/gc-quote', ...J, wrap(async (req, res) => {
    const b = (await pool.query('SELECT gc_enabled FROM businesses WHERE id=$1', [req.user.business_id])).rows[0];
    if (!b || !b.gc_enabled) fail(403, 'The General Contractor add-on is not turned on for this business');
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const own = req.body.own_cents == null || req.body.own_cents === '' ? 0 : cents(req.body.own_cents, 'Your own amount');
      const ownNote = text(req.body.own_note, 'Note', { required: false, max: 200 }) || null;
      const subs = await db.query('SELECT COALESCE(sum(quote_cents), 0)::int AS q FROM job_crews WHERE job_id=$1', [job.id]);
      const quoted = subs.rows[0].q + own;
      if (quoted !== job.quoted_cents && job.paid_cents > 0 && !isManager(req.user)) {
        fail(403, 'Payments have been taken on this job; only an owner or manager can change the quoted price');
      }
      await db.query('UPDATE jobs SET quoted_cents=$1, gc_own_cents=$2, gc_own_note=$3, updated_at=now() WHERE id=$4', [quoted, own, ownNote, job.id]);
      await log(db, job.id, req.user, `GC quote: subs ${usd(subs.rows[0].q)} + own ${usd(own)} = quoted price ${usd(quoted)}`
        + (quoted !== job.quoted_cents ? ` (was ${usd(job.quoted_cents)})` : ''));
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // Bid Builder: saves the whole bid at once. Each row is a sub (crew, part of the quote): amount = sub's price,
  // markup % (its own, or one overall %) gives the customer price; the quoted price becomes the sum of the rows.
  app.post('/api/jobs/:id/bid', ...J, wrap(async (req, res) => {
    const biz = (await pool.query('SELECT gc_enabled FROM businesses WHERE id=$1', [req.user.business_id])).rows[0];
    if (!biz || !biz.gc_enabled) fail(403, 'The General Contractor add-on is not turned on for this business');
    const b = req.body || {};
    const pct = (v, label) => { const n = Number(v ?? 0); if (!(n >= 0 && n <= 1000)) fail(400, `${label} is not valid`); return Math.round(n * 1000) / 1000; };
    const each = b.markup_each !== false;
    const all = pct(b.markup_all, 'Overall markup %');
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (rows.length > 100) fail(400, 'A bid can have up to 100 lines');
    const removed = (Array.isArray(b.removed) ? b.removed : []).map(Number).filter(Boolean);
    const removedItems = (Array.isArray(b.removed_items) ? b.removed_items : []).map(Number).filter(Boolean);
    const out = await withTx(async (db) => {
      const { job, cols } = await loadJob(db, req.params.id, req.user.business_id, true);
      notClosed(job);
      const phase = (cols.find((c) => /progress/i.test(c.name)) || cols[job.column_index] || cols[0]).id;
      for (const id of removed) {
        const c = (await db.query('SELECT * FROM job_crews WHERE id=$1 AND job_id=$2', [id, job.id])).rows[0];
        if (!c) continue;
        const paid = await db.query('SELECT count(*)::int AS n FROM job_crew_payments WHERE crew_id=$1 AND NOT voided', [id]);
        if (paid.rows[0].n) fail(400, `${c.trade} has payments recorded, so it can't be removed from the bid`);
        await db.query(`DELETE FROM job_items WHERE id IN (SELECT job_item_id FROM job_crew_changes WHERE crew_id=$1)`, [id]);
        await db.query('DELETE FROM job_crews WHERE id=$1', [id]);
        await log(db, job.id, req.user, `Bid: removed ${c.trade}${c.name ? ' (' + c.name + ')' : ''}`);
      }
      for (const id of removedItems) {
        const x = (await db.query('DELETE FROM job_bid_items WHERE id=$1 AND job_id=$2 RETURNING name, qty', [id, job.id])).rows[0];
        if (x) await log(db, job.id, req.user, `Bid: removed ${Number(x.qty)} × ${x.name}`);
      }
      let subs = 0, quoted = 0, added = 0, changed = 0;
      for (const r of rows.filter((x) => x.kind === 'product')) {
        const qty = Math.round(Number(r.qty) * 1000) / 1000;
        if (!(qty > 0 && qty <= 1000000)) fail(400, `Quantity for ${r.name || 'a product'} is not valid`);
        const p = each ? pct(r.markup_pct, `${r.name || 'Product'} markup %`) : all;
        let cur = null, unit, name, productId;
        if (r.id) {
          cur = (await db.query('SELECT * FROM job_bid_items WHERE id=$1 AND job_id=$2', [r.id, job.id])).rows[0] || fail(404, 'A product line was not found on this job');
          unit = cur.unit_cents; name = cur.name; productId = cur.product_id;
        } else {
          const pr = (await db.query('SELECT id, name, price_cents FROM products WHERE id=$1 AND business_id=$2 AND NOT is_rental', [r.product_id, req.user.business_id])).rows[0]
            || fail(404, 'That product was not found');
          unit = pr.price_cents; name = pr.name; productId = pr.id;
        }
        const amount = Math.round(qty * unit), q = Math.round(amount * (1 + p / 100));
        subs += amount; quoted += q;
        if (cur) {
          if (Number(cur.qty) !== qty || Number(cur.markup_pct) !== p || cur.quote_cents !== q) {
            await db.query('UPDATE job_bid_items SET qty=$1, markup_pct=$2, quote_cents=$3 WHERE id=$4', [qty, p, q, cur.id]); changed++;
          }
        } else {
          await db.query(`INSERT INTO job_bid_items (job_id, product_id, name, qty, unit_cents, markup_pct, quote_cents, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [job.id, productId, name, qty, unit, p, q, req.user.id]); added++;
        }
      }
      for (const r of rows.filter((x) => x.kind !== 'product')) {
        const trade = text(r.trade, 'Subcontractor / scope', { max: 60 });
        const amount = cents(r.amount_cents ?? 0, `${trade} amount`);
        const p = each ? pct(r.markup_pct, `${trade} markup %`) : all;
        const q = Math.round(amount * (1 + p / 100));
        subs += amount; quoted += q;
        if (r.id) {
          const cur = (await db.query('SELECT * FROM job_crews WHERE id=$1 AND job_id=$2', [r.id, job.id])).rows[0] || fail(404, `${trade} was not found on this job`);
          const bal = await subBalance(db, cur);
          if (amount + (bal.contract - cur.amount_cents) < bal.paid) fail(400, `${usd(bal.paid)} has already been paid to ${trade}, so its amount can't go below that`);
          if (cur.trade !== trade || cur.amount_cents !== amount || cur.quote_cents !== q || Number(cur.gc_markup_pct) !== p) {
            await db.query('UPDATE job_crews SET trade=$1, amount_cents=$2, quote_cents=$3, gc_markup_pct=$4 WHERE id=$5', [trade, amount, q, p, cur.id]);
            changed++;
          }
        } else {
          await db.query(`INSERT INTO job_crews (job_id, column_id, trade, amount_cents, billing, quote_cents, gc_markup_pct, created_by)
            VALUES ($1,$2,$3,$4,'included',$5,$6,$7)`, [job.id, phase, trade, amount, q, p, req.user.id]);
          added++;
        }
      }
      if (quoted !== job.quoted_cents && job.paid_cents > 0 && !isManager(req.user)) {
        fail(403, 'Payments have been taken on this job; only an owner or manager can change the quoted price');
      }
      await db.query('UPDATE jobs SET quoted_cents=$1, gc_own_cents=0, gc_markup_each=$2, gc_markup_all=$3, updated_at=now() WHERE id=$4', [quoted, each, all, job.id]);
      if (added || changed || removed.length || removedItems.length || quoted !== job.quoted_cents) {
        await log(db, job.id, req.user, `Bid saved: ${rows.length} line${rows.length === 1 ? "" : "s"} · cost ${usd(subs)} + markup ${usd(quoted - subs)} = quoted price ${usd(quoted)}`
          + (quoted !== job.quoted_cents ? ` (was ${usd(job.quoted_cents)})` : ''));
      }
      return { quoted_cents: quoted };
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json(out);
  }));

  // Detailed print (each trade's price, markup included) needs the user's password again, so it can't go out by accident.
  const bcrypt = require('bcryptjs');
  const pwTries = new Map();
  app.post('/api/jobs/:id/detail-print', ...J, wrap(async (req, res) => {
    const now = Date.now();
    const rec = pwTries.get(req.user.id) || { n: 0, t: now };
    if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
    if (rec.n >= 5) fail(429, 'Too many wrong passwords. Try again in 15 minutes.');
    const { job } = await loadJob(pool, req.params.id, req.user.business_id);
    const u = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
      rec.n++; pwTries.set(req.user.id, rec);
      fail(400, 'Wrong password');
    }
    pwTries.delete(req.user.id);
    await log(pool, job.id, req.user, 'Printed the detailed quote (each trade\'s price), password confirmed');
    res.json({ ok: true });
  }));

  // ---------- subcontracts: payments made to a sub and change orders ----------
  // A crew's amount is its bid (the contract). Change orders add to it (or credit it); payments to the sub come off.
  // Owners/managers only. Allowed after the job is closed (subs are often paid after the customer).
  const SUB_METHOD = { check: 'Check', cash: 'Cash', card: 'Card', transfer: 'Bank transfer', other: 'Other' };
  async function crewOf(db, job, cid, lock) {
    const r = await db.query(`SELECT * FROM job_crews WHERE id=$1 AND job_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [cid, job.id]);
    return r.rows[0] || fail(404, 'Crew not found');
  }
  async function subBalance(db, crew) {
    const r = await db.query(`SELECT
        COALESCE((SELECT sum(amount_cents) FROM job_crew_changes WHERE crew_id=$1), 0)::int AS co,
        COALESCE((SELECT sum(amount_cents) FROM job_crew_payments WHERE crew_id=$1 AND NOT voided), 0)::int AS paid`, [crew.id]);
    const contract = crew.amount_cents + r.rows[0].co;
    return { contract, paid: r.rows[0].paid, owed: contract - r.rows[0].paid };
  }
  const who = (c) => `${c.trade}${c.name ? ' (' + c.name + ')' : ''}`;
  const subRoute = (path, handler) => app.post(`/api/jobs/:id/crews/:cid${path}`, ...J, feats.needs('subs'), wrap(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only an owner or manager can record payments and change orders for subs');
    const out = await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      const crew = await crewOf(db, job, req.params.cid, true);
      return handler(db, req, job, crew);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json(out || { ok: true });
  }));

  subRoute('/payments', async (db, req, job, crew) => {
    const b = req.body;
    const amount = cents(b.amount_cents, 'Payment amount');
    if (!amount) fail(400, 'Enter the amount paid');
    const method = SUB_METHOD[b.method] ? b.method : 'check';
    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(b.paid_on || '') ? b.paid_on : null;
    const bal = await subBalance(db, crew);
    if (bal.contract > 0 && amount > bal.owed) {
      fail(400, bal.owed > 0 ? `That's more than the ${usd(bal.owed)} still owed to ${who(crew)}. Record a change order first if the price went up.`
        : `${who(crew)} is already paid in full. Record a change order first if the price went up.`);
    }
    const r = await db.query(
      `INSERT INTO job_crew_payments (crew_id, job_id, amount_cents, method, check_number, paid_on, note, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8) RETURNING id`,
      [crew.id, job.id, amount, method, text(b.check_number, 'Check number', { required: false, max: 30 }) || null, paidOn,
        text(b.note, 'Note', { required: false, max: 200 }) || null, req.user.id]);
    const after = bal.owed - amount;
    await log(db, job.id, req.user, `Paid ${who(crew)} ${usd(amount)} by ${SUB_METHOD[method]}${b.check_number ? ' #' + b.check_number : ''}`
      + (bal.contract > 0 ? ` · still owed ${usd(after)}` : ''));
    return { id: r.rows[0].id };
  });

  subRoute('/payments/:pid/void', async (db, req, job, crew) => {
    const reason = text(req.body.reason, 'Reason', { required: false, max: 200 });
    if (!reason || reason.length < 3) fail(400, 'Write why this payment is being voided');
    const r = await db.query(`UPDATE job_crew_payments SET voided=TRUE, void_reason=$1, voided_at=now()
      WHERE id=$2 AND crew_id=$3 AND NOT voided RETURNING amount_cents`, [reason, req.params.pid, crew.id]);
    if (!r.rows[0]) fail(404, 'Payment not found');
    await log(db, job.id, req.user, `Voided payment of ${usd(r.rows[0].amount_cents)} to ${who(crew)} · Reason: ${reason}`);
  });

  subRoute('/changes', async (db, req, job, crew) => {
    const b = req.body;
    const amt = cents(b.amount_cents, 'Change order amount');
    if (!amt) fail(400, 'Enter the change order amount');
    const signed = b.credit ? -amt : amt;
    const note = text(b.note, 'What the change order is for', { max: 300 });
    if (note.length < 3) fail(400, 'Write what the change order is for');
    const bal = await subBalance(db, crew);
    if (bal.contract + signed < bal.paid) fail(400, `That credit would leave ${who(crew)}'s contract below the ${usd(bal.paid)} already paid`);
    const bill = b.bill_customer ? cents(b.customer_cents, 'Amount to charge the customer') : 0;
    if (b.bill_customer && !bill) fail(400, 'Enter the amount to charge the customer');
    if (bill) notClosed(job);
    const n = await db.query('SELECT COALESCE(max(number), 0)::int + 1 AS n FROM job_crew_changes WHERE crew_id=$1', [crew.id]);
    const num = n.rows[0].n;
    let itemId = null;
    if (bill) {
      const it = await db.query(`INSERT INTO job_items (job_id, kind, name, qty, unit_cents, taxable, created_by) VALUES ($1,'charge',$2,1,$3,FALSE,$4) RETURNING id`,
        [job.id, `Change order: ${crew.trade}: ${note}`.slice(0, 120), bill, req.user.id]);
      itemId = it.rows[0].id;
    }
    const r = await db.query(
      `INSERT INTO job_crew_changes (crew_id, job_id, number, amount_cents, note, customer_cents, job_item_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [crew.id, job.id, num, signed, note, bill, itemId, req.user.id]);
    await log(db, job.id, req.user, `Change order #${num} for ${who(crew)}: ${signed < 0 ? '−' : '+'}${usd(Math.abs(signed))} (${note})`
      + ` · contract now ${usd(bal.contract + signed)}` + (bill ? ` · ${usd(bill)} added to the customer's bill` : ''));
    return { id: r.rows[0].id };
  });

  app.delete('/api/jobs/:id/crews/:cid/changes/:chid', ...J, feats.needs('subs'), wrap(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only an owner or manager can remove change orders');
    await withTx(async (db) => {
      const { job } = await loadJob(db, req.params.id, req.user.business_id, true);
      const crew = await crewOf(db, job, req.params.cid, true);
      const x = (await db.query('SELECT * FROM job_crew_changes WHERE id=$1 AND crew_id=$2', [req.params.chid, crew.id])).rows[0] || fail(404, 'Change order not found');
      if (x.job_item_id) {
        const it = await db.query('SELECT id FROM job_items WHERE id=$1', [x.job_item_id]);
        if (it.rows[0]) { notClosed(job); await db.query('DELETE FROM job_items WHERE id=$1', [x.job_item_id]); }
      }
      const bal = await subBalance(db, crew);
      if (bal.contract - x.amount_cents < bal.paid) fail(400, `Removing it would leave ${who(crew)}'s contract below the ${usd(bal.paid)} already paid`);
      await db.query('DELETE FROM job_crew_changes WHERE id=$1', [x.id]);
      await log(db, job.id, req.user, `Removed change order #${x.number} for ${who(crew)} (${x.amount_cents < 0 ? '−' : '+'}${usd(Math.abs(x.amount_cents))}: ${x.note})`
        + (x.job_item_id ? ' and its charge on the ticket' : ''));
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // ---------- sending the quote / statement to the customer (WhatsApp, text, email) ----------
  // Each job gets a private link (/j#<token>) the customer can open without logging in.
  async function shareInfo(req, id) {
    await pool.query('UPDATE jobs SET share_token=$1 WHERE id=$2 AND business_id=$3 AND share_token IS NULL', [token(16), id, req.user.business_id]);
    const { job, cols } = await loadJob(pool, id, req.user.business_id);
    const b = (await pool.query('SELECT name FROM businesses WHERE id=$1', [req.user.business_id])).rows[0];
    let email = null, phone = job.customer_phone;
    if (job.customer_id) {
      const c = (await pool.query('SELECT email, phone FROM customers WHERE id=$1 AND business_id=$2', [job.customer_id, req.user.business_id])).rows[0];
      if (c) { email = c.email; phone = phone || c.phone; }
    }
    const kind = docKind(job, cols);
    return { job, kind, url: `${publicOrigin(req)}/j#${job.share_token}`, business_name: b.name, phone, email: email || job.statement_emailed_to };
  }
  // A job in the first column with nothing paid is a quote; after that it's a job statement (an invoice once it's closed).
  const docKind = (job, cols) => (job.is_closed ? 'invoice' : (job.column_index <= 0 && !job.paid_cents ? 'quote' : 'statement'));
  const DOC = { quote: 'quote', statement: 'job statement', invoice: 'final invoice' };

  app.post('/api/jobs/:id/share', ...J, wrap(async (req, res) => {
    const s = await shareInfo(req, req.params.id);
    const j = s.job;
    const owed = s.kind === 'statement' && j.balance_cents > 0 ? `, balance due ${usd(j.balance_cents)}` : '';
    const message = `${s.business_name}: your ${DOC[s.kind]} for ${j.name} (job #${j.job_number}), total ${usd(j.total_cents)}${owed}. View it here: ${s.url}`;
    res.json({ url: s.url, kind: s.kind, doc: DOC[s.kind], message, phone: s.phone, email: s.email,
      job: { id: j.id, job_number: j.job_number, name: j.name, total_cents: j.total_cents, balance_cents: j.balance_cents, statement_emailed_to: j.statement_emailed_to } });
  }));

  // What the customer sees at /j#<token>: no login, and nothing internal (no history, no crews' costs, no notes about who did what).
  async function publicJob(t) {
    if (!/^[0-9a-f]{32}$/.test(String(t || ''))) fail(404, 'Not found');
    const r = await pool.query('SELECT id, business_id FROM jobs WHERE share_token=$1', [t]);
    if (!r.rows[0]) fail(404, 'Not found');
    const { job, cols } = await loadJob(pool, r.rows[0].id, r.rows[0].business_id);
    const b = (await pool.query('SELECT name, logo_url FROM businesses WHERE id=$1', [job.business_id])).rows[0];
    const loc = (await pool.query('SELECT name, address, phone FROM locations WHERE id=$1', [job.location_id])).rows[0] || {};
    const items = await pool.query('SELECT name, qty, unit_cents, taxable, kind FROM job_items WHERE job_id=$1 ORDER BY id', [job.id]);
    const pays = await pool.query('SELECT method, amount_cents, check_number, created_at FROM job_payments WHERE job_id=$1 AND NOT voided ORDER BY id', [job.id]);
    const kind = docKind(job, cols);
    return { kind, doc: DOC[kind], business_name: b.name, logo_url: b.logo_url, location_name: loc.name, location_address: loc.address, location_phone: loc.phone,
      job_number: job.job_number, name: job.name, description: job.description, customer_name: job.customer_name, job_address: job.job_address,
      po_number: job.po_number, start_date: job.start_date, status: cols[job.column_index] ? cols[job.column_index].name : null, created_at: job.created_at,
      quoted_cents: job.quoted_cents, extras_cents: job.extras_cents, tax_rate: job.tax_rate, tax_exempt: job.tax_exempt, tax_cents: job.tax_cents,
      subtotal_cents: job.subtotal_cents, discount_cents: job.discount_cents, discount_note: job.discount_note, total_cents: job.total_cents,
      paid_cents: job.paid_cents, balance_cents: job.balance_cents, closed_at: job.closed_at,
      items: items.rows.map((i) => ({ name: i.name, qty: i.qty, unit_cents: i.unit_cents, taxable: i.taxable, kind: i.kind })),
      payments: pays.rows.map((p) => ({ method: METHOD_NAMES[p.method] || p.method, amount_cents: p.amount_cents, check_number: p.check_number, date: p.created_at })) };
  }
  app.get('/api/public/job/:token', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await publicJob(req.params.token));
  }));

  app.post('/api/jobs/:id/email', ...J, wrap(async (req, res) => {
    const mail = require('./email');
    if (!mail.configured()) fail(400, 'Email is not set up on this server yet (RESEND_API_KEY).');
    const to = String(req.body.email || '').trim().toLowerCase();
    if (!mail.EMAIL_RE.test(to) || to.length > 200) fail(400, 'That email address does not look right');
    const s = await shareInfo(req, req.params.id);
    if (s.job.statement_email_count >= 50) fail(429, 'This job has already been emailed 50 times.');
    const p = await publicJob(s.job.share_token);
    const bz = (await pool.query(
      `SELECT b.receipt_reply_email, (SELECT email FROM users WHERE business_id=b.id AND role='owner' AND active ORDER BY id LIMIT 1) AS owner_email
         FROM businesses b WHERE b.id=$1`, [req.user.business_id])).rows[0];
    const { esc, money } = mail;
    const Doc = p.doc.charAt(0).toUpperCase() + p.doc.slice(1);
    const note = text(req.body.note, 'Message', { required: false, max: 1000 });
    const row = (l, r, bold) => `<tr><td style="padding:3px 8px 3px 0;${bold ? 'font-weight:700;font-size:17px' : 'color:#555'}">${l}</td><td align="right" style="padding:3px 0;white-space:nowrap;${bold ? 'font-weight:700;font-size:17px' : ''}">${r}</td></tr>`;
    const lines = [`<tr><td style="padding:6px 0;border-bottom:1px solid #eee">Quoted price</td><td align="right" style="padding:6px 0;border-bottom:1px solid #eee">${money(p.quoted_cents)}</td></tr>`]
      .concat(p.items.slice(0, 150).map((it) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(it.name)}${it.qty !== 1 ? `<div style="color:#777;font-size:13px">${it.qty} × ${money(it.unit_cents)}</div>` : ''}</td>
        <td align="right" valign="top" style="padding:6px 0;border-bottom:1px solid #eee;white-space:nowrap">${money(it.qty * it.unit_cents)}</td></tr>`)).join('');
    const html = `<!doctype html><html><body style="margin:0;background:#f2f2f0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f0;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:10px;padding:24px"><tr><td>
  ${p.logo_url ? `<img src="${esc(p.logo_url)}" alt="" style="max-height:60px;max-width:200px;display:block;margin:0 auto 10px">` : ''}
  <div style="text-align:center;font-size:20px;font-weight:700">${esc(p.business_name)}</div>
  <div style="text-align:center;color:#666;font-size:14px;margin-top:4px">${esc(p.location_address || '')}${p.location_phone ? '<br>' + esc(p.location_phone) : ''}</div>
  <div style="margin-top:18px;font-size:18px;font-weight:700">${Doc} · Job #${p.job_number}</div>
  <div style="color:#555;font-size:14px;margin-top:4px"><b>${esc(p.name)}</b>${p.description ? ' — ' + esc(p.description) : ''}${p.customer_name ? '<br>For: ' + esc(p.customer_name) : ''}${p.job_address ? '<br>Job site: ' + esc(p.job_address) : ''}${p.po_number ? '<br>PO: ' + esc(p.po_number) : ''}</div>
  ${note ? `<div style="margin-top:14px;padding:12px;background:#f6f6f3;border-radius:8px;white-space:pre-wrap">${esc(note)}</div>` : ''}
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:15px">${lines}</table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:15px">
    ${row('Subtotal', money(p.subtotal_cents))}
    ${row(p.tax_exempt ? 'Sales tax (exempt)' : `Sales tax (${Number(p.tax_rate)}%)`, money(p.tax_cents))}
    ${p.discount_cents ? row('Discount' + (p.discount_note ? ` (${esc(p.discount_note)})` : ''), '−' + money(p.discount_cents)) : ''}
    ${row('Total', money(p.total_cents), true)}
    ${p.paid_cents ? row('Paid so far', money(p.paid_cents)) : ''}
    ${p.kind !== 'quote' ? row('Balance due', money(p.balance_cents), true) : ''}
  </table>
  <div style="text-align:center;margin-top:22px"><a href="${esc(s.url)}" style="display:inline-block;background:#1f8f4e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">View or print your ${esc(p.doc)}</a></div>
  <div style="text-align:center;margin-top:20px;color:#888;font-size:13px">Questions? Just reply to this email.</div>
</td></tr></table>
<div style="color:#999;font-size:12px;margin-top:12px">Sent for ${esc(p.business_name)} by ContractorPOS</div>
</td></tr></table></body></html>`;
    const textBody = [p.business_name, `${Doc} · Job #${p.job_number}: ${p.name}`, note ? '\n' + note + '\n' : '',
      `Total: ${money(p.total_cents)}`, p.paid_cents ? `Paid so far: ${money(p.paid_cents)}` : '', p.kind !== 'quote' ? `Balance due: ${money(p.balance_cents)}` : '',
      '', `View or print it here: ${s.url}`].filter((x) => x !== '').join('\n');
    try {
      await mail.sendMail({ fromName: p.business_name, to, subject: `Your ${p.doc} from ${p.business_name} - Job #${p.job_number} - ${money(p.total_cents)}`,
        html, text: textBody, replyTo: bz.receipt_reply_email || bz.owner_email, idem: `job-${s.job.id}-${s.job.statement_email_count + 1}-${to}` });
    } catch (e) { fail(502, e.message); }
    await pool.query('UPDATE jobs SET statement_emailed_to=$1, statement_email_count=statement_email_count+1 WHERE id=$2', [to, s.job.id]);
    let saved = false;
    if (s.job.customer_id) {
      const u = await pool.query(`UPDATE customers SET email=$1 WHERE id=$2 AND business_id=$3 AND (email IS NULL OR email='')`, [to, s.job.customer_id, req.user.business_id]);
      saved = u.rowCount > 0;
    }
    await log(pool, s.job.id, req.user, `Emailed the ${p.doc} to ${to}`);
    notify(req.user.business_id, { type: 'job', id: s.job.id });
    res.json({ ok: true, to, saved_to_customer: saved });
  }));
  // Logs when a quote/statement was sent by WhatsApp or text (the browser opens the app; this just records it).
  app.post('/api/jobs/:id/sent', ...J, wrap(async (req, res) => {
    const how = { whatsapp: 'WhatsApp', text: 'text message' }[req.body.how] || fail(400, 'Unknown way of sending');
    const s = await shareInfo(req, req.params.id);
    await log(pool, s.job.id, req.user, `Sent the ${DOC[s.kind]} by ${how}${req.body.to ? ' to ' + text(req.body.to, 'To', { required: false, max: 60 }) : ''}`);
    notify(req.user.business_id, { type: 'job', id: s.job.id });
    res.json({ ok: true });
  }));

  // ---------- crew packet: send a crew the job site, notes, material list and chosen files (WhatsApp, text, email) ----------
  // Each crew gets its own private link (/c#<token>). It shows only what was picked for that crew: no prices, no money.
  async function crewPacketInfo(req, jobId, cid, fresh) {
    const { job, cols } = await loadJob(pool, jobId, req.user.business_id);
    const c = (await pool.query('SELECT * FROM job_crews WHERE id=$1 AND job_id=$2', [cid, job.id])).rows[0] || fail(404, 'Crew not found');
    if (!c.packet_token || fresh) {
      c.packet_token = token(16);
      await pool.query('UPDATE job_crews SET packet_token=$1 WHERE id=$2', [c.packet_token, c.id]);
    }
    const b = (await pool.query('SELECT name FROM businesses WHERE id=$1', [req.user.business_id])).rows[0];
    const url = `${publicOrigin(req)}/c#${c.packet_token}`;
    const who = c.name || c.trade;
    const message = `${b.name}: job info for ${who}: ${job.name} (job #${job.job_number})${job.job_address ? ', ' + job.job_address : ''}.`
      + `${c.packet_important ? ' IMPORTANT notes inside.' : ''} Plans, notes and material list: ${url}`;
    return { job, cols, crew: c, url, message, business_name: b.name };
  }
  app.put('/api/jobs/:id/crews/:cid/packet', ...J, wrap(async (req, res) => {
    const { job } = await loadJob(pool, req.params.id, req.user.business_id);
    const b = req.body || {};
    const ids = (Array.isArray(b.file_ids) ? b.file_ids : []).map(Number).filter(Number.isInteger).slice(0, 100);
    const ok = ids.length ? (await pool.query('SELECT id FROM job_files WHERE job_id=$1 AND id = ANY($2)', [job.id, ids])).rows.map((r) => r.id) : [];
    const email = String(b.email || '').trim().toLowerCase();
    if (email && (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || email.length > 200)) fail(400, 'That email address does not look right');
    const phone = b.phone == null ? undefined : text(b.phone, 'Phone', { required: false, max: 40 }) || null;
    const r = await pool.query(`UPDATE job_crews SET packet_note=$1, packet_important=$2, packet_files=$3, packet_materials=$4,
        email=COALESCE(NULLIF($5,''), email), phone=CASE WHEN $6::boolean THEN $7 ELSE phone END WHERE id=$8 AND job_id=$9 RETURNING id`,
      [text(b.note, 'Notes for the crew', { required: false, max: 4000 }) || null, !!b.important, ok, b.materials !== false, email,
        phone !== undefined, phone === undefined ? null : phone, req.params.cid, job.id]);
    if (!r.rows[0]) fail(404, 'Crew not found');
    if (Array.isArray(b.parts)) {
      if (b.parts.length > 300) fail(400, 'A parts list can have up to 300 lines');
      const rows = b.parts.map((m, i) => {
        const name = text(m.name, `Part on line ${i + 1}`, { max: 120 });
        const qty = Math.round(Number(String(m.qty ?? 1).replace(',', '.')) * 1000) / 1000;
        if (!(qty > 0 && qty <= 1000000)) fail(400, `Quantity for ${name} is not valid`);
        return [Number(m.product_id) || null, name, qty, text(m.unit, 'Unit', { required: false, max: 20 }) || null, text(m.note, 'Note', { required: false, max: 200 }) || null, i];
      });
      const pids = rows.map((x) => x[0]).filter(Boolean);
      const okP = pids.length ? new Set((await pool.query('SELECT id FROM products WHERE business_id=$1 AND id = ANY($2)', [req.user.business_id, pids])).rows.map((x) => x.id)) : new Set();
      await withTx(async (db) => {
        await db.query('DELETE FROM job_crew_materials WHERE crew_id=$1 AND job_id=$2', [req.params.cid, job.id]);
        for (const x of rows) {
          await db.query('INSERT INTO job_crew_materials (crew_id, job_id, product_id, name, qty, unit, note, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [req.params.cid, job.id, okP.has(x[0]) ? x[0] : null, x[1], x[2], x[3], x[4], x[5]]);
        }
      });
    }
    const s = await crewPacketInfo(req, job.id, req.params.cid, !!b.new_link);
    if (b.new_link) await log(pool, job.id, req.user, `Made a new crew link for ${s.crew.trade} (the old link stopped working)`);
    res.json({ url: s.url, message: s.message, phone: s.crew.phone, email: s.crew.email, files: ok.length });
  }));
  app.post('/api/jobs/:id/crews/:cid/packet/sent', ...J, wrap(async (req, res) => {
    const how = { whatsapp: 'WhatsApp', text: 'text message' }[req.body.how] || fail(400, 'Unknown way of sending');
    const s = await crewPacketInfo(req, req.params.id, req.params.cid);
    await pool.query('UPDATE job_crews SET packet_sent_at=now() WHERE id=$1', [s.crew.id]);
    await log(pool, s.job.id, req.user, `Sent the crew packet to ${s.crew.trade}${s.crew.name ? ' (' + s.crew.name + ')' : ''} by ${how}${req.body.to ? ' to ' + text(req.body.to, 'To', { required: false, max: 60 }) : ''}`);
    notify(req.user.business_id, { type: 'job', id: s.job.id });
    res.json({ ok: true });
  }));
  app.post('/api/jobs/:id/crews/:cid/packet/email', ...J, wrap(async (req, res) => {
    const mail = require('./email');
    if (!mail.configured()) fail(400, 'Email is not set up on this server yet (RESEND_API_KEY).');
    const to = String(req.body.email || '').trim().toLowerCase();
    if (!mail.EMAIL_RE.test(to) || to.length > 200) fail(400, 'That email address does not look right');
    const s = await crewPacketInfo(req, req.params.id, req.params.cid);
    const p = await publicCrew(s.crew.packet_token);
    const { esc } = mail;
    const note = text(req.body.note, 'Message', { required: false, max: 1000 });
    const html = `<!doctype html><html><body style="margin:0;background:#f2f2f0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f0;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:10px;padding:24px"><tr><td>
  <div style="font-size:20px;font-weight:700">${esc(p.business_name)}</div>
  <div style="margin-top:12px;font-size:18px;font-weight:700">Job #${p.job_number} · ${esc(p.name)}</div>
  <div style="color:#555;font-size:14px;margin-top:4px">For: <b>${esc(p.crew_trade)}${p.crew_name ? ' · ' + esc(p.crew_name) : ''}</b>${p.job_address ? '<br>Job site: ' + esc(p.job_address) : ''}${p.start_date ? '<br>Start: ' + esc(String(p.start_date).slice(0, 10)) : ''}</div>
  ${note ? `<div style="margin-top:14px;padding:12px;background:#f6f6f3;border-radius:8px;white-space:pre-wrap">${esc(note)}</div>` : ''}
  ${p.note ? `<div style="margin-top:14px;padding:12px;border-radius:8px;white-space:pre-wrap;${p.important ? 'background:#fdecea;border:2px solid #b3261e' : 'background:#f6f6f3'}">${p.important ? '<b style="color:#b3261e">⚠ IMPORTANT</b><br>' : ''}${esc(p.note)}</div>` : ''}
  <div style="margin-top:14px;color:#555;font-size:14px">${p.files.length} file${p.files.length === 1 ? '' : 's'} (plans, pictures, PDFs)${p.parts.length ? `, a parts list with ${p.parts.length} line${p.parts.length === 1 ? '' : 's'}` : ''}${p.materials.length ? ` and the job material list (${p.materials.length})` : ''}.</div>
  <div style="text-align:center;margin-top:22px"><a href="${esc(s.url)}" style="display:inline-block;background:#1f8f4e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Open the job info</a></div>
</td></tr></table>
<div style="color:#999;font-size:12px;margin-top:12px">Sent for ${esc(p.business_name)} by ContractorPOS</div>
</td></tr></table></body></html>`;
    const textBody = [p.business_name, `Job #${p.job_number}: ${p.name}`, p.job_address ? 'Job site: ' + p.job_address : '', note,
      p.note ? (p.important ? 'IMPORTANT: ' : 'Notes: ') + p.note : '',
      p.parts.length ? 'Parts to bring:\n' + p.parts.map((m) => `- ${m.qty}${m.unit ? ' ' + m.unit : ''} ${m.name}${m.note ? ' (' + m.note + ')' : ''}`).join('\n') : '',
      '', `Plans, notes and material list: ${s.url}`].filter((x) => x !== '').join('\n');
    try {
      await mail.sendMail({ fromName: p.business_name, to, subject: `${p.important ? '⚠ ' : ''}Job #${p.job_number} ${p.name}: info for ${p.crew_trade}`,
        html, text: textBody, idem: `crew-${s.crew.id}-${Date.now()}-${to}` });
    } catch (e) { fail(502, e.message); }
    await pool.query('UPDATE job_crews SET packet_sent_at=now(), email=$1 WHERE id=$2', [to, s.crew.id]);
    await log(pool, s.job.id, req.user, `Emailed the crew packet to ${s.crew.trade}${s.crew.name ? ' (' + s.crew.name + ')' : ''} at ${to}`);
    notify(req.user.business_id, { type: 'job', id: s.job.id });
    res.json({ ok: true, to });
  }));

  // What the crew sees at /c#<token>. No prices or money anywhere.
  async function publicCrew(t) {
    if (!/^[0-9a-f]{32}$/.test(String(t || ''))) fail(404, 'Not found');
    const c = (await pool.query('SELECT c.*, j.business_id FROM job_crews c JOIN jobs j ON j.id = c.job_id WHERE c.packet_token=$1', [t])).rows[0] || fail(404, 'Not found');
    const { job, cols } = await loadJob(pool, c.job_id, c.business_id);
    const b = (await pool.query('SELECT name, logo_url FROM businesses WHERE id=$1', [c.business_id])).rows[0];
    const loc = (await pool.query('SELECT name, address, phone FROM locations WHERE id=$1', [job.location_id])).rows[0] || {};
    const files = c.packet_files.length ? (await pool.query(`SELECT id, kind, name, mime, estimate, created_at FROM job_files WHERE job_id=$1 AND id = ANY($2) ORDER BY id`, [job.id, c.packet_files])).rows : [];
    let materials = [];
    if (c.packet_materials) {
      const it = await pool.query(`SELECT name, qty FROM job_items WHERE job_id=$1 AND kind IN ('item','rental') ORDER BY id`, [job.id]);
      const bi = await pool.query('SELECT name, qty FROM job_bid_items WHERE job_id=$1 ORDER BY id', [job.id]);
      materials = it.rows.concat(bi.rows).map((m) => ({ name: m.name, qty: Number(m.qty) }));
    }
    const parts = (await pool.query('SELECT name, qty, unit, note FROM job_crew_materials WHERE crew_id=$1 ORDER BY position, id', [c.id])).rows.map((m) => ({ ...m, qty: Number(m.qty) }));
    const phase = cols.find((k) => k.id === c.column_id);
    return { business_name: b.name, logo_url: b.logo_url, location_phone: loc.phone, job_number: job.job_number, name: job.name, description: job.description,
      job_address: job.job_address, start_date: job.start_date, status: cols[job.column_index] ? cols[job.column_index].name : null,
      customer_name: job.customer_name, crew_trade: c.trade, crew_name: c.name, crew_phase: phase ? phase.name : null, crew_scope: c.note,
      note: c.packet_note, important: c.packet_important, materials, parts,
      files: files.filter((f) => f.kind === 'pdf' || f.kind === 'photo').map((f) => ({ id: f.id, kind: f.kind, name: f.name })),
      estimates: files.filter((f) => f.kind === 'estimate' && f.estimate).map((f) => ({ name: f.name, summary: f.estimate.summary || '', materials: (f.estimate.materials || []).map((m) => ({ name: m.name, qty: m.qty, unit: m.unit, notes: m.notes })) })),
      answers: files.filter((f) => f.kind === 'answer' && f.estimate).map((f) => ({ name: f.name, thread: (f.estimate.thread || []).map((x) => ({ q: x.q, a: x.a })) })) };
  }
  app.get('/api/public/crew/:token', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await publicCrew(req.params.token));
  }));
  app.get('/api/public/crew/:token/files/:fid', wrap(async (req, res) => {
    const t = String(req.params.token || '');
    if (!/^[0-9a-f]{32}$/.test(t)) fail(404, 'Not found');
    const r = await pool.query(`SELECT f.name, f.mime, f.data FROM job_crews c JOIN job_files f ON f.job_id = c.job_id
        WHERE c.packet_token=$1 AND f.id=$2 AND f.id = ANY(c.packet_files) AND f.data IS NOT NULL AND f.kind IN ('pdf','photo')`, [t, req.params.fid]);
    const f = r.rows[0] || fail(404, 'File not found');
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(f.name)}"` });
    res.send(f.data);
  }));

  // Used by jobfiles.js (attachments and Claude estimates).
  return { notify, log, J };
};
