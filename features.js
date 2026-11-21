// Plan levels (v1.23). One place decides what each plan includes; the server checks it (needs) and
// /api/me sends it to the screens (me.can) so they hide what isn't included.
//   Basic    — job board (standard columns), job tickets, customers, products, send/print, files, crews + crew packet,
//              checkout register (cash/card/split), receipts and invoices, sales tax report. Owner + 2 logins, 1 location, 1 register.
//   Standard — + custom board columns/buttons/colors, crew billing (up-charge, cost plus), charge accounts & statements,
//              gift cards, quotes at the register, PO # / job site / delivery / fuel, cash & checks + deposits. Up to 10 logins, several registers.
//   Advanced — + several locations, unlimited logins.
// Add-ons on any plan: Rentals, QuickBooks, Claude, GC (Bid Builder + sub tracking).
const PLANS = ['basic', 'standard', 'advanced'];
const PLAN_NAME = { basic: 'Basic', standard: 'Standard', advanced: 'Advanced' };
const RANK = { basic: 1, standard: 2, advanced: 3 };

// feature -> lowest plan that has it, and how to say it in a message
const FEATURES = {
  workflow:        ['standard', 'Changing the board columns and buttons'],
  crew_billing:    ['standard', 'Billing crews as an up-charge or cost plus'],
  charge_accounts: ['standard', 'Charge accounts and statements'],
  gift_cards:      ['standard', 'Gift cards'],
  register_quotes: ['standard', 'Quotes at the register'],
  sale_extras:     ['standard', 'PO #, job site and pickup/delivery on sales'],
  deposits:        ['standard', 'Cash & checks and bank deposits'],
  multi_register:  ['standard', 'More than one register'],
  multi_location:  ['advanced', 'More than one location'],
};
const LIMITS = {
  users:     { basic: 3, standard: 10, advanced: Infinity },
  registers: { basic: 1, standard: Infinity, advanced: Infinity },
  locations: { basic: 1, standard: 1, advanced: Infinity },
};

const planOf = (b) => (b && RANK[b.plan] ? b.plan : 'advanced'); // businesses from before plans existed keep everything
function can(b) {
  const plan = planOf(b);
  const out = { plan, plan_name: PLAN_NAME[plan] };
  for (const [k, [min]] of Object.entries(FEATURES)) out[k] = RANK[plan] >= RANK[min];
  out.rentals = !!(b && b.rentals_enabled);
  out.qbo = !!(b && b.qbo_enabled);
  out.ai = !!(b && b.ai_enabled);
  out.gc = !!(b && b.gc_enabled);      // GC add-on: Bid Builder + sub tracking (bids, change orders, payments to subs)
  out.subs = out.gc;
  out.calendar = !!(b && b.calendar_enabled); // Crew Calendar add-on
  out.limits = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, Number.isFinite(v[plan]) ? v[plan] : null]));
  return out;
}
const upgradeMsg = (key) => {
  const [min, label] = FEATURES[key];
  return `${label} is part of the ${PLAN_NAME[min]} plan. Ask ContractorPOS to upgrade your plan.`;
};

module.exports = function features({ pool, fail, wrap }) {
  const loadBiz = async (req) => {
    if (!req._biz) req._biz = (await pool.query('SELECT plan, rentals_enabled, qbo_enabled, ai_enabled, gc_enabled, calendar_enabled FROM businesses WHERE id=$1', [req.user.business_id])).rows[0] || {};
    return req._biz;
  };
  // Throws a friendly 403 if the business's plan doesn't include the feature.
  async function check(req, key) {
    const c = can(await loadBiz(req));
    if (key === 'subs' || key === 'gc') { if (!c.gc) fail(403, 'Tracking subs (bids, change orders, payments to subs) is part of the GC add-on. Ask ContractorPOS to turn it on.'); return; }
    if (key === 'calendar') { if (!c.calendar) fail(403, 'The Crew Calendar is an add-on. Ask ContractorPOS to turn it on.'); return; }
    if (!c[key]) fail(403, upgradeMsg(key));
  }
  const needs = (key) => wrap(async (req, res, next) => { await check(req, key); next(); });
  // Count limit (logins, registers, locations) for the plan.
  async function limit(req, what, current) {
    const plan = planOf(await loadBiz(req));
    const max = LIMITS[what][plan];
    if (current >= max) {
      const next = PLANS.find((p) => LIMITS[what][p] > max);
      const word = { users: 'logins', registers: 'registers', locations: 'locations' }[what];
      fail(403, `The ${PLAN_NAME[plan]} plan includes ${max} ${max === 1 ? word.replace(/s$/, '') : word}. ${next ? `The ${PLAN_NAME[next]} plan has more. ` : ''}Ask ContractorPOS to upgrade your plan.`);
    }
  }
  return { can, check, needs, limit, planOf, PLANS, PLAN_NAME };
};
module.exports.can = can;
module.exports.PLANS = PLANS;
module.exports.PLAN_NAME = PLAN_NAME;
