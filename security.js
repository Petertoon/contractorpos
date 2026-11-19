// Security (ContractorPOS v1.17), same rules as MultiPOS v1.15 (see SECURITY-HANDOVER.md):
//  1. Support access codes: the platform admin can only open a business with a one-time 6-digit code from the owner
//     (emailed to the owner's main/backup email, or made by the owner in Settings). Access lasts 4 hours.
//     First 3 days after a business is created ("setup days") no code is needed. Everything is logged for the owner.
//  2. Account recovery: backup email for owners/admins, "Forgot password?" emails a 30-minute one-time link to both,
//     change notices on any password/backup-email change.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendMail, EMAIL_RE, esc } = require('./email');
const emailOk = () => require('./email').configured();

const CODE_MINUTES = 15, CODE_TRIES = 5, CODES_PER_HOUR = 5, ACCESS_HOURS = 4, SETUP_DAYS = 3, RESET_MINUTES = 30;
const hashCode = (c) => crypto.createHash('sha256').update('mp-support:' + c).digest('hex');
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const spaced = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c) : null);

function mailHtml(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f2f2f0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f0;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:10px;padding:24px"><tr><td>
<div style="font-size:20px;font-weight:700;margin-bottom:12px">${esc(title)}</div>${body}
<div style="color:#888;font-size:12px;margin-top:22px">ContractorPOS security notice</div>
</td></tr></table></td></tr></table></body></html>`;
}

module.exports = function security(app, h) {
  const { pool, wrap, fail, text, requireLogin, requireAdmin, requireBusiness, COOKIE, token, publicOrigin } = h;

  // ---------- helpers ----------
  async function supportLog(businessId, user, action) {
    if (!businessId) return;
    await pool.query('INSERT INTO support_access_log (business_id, user_id, user_name, action) VALUES ($1,$2,$3,$4)',
      [businessId, user ? user.id : null, user ? `${user.name}${user.role === 'admin' ? ' (support)' : ''}` : null, String(action).slice(0, 300)]);
  }
  // The business and its first active owner login; in_setup = created within the last 3 days.
  async function ownerOf(businessId) {
    const r = await pool.query(
      `SELECT b.id, b.name, b.created_at, (b.created_at > now() - interval '${SETUP_DAYS} days') AS in_setup,
              u.id AS owner_id, u.name AS owner_name, u.email AS owner_email, u.backup_email AS owner_backup
         FROM businesses b
         LEFT JOIN LATERAL (SELECT id, name, email, backup_email FROM users WHERE business_id = b.id AND role = 'owner' AND active ORDER BY id LIMIT 1) u ON TRUE
        WHERE b.id = $1`, [businessId]);
    return r.rows[0] || fail(404, 'Business not found');
  }
  // Support (platform admin inside a business) can't add logins, change passwords, or change/turn off the owner,
  // except during setup days. Otherwise a helper could give themselves a way back in without a code.
  async function noBackdoor(req, what) {
    if (req.user.role !== 'admin') return;
    const b = await ownerOf(req.user.business_id);
    if (!b.in_setup) fail(403, `For the owner's security, support can't ${what}. Ask the owner to do it.`);
    await supportLog(b.id, req.user, `During setup: ${what}`);
  }
  const realOwner = wrap(async (req, res, next) => { if (req.user.role !== 'owner') fail(403, 'Only the business owner can do this'); next(); });
  async function notice(user, oldBackup, what) {
    if (!emailOk()) return;
    const to = new Set([user.email, user.backup_email, oldBackup].filter(Boolean));
    const when = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
    for (const addr of to) {
      await sendMail({ to: addr, subject: 'Your login was changed', idem: `chg-${user.id}-${Date.now()}-${addr}`,
        text: `${what} for the ContractorPOS login ${user.email} on ${when} (Central).\nIf this was you, you don't need to do anything. If it wasn't, use "Forgot password?" on the sign-in page right away.`,
        html: mailHtml('Your login was changed', `<p>${esc(what)} for the ContractorPOS login <b>${esc(user.email)}</b> on ${esc(when)} (Central).</p>
          <p>If this was you, you don't need to do anything.</p><p><b>If it wasn't you</b>, use <b>Forgot password?</b> on the sign-in page right away.</p>`) })
        .catch((e) => console.error('change notice failed', e.message));
    }
  }
  const cleanBackup = (v, loginEmail) => {
    const b = String(v || '').trim().toLowerCase();
    if (!b) return '';
    if (b.length > 200 || !EMAIL_RE.test(b)) fail(400, 'The backup email is not valid');
    if (b === String(loginEmail).toLowerCase()) fail(400, 'The backup email must be different from your login email');
    return b;
  };

  // ---------- 1. support access ----------
  app.get('/api/admin/access/:id', requireLogin, requireAdmin, wrap(async (req, res) => {
    const b = await ownerOf(req.params.id);
    res.json({ id: b.id, name: b.name, in_setup: b.in_setup, has_owner: !!b.owner_id,
      main: maskEmail(b.owner_email), backup: maskEmail(b.owner_backup), email_ok: emailOk() });
  }));

  app.post('/api/admin/access/:id/send', requireLogin, requireAdmin, wrap(async (req, res) => {
    if (!emailOk()) fail(400, 'Email is not set up on this server. Ask the owner to make a code in Settings → Support access.');
    const b = await ownerOf(req.params.id);
    if (!b.owner_id) fail(400, 'This business has no active owner login');
    const to = ['main', 'backup', 'both'].includes(req.body.to) ? req.body.to : 'main';
    const list = to === 'main' ? [b.owner_email] : to === 'backup' ? [b.owner_backup] : [b.owner_email, b.owner_backup];
    if (list.some((x) => !x)) fail(400, "The owner hasn't added a backup email yet. Send it to the owner's email.");
    const n = await pool.query(`SELECT count(*)::int AS n FROM support_codes WHERE business_id=$1 AND made_by='email' AND created_at > now() - interval '1 hour'`, [b.id]);
    if (n.rows[0].n >= CODES_PER_HOUR) fail(429, 'Too many codes sent in the last hour. Try again later.');
    // A new emailed code replaces older unused emailed codes.
    await pool.query(`UPDATE support_codes SET expires_at = now() WHERE business_id=$1 AND made_by='email' AND used_at IS NULL AND expires_at > now()`, [b.id]);
    const code = newCode();
    await pool.query(`INSERT INTO support_codes (business_id, code_hash, made_by, requested_by, expires_at) VALUES ($1,$2,'email',$3, now() + interval '${CODE_MINUTES} minutes')`,
      [b.id, hashCode(code), req.user.id]);
    for (const addr of list) {
      await sendMail({ to: addr, subject: `Support code for ${b.name}: ${spaced(code)}`, idem: `code-${b.id}-${code}-${addr}`,
        text: `Your ContractorPOS support code is ${spaced(code)}.\nGive it to support only if you asked for help with ${b.name}. It works once, for ${CODE_MINUTES} minutes, and lets support into your account for ${ACCESS_HOURS} hours.\nIf you didn't ask for help, ignore this email. You can see who opened your account in Settings → Support access.`,
        html: mailHtml(`Support code for ${b.name}`, `<div style="font-size:34px;font-weight:800;letter-spacing:6px;text-align:center;margin:10px 0 16px">${spaced(code)}</div>
          <p>Give this code to ContractorPOS support <b>only if you asked for help</b>. It works once, for ${CODE_MINUTES} minutes, and lets support into your account for ${ACCESS_HOURS} hours.</p>
          <p style="color:#666">If you didn't ask for help, ignore this email. You can see who opened your account in Settings → Support access.</p>`) });
    }
    await supportLog(b.id, req.user, `Code emailed to the owner's ${to === 'both' ? 'main and backup email' : to === 'main' ? 'main email' : 'backup email'}`);
    res.json({ ok: true, sent_to: list.map(maskEmail) });
  }));

  app.post('/api/admin/enter/:id', requireLogin, requireAdmin, wrap(async (req, res) => {
    const b = await ownerOf(req.params.id);
    let how;
    if (b.in_setup) how = 'Opened during setup days (no code needed)';
    else {
      const code = String(req.body.code || '').replace(/\D/g, '');
      if (code.length !== 6) fail(400, "Enter the owner's 6-digit code");
      const codes = (await pool.query(`SELECT * FROM support_codes WHERE business_id=$1 AND used_at IS NULL
          AND expires_at > now() AND attempts < ${CODE_TRIES} ORDER BY created_at DESC`, [b.id])).rows;
      const hit = codes.find((x) => x.code_hash === hashCode(code));
      if (!hit) {
        if (codes.length) await pool.query('UPDATE support_codes SET attempts = attempts + 1 WHERE id = ANY($1)', [codes.map((x) => x.id)]);
        await supportLog(b.id, req.user, 'Wrong code entered');
        fail(403, "That code is not right, has been used, or is too old. Ask the owner for a new one.");
      }
      await pool.query('UPDATE support_codes SET used_at = now() WHERE id = $1', [hit.id]);
      how = hit.made_by === 'owner' ? "Opened with the owner's code" : 'Opened with an emailed code';
    }
    const r = await pool.query(`UPDATE sessions SET acting_business_id=$1, acting_until=now() + interval '${ACCESS_HOURS} hours' WHERE token=$2 RETURNING acting_until`,
      [b.id, req.cookies[COOKIE]]);
    await supportLog(b.id, req.user, how);
    res.json({ ok: true, until: r.rows[0] && r.rows[0].acting_until });
  }));

  app.post('/api/admin/exit', requireLogin, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query(`SELECT CASE WHEN acting_until > now() THEN acting_business_id END AS b FROM sessions WHERE token=$1`, [req.cookies[COOKIE]]);
    await pool.query('UPDATE sessions SET acting_business_id = NULL, acting_until = NULL WHERE token = $1', [req.cookies[COOKIE]]);
    if (r.rows[0] && r.rows[0].b) await supportLog(r.rows[0].b, req.user, 'Left the account');
    res.json({ ok: true });
  }));

  // The owner makes a code to read to support over the phone (works without email).
  app.post('/api/support/code', requireLogin, requireBusiness, realOwner, wrap(async (req, res) => {
    const code = newCode();
    await pool.query(`INSERT INTO support_codes (business_id, code_hash, made_by, requested_by, expires_at) VALUES ($1,$2,'owner',$3, now() + interval '${CODE_MINUTES} minutes')`,
      [req.user.business_id, hashCode(code), req.user.id]);
    await supportLog(req.user.business_id, req.user, 'Owner made a code for support');
    res.json({ code: spaced(code), minutes: CODE_MINUTES });
  }));

  app.get('/api/support/log', requireLogin, requireBusiness, wrap(async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) fail(403, 'Only the business owner can see this');
    const r = await pool.query('SELECT created_at, user_name, action FROM support_access_log WHERE business_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50', [req.user.business_id]);
    res.json(r.rows);
  }));

  // ---------- 2. account recovery ----------
  // Change my password and/or backup email. Needs the current password.
  app.post('/api/me/password', requireLogin, wrap(async (req, res) => {
    const u = (await pool.query('SELECT id, name, email, role, backup_email, password_hash, business_id FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) fail(400, 'Current password is wrong');
    const next = String(req.body.password || '');
    if (next && next.length < 8) fail(400, 'New password must be at least 8 characters');
    const backup = 'backup_email' in req.body ? cleanBackup(req.body.backup_email, u.email) : (u.backup_email || '');
    if (['owner', 'admin'].includes(u.role) && !backup) fail(400, 'Owners and administrators must have a backup email');
    const backupChanged = (backup || null) !== (u.backup_email || null);
    if (!next && !backupChanged) fail(400, 'Nothing to change');
    if (next) {
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(next, 10), u.id]);
      await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token <> $2', [u.id, req.cookies[COOKIE]]); // sign out other devices
    }
    if (backupChanged) await pool.query('UPDATE users SET backup_email=$1 WHERE id=$2', [backup || null, u.id]);
    const what = [next && 'The password was changed', backupChanged && `The backup email was ${backup ? 'set to ' + backup : 'removed'}`].filter(Boolean).join('. ');
    await notice({ ...u, backup_email: backup || null }, backupChanged ? u.backup_email : null, what);
    if (u.business_id) await supportLog(u.business_id, u, [next && 'Password changed', backupChanged && 'Backup email changed'].filter(Boolean).join(' and ') + ` (${u.name})`);
    res.json({ ok: true, signed_out_others: !!next });
  }));

  const forgotHits = new Map();
  function forgotRate(key) {
    const now = Date.now();
    const rec = forgotHits.get(key) || { n: 0, t: now };
    if (now - rec.t > 3600 * 1000) { rec.n = 0; rec.t = now; }
    rec.n++; forgotHits.set(key, rec);
    return rec.n <= 5;
  }
  app.post('/api/password/forgot', wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) fail(400, 'Enter your login email');
    const okIp = forgotRate('ip:' + req.ip), okEmail = forgotRate('em:' + email);
    if (!okIp || !okEmail) fail(429, 'Too many reset requests. Try again in an hour.');
    const u = (await pool.query('SELECT id, email, backup_email FROM users WHERE email=$1 AND active', [email])).rows[0];
    if (u && emailOk()) {
      const t = token(24);
      await pool.query('UPDATE password_resets SET used_at = now() WHERE user_id=$1 AND used_at IS NULL', [u.id]); // only the newest link works
      await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '${RESET_MINUTES} minutes')`, [u.id, sha256(t)]);
      const link = `${publicOrigin(req)}/reset#${t}`;
      for (const to of new Set([u.email, u.backup_email].filter(Boolean))) {
        await sendMail({ to, subject: 'Reset your ContractorPOS password', idem: `reset-${u.id}-${t.slice(0, 8)}-${to}`,
          text: `Someone asked to reset the password for ${u.email}.\nOpen this link within ${RESET_MINUTES} minutes to choose a new password (it works once):\n${link}\nIf you didn't ask, ignore this email; your password stays the same.`,
          html: mailHtml('Reset your password', `<p>Someone asked to reset the password for <b>${esc(u.email)}</b>.</p>
            <div style="text-align:center;margin:18px 0"><a href="${esc(link)}" style="display:inline-block;background:#1f8f4e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Choose a new password</a></div>
            <p style="color:#666">The link works once, for ${RESET_MINUTES} minutes. If you didn't ask, ignore this email; your password stays the same.</p>`) })
          .catch((e) => console.error('reset email failed', e.message));
      }
    }
    res.json({ ok: true }); // same answer whether or not the email has a login
  }));

  app.post('/api/password/reset', wrap(async (req, res) => {
    const t = String(req.body.token || '');
    const r = (await pool.query(`SELECT r.id, u.id AS user_id, u.name, u.email, u.role, u.backup_email, u.business_id
        FROM password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > now() AND u.active`, [sha256(t)])).rows[0];
    if (!r) fail(400, 'This reset link has expired or was already used. Ask for a new one on the sign-in page.');
    const next = String(req.body.password || '');
    if (next.length < 8) fail(400, 'Password must be at least 8 characters');
    const backup = cleanBackup(req.body.backup_email, r.email) || r.backup_email || '';
    if (['owner', 'admin'].includes(r.role) && !cleanBackup(req.body.backup_email, r.email)) fail(400, 'Confirm your backup email');
    await pool.query('UPDATE users SET password_hash=$1, backup_email=$2 WHERE id=$3', [await bcrypt.hash(next, 10), backup || null, r.user_id]);
    await pool.query('UPDATE password_resets SET used_at = now() WHERE user_id=$1 AND used_at IS NULL', [r.user_id]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [r.user_id]); // every device signed out
    const backupChanged = (backup || null) !== (r.backup_email || null);
    await notice({ id: r.user_id, email: r.email, backup_email: backup || null }, backupChanged ? r.backup_email : null,
      'The password was reset with a "Forgot password?" link' + (backupChanged ? ` and the backup email was set to ${backup}` : ''));
    if (r.business_id) await supportLog(r.business_id, { id: r.user_id, name: r.name, role: r.role }, `Password reset with an email link (${r.name})`);
    res.json({ ok: true });
  }));

  return { noBackdoor, supportLog, ownerOf };
};
