// Crew Calendar add-on (v1.24, add-on since v1.25): which crew is on which job each day, like the Google Sheets schedule.
// Crews are your own crew leads and subs (sched_crews). A block (sched_entries) is one crew on one day,
// either a job from the board or typed text, with a status color. A block with no crew is a day off for everyone.
// A crew can get a private phone link (/s#token) to see their own days; it is off until you switch it on.
// Each block is office-only until you turn on "crew can see" (shared), so plans can change without the crew knowing.

const STATUSES = ['scheduled', 'working', 'tentative', 'problem', 'off'];
const STATUS_NAME = { scheduled: 'Scheduled', working: 'On track', tentative: 'Tentative', problem: 'Problem / urgent', off: 'Off / holiday' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function setupSchedule(app, deps) {
  const { pool, wrap, fail, text, publicOrigin, token, notify, log, feats } = deps;
  const J = [...deps.J, feats.needs('calendar')]; // job board on + Crew Calendar add-on
  const isManager = (u) => ['admin', 'owner', 'manager'].includes(u.role);
  const needManager = (u) => { if (!isManager(u)) fail(403, 'Only an owner or manager can change the crew list'); };

  const day = (v, what = 'Day') => {
    const s = String(v || '');
    if (!DAY_RE.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) fail(400, `${what} is not a date`);
    return s;
  };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const status = (v) => (STATUSES.includes(v) ? v : 'scheduled');
  const phone = (v) => { const s = text(v, 'Phone', { required: false, max: 30 }); return s || null; };
  const email = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (s.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'That email address does not look right');
    return s;
  };

  async function crewOf(req, id) {
    const r = await pool.query('SELECT * FROM sched_crews WHERE id=$1 AND business_id=$2', [id, req.user.business_id]);
    return r.rows[0] || fail(404, 'Crew not found');
  }
  async function jobOf(req, id) {
    if (id == null || id === '') return null;
    const r = await pool.query('SELECT id, job_number, name FROM jobs WHERE id=$1 AND business_id=$2', [id, req.user.business_id]);
    return r.rows[0] || fail(404, 'Job not found');
  }
  const ENTRY_SQL = `SELECT e.id, e.crew_id, to_char(e.day,'YYYY-MM-DD') AS day, e.job_id, e.label, e.status, e.note, e.position, e.shared,
        j.job_number, j.name AS job_name, j.customer_name, j.job_address, j.closed_at, k.name AS column_name, k.color AS column_color
      FROM sched_entries e LEFT JOIN jobs j ON j.id = e.job_id LEFT JOIN job_columns k ON k.id = j.column_id`;
  const crewOut = (c, req) => ({ id: c.id, name: c.name, kind: c.kind, phone: c.phone, email: c.email, note: c.note, position: c.position,
    active: c.active, link_on: c.link_on, link: c.link_on && c.link_token ? `${publicOrigin(req)}/s#${c.link_token}` : null });

  // ---------- the calendar ----------
  app.get('/api/schedule', ...J, wrap(async (req, res) => {
    const from = day(req.query.from, 'From');
    const to = day(req.query.to, 'To');
    if (to < from || to > addDays(from, 100)) fail(400, 'Pick up to 100 days at a time');
    const crews = await pool.query('SELECT * FROM sched_crews WHERE business_id=$1 ORDER BY position, id', [req.user.business_id]);
    const entries = await pool.query(`${ENTRY_SQL} WHERE e.business_id=$1 AND e.day BETWEEN $2 AND $3 ORDER BY e.day, e.position, e.id`,
      [req.user.business_id, from, to]);
    res.json({ crews: crews.rows.map((c) => crewOut(c, req)), entries: entries.rows, statuses: STATUSES.map((s) => ({ key: s, name: STATUS_NAME[s] })) });
  }));

  // Jobs to pick from: open ones first, then recently closed. Searches number, name, customer and address.
  app.get('/api/schedule/jobs', ...J, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const args = [req.user.business_id];
    let where = '';
    if (q) {
      args.push(`%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
      where = ` AND (j.name ILIKE $2 OR j.customer_name ILIKE $2 OR j.job_address ILIKE $2 OR j.job_number::text ILIKE $2)`;
    }
    const r = await pool.query(`SELECT j.id, j.job_number, j.name, j.customer_name, j.job_address, j.closed_at, k.name AS column_name, k.color AS column_color
        FROM jobs j LEFT JOIN job_columns k ON k.id = j.column_id
       WHERE j.business_id=$1${where}
       ORDER BY (j.closed_at IS NOT NULL), j.updated_at DESC LIMIT 40`, args);
    res.json(r.rows);
  }));

  // Days a job is on the calendar (shown on the job ticket).
  app.get('/api/schedule/job/:id', ...J, wrap(async (req, res) => {
    await jobOf(req, req.params.id);
    const r = await pool.query(`SELECT e.id, to_char(e.day,'YYYY-MM-DD') AS day, e.status, e.note, c.name AS crew_name, c.kind
        FROM sched_entries e LEFT JOIN sched_crews c ON c.id = e.crew_id
       WHERE e.job_id=$1 AND e.business_id=$2 ORDER BY e.day, c.position, c.id`, [req.params.id, req.user.business_id]);
    res.json(r.rows);
  }));

  // ---------- crews ----------
  const crewFields = (b, cur) => ({
    name: text(b.name, 'Crew name', { max: 60 }),
    kind: b.kind === 'sub' ? 'sub' : (b.kind === 'own' ? 'own' : (cur ? cur.kind : 'own')),
    phone: phone(b.phone), email: email(b.email), note: text(b.note, 'Note', { required: false, max: 300 }) || null,
  });
  app.post('/api/schedule/crews', ...J, wrap(async (req, res) => {
    needManager(req.user);
    const f = crewFields(req.body);
    const n = await pool.query('SELECT count(*)::int AS n, COALESCE(max(position),0) AS p FROM sched_crews WHERE business_id=$1', [req.user.business_id]);
    if (n.rows[0].n >= 200) fail(400, 'That is a lot of crews. Hide some you no longer use.');
    const r = await pool.query(`INSERT INTO sched_crews (business_id, name, kind, phone, email, note, position) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.business_id, f.name, f.kind, f.phone, f.email, f.note, n.rows[0].p + 1]);
    notify(req.user.business_id, { type: 'schedule' });
    res.json(crewOut(r.rows[0], req));
  }));
  app.put('/api/schedule/crews/order', ...J, wrap(async (req, res) => {
    needManager(req.user);
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 300);
    for (const [i, id] of ids.entries()) await pool.query('UPDATE sched_crews SET position=$1 WHERE id=$2 AND business_id=$3', [i + 1, id, req.user.business_id]);
    notify(req.user.business_id, { type: 'schedule' });
    res.json({ ok: true });
  }));
  app.put('/api/schedule/crews/:id', ...J, wrap(async (req, res) => {
    needManager(req.user);
    const c = await crewOf(req, req.params.id);
    const b = req.body;
    const f = 'name' in b ? crewFields(b, c) : c;
    const active = 'active' in b ? !!b.active : c.active;
    const linkOn = 'link_on' in b ? !!b.link_on : c.link_on;
    let tok = c.link_token;
    if ((linkOn && !tok) || b.new_link) tok = token(16);
    const r = await pool.query(`UPDATE sched_crews SET name=$1, kind=$2, phone=$3, email=$4, note=$5, active=$6, link_on=$7, link_token=$8
        WHERE id=$9 RETURNING *`, [f.name, f.kind, f.phone, f.email, f.note, active, linkOn, tok, c.id]);
    notify(req.user.business_id, { type: 'schedule' });
    res.json(crewOut(r.rows[0], req));
  }));
  app.delete('/api/schedule/crews/:id', ...J, wrap(async (req, res) => {
    needManager(req.user);
    const c = await crewOf(req, req.params.id);
    const n = await pool.query('SELECT count(*)::int AS n FROM sched_entries WHERE crew_id=$1', [c.id]);
    if (n.rows[0].n) fail(400, `${c.name} has ${n.rows[0].n} day${n.rows[0].n === 1 ? '' : 's'} on the calendar. Hide the crew instead, so the history stays.`);
    await pool.query('DELETE FROM sched_crews WHERE id=$1', [c.id]);
    notify(req.user.business_id, { type: 'schedule' });
    res.json({ ok: true });
  }));

  // ---------- blocks on the calendar ----------
  async function entryFields(req, b) {
    let crew = null;
    if (b.crew_id != null && b.crew_id !== '') crew = await crewOf(req, b.crew_id);
    const job = await jobOf(req, b.job_id);
    const label = text(b.label, 'What', { required: false, max: 80 }) || null;
    const st = crew ? status(b.status) : 'off';
    if (!job && !label) fail(400, crew ? 'Pick a job or type what they are doing' : 'Type what the day off is for (like Thanksgiving)');
    return { crew, job, label, status: st, note: text(b.note, 'Note', { required: false, max: 500 }) || null, shared: !!b.shared };
  }
  const fmtDays = (days) => {
    const f = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    return days.length === 1 ? f(days[0]) : `${f(days[0])} – ${f(days[days.length - 1])} (${days.length} days)`;
  };

  // Put a crew on one or more days (also used for "Copy to other days").
  app.post('/api/schedule/entries', ...J, wrap(async (req, res) => {
    const f = await entryFields(req, req.body);
    const days = [...new Set((Array.isArray(req.body.days) ? req.body.days : [req.body.day]).map((d) => day(d)))].sort();
    if (!days.length || days.length > 62) fail(400, 'Pick 1 to 62 days');
    const ids = [];
    for (const d of days) {
      const p = await pool.query('SELECT COALESCE(max(position),0)+1 AS p FROM sched_entries WHERE business_id=$1 AND day=$2 AND crew_id IS NOT DISTINCT FROM $3',
        [req.user.business_id, d, f.crew ? f.crew.id : null]);
      const r = await pool.query(`INSERT INTO sched_entries (business_id, crew_id, day, job_id, label, status, note, position, created_by, shared)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.user.business_id, f.crew ? f.crew.id : null, d, f.job ? f.job.id : null, f.label, f.status, f.note, p.rows[0].p, req.user.id, f.shared]);
      ids.push(r.rows[0].id);
    }
    if (f.job && f.crew) await log(pool, f.job.id, req.user, `Crew calendar: ${f.crew.name} on ${fmtDays(days)}`);
    notify(req.user.business_id, { type: 'schedule' });
    res.json({ ids });
  }));

  // Change a block: move it (crew/day), change the job, status or note.
  app.put('/api/schedule/entries/:id', ...J, wrap(async (req, res) => {
    const cur = (await pool.query("SELECT *, to_char(day,'YYYY-MM-DD') AS dstr FROM sched_entries WHERE id=$1 AND business_id=$2", [req.params.id, req.user.business_id])).rows[0] || fail(404, 'Not found on the calendar');
    const b = { crew_id: cur.crew_id, job_id: cur.job_id, label: cur.label, status: cur.status, note: cur.note, shared: cur.shared, ...req.body };
    const f = await entryFields(req, b);
    const d = 'day' in req.body ? day(req.body.day) : null;
    const crewChanged = (f.crew ? f.crew.id : null) !== cur.crew_id;
    const moved = (d && d !== cur.dstr) || crewChanged;
    // Given to another crew: back to office only, so the new crew doesn't see it until you choose to show it.
    if (crewChanged && f.crew && !('shared' in req.body)) f.shared = false;
    await pool.query(`UPDATE sched_entries SET crew_id=$1, day=COALESCE($2::date, day), job_id=$3, label=$4, status=$5, note=$6, shared=$8, updated_at=now()
        ${moved ? ', position = (SELECT COALESCE(max(position),0)+1 FROM sched_entries x WHERE x.business_id=$9 AND x.day=COALESCE($2::date, sched_entries.day) AND x.crew_id IS NOT DISTINCT FROM $1)' : ''}
        WHERE id=$7`, moved
      ? [f.crew ? f.crew.id : null, d, f.job ? f.job.id : null, f.label, f.status, f.note, cur.id, f.shared, req.user.business_id]
      : [f.crew ? f.crew.id : null, d, f.job ? f.job.id : null, f.label, f.status, f.note, cur.id, f.shared]);
    notify(req.user.business_id, { type: 'schedule' });
    res.json({ ok: true, shared: f.shared, unshared: cur.shared && !f.shared });
  }));
  // Show (or hide) many blocks at once: a week, optionally one crew.
  app.post('/api/schedule/share', ...J, wrap(async (req, res) => {
    const from = day(req.body.from, 'From'), to = day(req.body.to, 'To');
    if (to < from || to > addDays(from, 62)) fail(400, 'Pick up to 62 days');
    const args = [req.user.business_id, from, to, !!req.body.shared];
    let crew = '';
    if (req.body.crew_id) { await crewOf(req, req.body.crew_id); args.push(req.body.crew_id); crew = ' AND crew_id=$5'; }
    const r = await pool.query(`UPDATE sched_entries SET shared=$4, updated_at=now() WHERE business_id=$1 AND day BETWEEN $2 AND $3${crew} AND shared <> $4`, args);
    notify(req.user.business_id, { type: 'schedule' });
    res.json({ changed: r.rowCount });
  }));
  app.delete('/api/schedule/entries/:id', ...J, wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM sched_entries WHERE id=$1 AND business_id=$2 RETURNING id', [req.params.id, req.user.business_id]);
    if (!r.rows.length) fail(404, 'Not found on the calendar');
    notify(req.user.business_id, { type: 'schedule' });
    res.json({ ok: true });
  }));

  // ---------- a crew's phone link ----------
  async function publicSchedule(tok) {
    const t = String(tok || '');
    if (!/^[0-9a-f]{32}$/.test(t)) fail(404, 'This link is not valid');
    const c = (await pool.query(`SELECT c.*, b.name AS business_name, b.logo_url, b.time_zone, b.calendar_enabled FROM sched_crews c JOIN businesses b ON b.id = c.business_id
        WHERE c.link_token=$1`, [t])).rows[0];
    if (!c || !c.link_on || !c.active || !c.calendar_enabled) fail(404, 'This schedule link is turned off. Ask the office for a new one.');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: c.time_zone || 'America/Chicago' });
    const from = addDays(today, -1), to = addDays(today, 20);
    const r = await pool.query(`${ENTRY_SQL} WHERE e.business_id=$1 AND (e.crew_id=$2 OR e.crew_id IS NULL) AND e.shared AND e.day BETWEEN $3 AND $4
        ORDER BY e.day, e.crew_id NULLS FIRST, e.position, e.id`, [c.business_id, c.id, from, to]);
    return {
      business_name: c.business_name, logo_url: c.logo_url, crew_name: c.name, today,
      days: r.rows.map((e) => ({ day: e.day, everyone: e.crew_id == null, status: e.status, status_name: STATUS_NAME[e.status], label: e.label, note: e.note,
        job: e.job_id ? { number: e.job_number, name: e.job_name, customer: e.customer_name, address: e.job_address } : null })),
    };
  }
  app.get('/api/public/schedule/:token', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await publicSchedule(req.params.token));
  }));
  app.post('/api/schedule/crews/:id/email', ...J, wrap(async (req, res) => {
    const mail = require('./email');
    if (!mail.configured()) fail(400, 'Email is not set up on this server yet (RESEND_API_KEY).');
    const c = await crewOf(req, req.params.id);
    if (!c.link_on || !c.link_token) fail(400, 'Turn on the phone link for this crew first');
    const to = email(req.body.email || c.email) || fail(400, 'Type an email address');
    const p = await publicSchedule(c.link_token);
    const { esc } = mail;
    const url = `${publicOrigin(req)}/s#${c.link_token}`;
    const html = `<!doctype html><html><body style="margin:0;background:#f2f2f0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f0;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:10px;padding:24px"><tr><td>
  <div style="font-size:20px;font-weight:700">${esc(p.business_name)}</div>
  <p style="font-size:16px">Hi ${esc(c.name)}, here is your schedule. The link always shows the latest, so you can keep it on your phone.</p>
  <p style="text-align:center;margin:24px 0"><a href="${esc(url)}" style="background:#2f5a2a;color:#fff;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:700;font-size:16px">📅 Open my schedule</a></p>
  <p style="font-size:13px;color:#666">${esc(url)}</p>
</td></tr></table></td></tr></table></body></html>`;
    await mail.sendMail({ fromName: p.business_name, to, subject: `Your schedule from ${p.business_name}`, html,
      text: `Hi ${c.name}, here is your schedule from ${p.business_name}: ${url}` });
    if (!c.email) await pool.query('UPDATE sched_crews SET email=$1 WHERE id=$2', [to, c.id]);
    res.json({ ok: true });
  }));

  return { STATUSES, STATUS_NAME };
};
