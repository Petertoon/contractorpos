// Job files: PDFs (plans, blueprints, specs) and photos attached to a job, plus
// "Estimate with Claude": sends a PDF or photo to Claude, which reads it and returns a materials list.
// The estimate is saved on the job (next to the file it came from), and lines from it can be added to the job ticket.
//
// Server settings (Render > Environment):
//   ANTHROPIC_API_KEY   from console.anthropic.com > API keys (turns on "Estimate with Claude")
//   CLAUDE_MODEL        optional; defaults to claude-sonnet-5-5
const express = require('express');

const MAX_BYTES = 20 * 1024 * 1024; // per file
const TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'photo', 'image/png': 'photo', 'image/webp': 'photo' };
const DAILY_ESTIMATES = Number(process.env.CLAUDE_DAILY_LIMIT || 40); // per business, to keep the API bill predictable
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const API = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

module.exports = function setupJobFiles(app, { pool, wrap, fail, text, notify, log, J }) {
  const isManager = (u) => ['admin', 'owner', 'manager'].includes(u.role);
  async function jobOf(req) {
    const r = await pool.query('SELECT id, job_number, name, description, job_address FROM jobs WHERE id=$1 AND business_id=$2',
      [req.params.id, req.user.business_id]);
    return r.rows[0] || fail(404, 'Job not found');
  }
  const FILE_COLS = `f.id, f.job_id, f.kind, f.name, f.mime, f.size_bytes, f.estimate, f.source_file_id, f.created_at, u.name AS created_by_name`;

  app.get('/api/jobs/:id/files', ...J, wrap(async (req, res) => {
    const job = await jobOf(req);
    const r = await pool.query(`SELECT ${FILE_COLS} FROM job_files f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.job_id=$1 ORDER BY f.created_at DESC, f.id DESC`, [job.id]);
    res.json(r.rows);
  }));

  // Upload: the file itself is the request body (Content-Type tells what it is); its name comes in ?name=
  app.post('/api/jobs/:id/files', ...J, express.raw({ type: Object.keys(TYPES), limit: MAX_BYTES }), wrap(async (req, res) => {
    const job = await jobOf(req);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const kind = TYPES[mime] || fail(400, 'Only PDF files and photos (JPEG, PNG, WebP) can be attached');
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) fail(400, 'The file was empty');
    if (kind === 'pdf' && body.subarray(0, 5).toString() !== '%PDF-') fail(400, 'That file is not a PDF');
    const name = (text(req.query.name, 'File name', { required: false, max: 140 }) || (kind === 'pdf' ? 'Plans.pdf' : 'Photo.jpg'))
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ');
    const n = await pool.query('SELECT count(*)::int AS n FROM job_files WHERE job_id=$1', [job.id]);
    if (n.rows[0].n >= 200) fail(400, 'This job already has 200 files');
    const r = await pool.query(
      `INSERT INTO job_files (job_id, business_id, kind, name, mime, data, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [job.id, req.user.business_id, kind, name, mime, body, body.length, req.user.id]);
    await log(pool, job.id, req.user, `Attached ${kind === 'pdf' ? 'PDF' : 'photo'}: ${name}`);
    notify(req.user.business_id, { type: 'job', id: job.id });
    res.json({ id: r.rows[0].id, kind, name });
  }));

  // Opens the file in the browser (PDF viewer / image).
  app.get('/api/jobs/:id/files/:fid', ...J, wrap(async (req, res) => {
    const job = await jobOf(req);
    const r = await pool.query(`SELECT name, mime, data FROM job_files WHERE id=$1 AND job_id=$2 AND data IS NOT NULL`, [req.params.fid, job.id]);
    const f = r.rows[0] || fail(404, 'File not found');
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(f.name)}"` });
    res.send(f.data);
  }));

  app.delete('/api/jobs/:id/files/:fid', ...J, wrap(async (req, res) => {
    const job = await jobOf(req);
    const r = await pool.query('SELECT id, name, kind, created_by FROM job_files WHERE id=$1 AND job_id=$2', [req.params.fid, job.id]);
    const f = r.rows[0] || fail(404, 'File not found');
    if (!isManager(req.user) && f.created_by !== req.user.id) fail(403, 'Only an owner or manager can remove files someone else added');
    await pool.query('DELETE FROM job_files WHERE id=$1', [f.id]);
    await log(pool, job.id, req.user, `Removed ${f.kind === 'estimate' ? 'estimate' : 'file'}: ${f.name}`);
    notify(req.user.business_id, { type: 'job', id: job.id });
    res.json({ ok: true });
  }));

  // ---------- Estimate with Claude ----------
  const PROMPT = (job, notes, productNames) => `You are helping a contractor estimate materials for a job.
Job: #${job.job_number} ${job.name}${job.description ? ` — ${job.description}` : ''}${job.job_address ? ` (site: ${job.job_address})` : ''}
${notes ? `What the contractor wants estimated: ${notes}\n` : ''}
Read the attached plan, blueprint, drawing or photo. Work out the building materials needed, using the dimensions and notes shown.
Round quantities up to whole purchasable units (pieces, sheets, bags, boxes, rolls, linear feet, etc.) and include a normal waste factor, saying which in the notes.
If something can't be read or measured, make a reasonable assumption and list it under "assumptions"; list anything the contractor should confirm under "questions".
${productNames.length ? `The contractor's store carries these products. When a material matches one, use the product's exact name:\n${productNames.join('\n')}\n` : ''}
Reply with JSON only (no other text), in exactly this shape:
{"summary": "one or two sentences on what was estimated",
 "materials": [{"name": "2x4x8 SPF stud", "qty": 120, "unit": "pieces", "category": "Framing", "notes": "16 in. on center, 10% waste"}],
 "assumptions": ["..."],
 "questions": ["..."]}`;

  function parseEstimate(textOut) {
    const s = String(textOut || '');
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Claude did not return a materials list. Try again, or add a note about what to estimate.');
    let j;
    try { j = JSON.parse(s.slice(start, end + 1)); } catch (e) { throw new Error('Claude\'s answer could not be read. Try again.'); }
    const str = (v, max) => String(v ?? '').trim().slice(0, max);
    const materials = (Array.isArray(j.materials) ? j.materials : []).slice(0, 200).map((m) => ({
      name: str(m && m.name, 120), qty: Math.max(0, Math.round(Number(m && m.qty) * 100) / 100) || 0,
      unit: str(m && m.unit, 30), category: str(m && m.category, 40), notes: str(m && m.notes, 300),
    })).filter((m) => m.name);
    return { summary: str(j.summary, 1000), materials,
      assumptions: (Array.isArray(j.assumptions) ? j.assumptions : []).slice(0, 30).map((x) => str(x, 300)).filter(Boolean),
      questions: (Array.isArray(j.questions) ? j.questions : []).slice(0, 30).map((x) => str(x, 300)).filter(Boolean) };
  }

  async function askClaude(file, job, notes, productNames) {
    const block = file.kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: file.mime, data: file.data.toString('base64') } };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 240000);
    let r;
    try {
      r = await fetch(`${API}/v1/messages`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 16000,
          messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT(job, notes, productNames) }] }] }),
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Claude took too long to answer. Try a smaller file or fewer pages.' : 'Could not reach Claude. Try again in a minute.');
    } finally { clearTimeout(timer); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && data.error.message) || `error ${r.status}`;
      if (r.status === 401) throw new Error('The Claude API key is not valid. Check ANTHROPIC_API_KEY in Render.');
      if (r.status === 429 || r.status === 529) throw new Error('Claude is busy right now. Try again in a minute.');
      throw new Error('Claude could not read this file: ' + msg);
    }
    const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { ...parseEstimate(out), usage: data.usage || null, model: data.model || MODEL };
  }

  app.post('/api/jobs/:id/files/:fid/estimate', ...J, wrap(async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) fail(400, 'Estimating with Claude is not set up yet. The platform administrator needs to add ANTHROPIC_API_KEY in Render → Environment.');
    const job = await jobOf(req);
    const r = await pool.query(`SELECT id, kind, name, mime, data FROM job_files WHERE id=$1 AND job_id=$2`, [req.params.fid, job.id]);
    const file = r.rows[0] || fail(404, 'File not found');
    if (!['pdf', 'photo'].includes(file.kind)) fail(400, 'Choose a PDF or a photo to estimate from');
    if (file.kind === 'photo' && file.data.length > 3.7 * 1024 * 1024) fail(400, 'That photo is too large for Claude (about 3.7 MB max). Retake it or attach it again.');
    const used = await pool.query(
      `SELECT count(*)::int AS n FROM job_files WHERE business_id=$1 AND kind='estimate' AND created_at > now() - interval '1 day'`, [req.user.business_id]);
    if (used.rows[0].n >= DAILY_ESTIMATES) fail(429, `This business has used its ${DAILY_ESTIMATES} Claude estimates for today. Try again tomorrow.`);
    const notes = text(req.body.notes, 'Notes', { required: false, max: 1000 });
    const prods = await pool.query(`SELECT name FROM products WHERE business_id=$1 AND active AND NOT is_rental ORDER BY name LIMIT 400`, [req.user.business_id]);
    let est;
    try { est = await askClaude(file, job, notes, prods.rows.map((p) => p.name)); } catch (e) { fail(502, e.message); }
    if (!est.materials.length) fail(502, 'Claude did not find any materials in this file. Add a note about what to estimate and try again.');
    est.notes = notes || null;
    est.source_name = file.name;
    const name = `Materials estimate — ${file.name}`.slice(0, 140);
    const ins = await pool.query(
      `INSERT INTO job_files (job_id, business_id, kind, name, mime, size_bytes, estimate, source_file_id, created_by)
       VALUES ($1,$2,'estimate',$3,'application/json',0,$4,$5,$6) RETURNING id`,
      [job.id, req.user.business_id, name, JSON.stringify(est), file.id, req.user.id]);
    await log(pool, job.id, req.user, `Claude estimated materials from ${file.name}: ${est.materials.length} line(s)`);
    notify(req.user.business_id, { type: 'job', id: job.id });
    res.json({ id: ins.rows[0].id, name, estimate: est });
  }));
};
