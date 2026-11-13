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
  const { pool, wrap, fail, text, cents, requireLogin, requireBusiness, requireRole, barcodeVariants } = deps;
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
              j.discount_cents, j.column_entered_at, j.closed_at, j.updated_at, ${JOB_SUMS},
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
  app.put('/api/job-columns/:id', ...J, wrap(async (req, res) => {
    needManager(req.user);
    const c = await pool.query('SELECT * FROM job_columns WHERE id=$1 AND business_id=$2', [req.params.id, req.user.business_id]);
    if (!c.rows[0]) fail(404, 'Column not found');
    await pool.query('UPDATE job_columns SET name=$1, color=$2, buttons=$3 WHERE id=$4',
      [text(req.body.name, 'Column name', { max: 40 }), cleanColor(req.body.color, c.rows[0].color),
        JSON.stringify(cleanButtons(req.body.buttons)), c.rows[0].id]);
    notify(req.user.business_id, { type: 'columns' });
    res.json({ ok: true });
  }));
  app.post('/api/job-columns', ...J, wrap(async (req, res) => {
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
  app.post('/api/job-columns/:id/move', ...J, wrap(async (req, res) => {
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
  app.delete('/api/job-columns/:id', ...J, wrap(async (req, res) => {
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
      `SELECT c.*, k.name AS column_name, k.position AS column_position FROM job_crews c LEFT JOIN job_columns k ON k.id = c.column_id
        WHERE c.job_id=$1 ORDER BY k.position NULLS LAST, c.id`, [job.id]);
    res.json({ ...job, column: cols[job.column_index] || null, columns_count: cols.length, columns: cols.map((c) => ({ id: c.id, name: c.name, color: c.color })),
      location: loc.rows[0] || null, items: items.rows, payments: payments.rows, history: history.rows, crews: crews.rows });
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
  async function moveJob(db, job, cols, direction, user) {
    const from = job.column_index < 0 ? 0 : job.column_index;
    const to = from + (direction < 0 ? -1 : 1);
    if (to < 0 || to >= cols.length) fail(400, direction < 0 ? 'This job is already in the first column' : 'This job is already in the last column');
    const last = cols.length - 1;
    if (direction < 0 && !isManager(user)) fail(403, 'Only an owner or manager can move a job back');
    if (to === last) {
      if (job.balance_cents > 0) fail(400, `${usd(job.balance_cents)} is still owed on this job. Take the payment or finish with a discount first.`);
      if (job.balance_cents < 0) fail(400, `The customer has paid ${usd(-job.balance_cents)} more than the total. Void a payment or lower the discount first.`);
    }
    await db.query(
      `UPDATE jobs SET column_id=$1, status_label=NULL, column_entered_at=now(), updated_at=now(),
         closed_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$3`, [cols[to].id, to === last, job.id]);
    await log(db, job.id, user, `Moved ${direction < 0 ? 'back ' : ''}from ${cols[from].name} to ${cols[to].name}` + (to === last ? ' (job closed)' : ''));
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
      await moveJob(db, job, cols, direction, req.user);
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
      done: 'done' in b ? !!b.done : !!(current && current.done),
      column_id: null,
    };
    const col = cols.find((c) => c.id === Number(b.column_id));
    f.column_id = col ? col.id : (current ? current.column_id : null);
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
        `INSERT INTO job_crews (job_id, column_id, trade, name, phone, amount_cents, billing, note, markup_type, markup_percent, markup_cents, charge_cents, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [job.id, f.column_id, f.trade, f.name, f.phone, f.amount_cents, f.billing, f.note, f.markup_type, f.markup_percent, f.markup_cents, f.charge_cents, req.user.id]);
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
      const r = await db.query(
        `UPDATE job_crews SET column_id=$1, trade=$2, name=$3, phone=$4, amount_cents=$5, billing=$6, note=$7, done=$8,
           markup_type=$9, markup_percent=$10, markup_cents=$11, charge_cents=$12 WHERE id=$13 RETURNING *`,
        [f.column_id, f.trade, f.name, f.phone, f.amount_cents, f.billing, f.note, f.done, f.markup_type, f.markup_percent, f.markup_cents, f.charge_cents, cur.id]);
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
      const r = await db.query('DELETE FROM job_crews WHERE id=$1 AND job_id=$2 RETURNING *', [req.params.cid, job.id]);
      const c = r.rows[0] || fail(404, 'Crew not found');
      await log(db, job.id, req.user, `Crew removed: ${crewText(c)}${c.billing !== 'included' && c.charge_cents ? ' (its charge was taken off the ticket)' : ''}`);
    });
    notify(req.user.business_id, { type: 'job', id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // Used by jobfiles.js (attachments and Claude estimates).
  return { notify, log, J };
};
