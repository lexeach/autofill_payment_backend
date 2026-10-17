require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '32kb' }));
const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) {
  if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
} }));
const PORT = Number(process.env.PORT || 4242);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRICE_PAISE = 200000;
if (!process.env.MONGODB_URI) console.warn('WARNING: MONGODB_URI is missing. Persistent payment storage is required.');
const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 10000 });
let orders;
let users;
let profiles;
let razorpay;
function gateway() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_ID.includes('replace_me')) throw new Error('Set Razorpay TEST credentials in Render Environment Variables.');
  if (!razorpay) razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return razorpay;
}
async function initDb() {
  await mongoClient.connect();
  const db = mongoClient.db(process.env.MONGODB_DB || 'autofill_payments');
  orders = db.collection('profile_payment_orders');
  users = db.collection('users');
  profiles = db.collection('profiles');
  await users.createIndex({ email: 1 }, { unique: true });
  await profiles.createIndex({ user_id: 1, created_at: -1 });
  await profiles.createIndex({ source_order_id: 1 }, { unique: true, sparse: true });
  await orders.createIndex({ order_id: 1 }, { unique: true });
  await orders.createIndex({ payment_id: 1 }, { unique: true, sparse: true });
  await orders.createIndex({ status: 1, created_at: -1 });
}
function authRequired(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Please login.' });
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(503).json({ error: 'Server authentication is not configured. Set JWT_SECRET (32+ characters).' });
    req.auth = jwt.verify(header.slice(7), secret);
    next();
  } catch (_e) { return res.status(401).json({ error: 'Session expired or invalid. Please login again.' }); }
}
function cleanEmail(value) { return String(value || '').trim().toLowerCase().slice(0, 254); }
app.post('/api/auth/register', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email), password = String(req.body?.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be 10–128 characters.' });
    const password_hash = await bcrypt.hash(password, 12);
    const user = { email, password_hash, created_at: new Date(), active: true };
    const result = await users.insertOne(user);
    const token = jwt.sign({ sub: result.insertedId.toString(), email }, process.env.JWT_SECRET, { expiresIn: '12h', issuer: 'autofill-backend', audience: 'autofill-client' });
    res.status(201).json({ token, user: { id: result.insertedId.toString(), email } });
  } catch (e) { if (e.code === 11000) return res.status(409).json({ error: 'An account with this email already exists.' }); console.error('register failed:', e.message); res.status(500).json({ error: 'Registration failed.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email), password = String(req.body?.password || '');
    const user = await users.findOne({ email, active: true });
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) return res.status(503).json({ error: 'Server authentication is not configured. Contact administrator.' });
    const token = jwt.sign({ sub: user._id.toString(), email }, process.env.JWT_SECRET, { expiresIn: '12h', issuer: 'autofill-backend', audience: 'autofill-client' });
    res.json({ token, user: { id: user._id.toString(), email } });
  } catch (e) { console.error('login failed:', e.message); res.status(500).json({ error: 'Login failed.' }); }
});
app.get('/api/auth/me', authRequired, async (req, res) => { res.json({ user: { id: req.auth.sub, email: req.auth.email } }); });
app.get('/api/profiles', authRequired, async (req, res) => {
  try { const rows = await profiles.find({ user_id: req.auth.sub }).sort({ created_at: -1 }).project({ user_id: 0 }).toArray(); res.json({ profiles: rows.map(x => ({ ...x, id: x._id.toString(), _id: undefined })) }); }
  catch (e) { console.error('list profiles failed:', e.message); res.status(500).json({ error: 'Could not load profiles.' }); }
});
app.post('/api/profiles', authRequired, async (req, res) => {
  // New profiles must be created only by the verified-payment flow below.
  return res.status(402).json({ error: 'Payment required. Start checkout to create a new profile.', code: 'PAYMENT_REQUIRED' });
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const fields = req.body?.fields;
    if (!name) return res.status(400).json({ error: 'Profile name is required.' });
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return res.status(400).json({ error: 'Profile fields must be an object.' });
    if (JSON.stringify(fields).length > 20000) return res.status(413).json({ error: 'Profile data is too large.' });
    const count = await profiles.countDocuments({ user_id: req.auth.sub });
    if (count >= 100) return res.status(403).json({ error: 'Profile limit reached. Contact support.' });
    const doc = { user_id: req.auth.sub, name, fields, created_at: new Date(), updated_at: new Date() };
    const result = await profiles.insertOne(doc); res.status(201).json({ profile: { id: result.insertedId.toString(), name, fields, created_at: doc.created_at } });
  } catch (e) { console.error('create profile failed:', e.message); res.status(500).json({ error: 'Could not save profile.' }); }
});
app.put('/api/profiles/:id', authRequired, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid profile ID.' });
    const name = String(req.body?.name || '').trim().slice(0, 80), fields = req.body?.fields;
    if (!name || !fields || typeof fields !== 'object' || Array.isArray(fields) || JSON.stringify(fields).length > 20000) return res.status(400).json({ error: 'Valid profile name and fields are required.' });
    const result = await profiles.findOneAndUpdate({ _id: new ObjectId(req.params.id), user_id: req.auth.sub }, { $set: { name, fields, updated_at: new Date() } }, { returnDocument: 'after', projection: { user_id: 0 } });
    if (!result) return res.status(404).json({ error: 'Profile not found.' }); const x = result; res.json({ profile: { id: x._id.toString(), name: x.name, fields: x.fields, updated_at: x.updated_at } });
  } catch (e) { console.error('update profile failed:', e.message); res.status(500).json({ error: 'Could not update profile.' }); }
});
app.delete('/api/profiles/:id', authRequired, async (req, res) => {
  try { if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid profile ID.' }); const r = await profiles.deleteOne({ _id: new ObjectId(req.params.id), user_id: req.auth.sub }); if (!r.deletedCount) return res.status(404).json({ error: 'Profile not found.' }); res.json({ ok: true }); }
  catch (e) { console.error('delete profile failed:', e.message); res.status(500).json({ error: 'Could not delete profile.' }); }
});

app.get('/health', async (_req, res) => {
  try { await orders.findOne({}, { projection: { _id: 1 } }); res.json({ ok: true, database: 'connected', databaseType: 'MongoDB', mode: 'test-setup', pricePaise: PRICE_PAISE }); }
  catch (_e) { res.status(503).json({ ok: false, database: 'disconnected', databaseType: 'MongoDB' }); }
});
app.post('/api/create-order', authRequired, async (req, res) => {
  try {
    const name = String(req.body?.profileName || req.body?.name || '').trim().slice(0, 80);
    const fields = req.body?.fields;
    const amount = Number(req.body?.amount);
    if (!name) return res.status(400).json({ error: 'Profile name is required.' });
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return res.status(400).json({ error: 'Profile fields are required.' });
    if (JSON.stringify(fields).length > 20000) return res.status(413).json({ error: 'Profile data is too large.' });
    if (amount !== PRICE_PAISE) return res.status(400).json({ error: 'Profile price must be ₹2,000.' });
    const count = await profiles.countDocuments({ user_id: req.auth.sub });
    if (count >= 100) return res.status(403).json({ error: 'Profile limit reached. Contact support.' });
    const rp = gateway();
    const order = await rp.orders.create({ amount: PRICE_PAISE, currency: 'INR', receipt: `profile_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, notes: { purpose: 'new-profile', profileName: name, userId: req.auth.sub } });
    await orders.insertOne({ order_id: order.id, user_id: req.auth.sub, profile_name: name, profile_fields: fields, amount_paise: PRICE_PAISE, currency: 'INR', status: 'created', created_at: new Date(), paid_at: null, profile_id: null });
    const checkoutUrl = `/checkout/${encodeURIComponent(order.id)}`;
    res.json({ orderId: order.id, checkoutUrl: `${PUBLIC_BASE_URL}${checkoutUrl}`, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) { console.error('create-order failed:', e.message); res.status(500).json({ error: 'Could not create payment order. Check backend logs and configuration.' }); }
});
app.get('/checkout/:orderId', async (req, res) => {
  try {
    const record = await orders.findOne({ order_id: String(req.params.orderId) }, { projection: { order_id: 1, profile_name: 1, amount_paise: 1, status: 1 } });
    if (!record) return res.status(404).send('Order not found. Create a new payment attempt from the extension.');
    if (record.status === 'paid') return res.type('html').send('<!doctype html><meta charset="utf-8"><h2>Payment already verified</h2><p>Return to Chrome and reopen the extension.</p>');
    let keyId;
    try { gateway(); keyId = process.env.RAZORPAY_KEY_ID; } catch (e) { return res.status(500).send(e.message); }
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay ₹2,000</title><style>body{font:16px system-ui;background:#f4f7fb;color:#152238;display:grid;place-items:center;min-height:95vh;margin:0}.card{background:white;padding:28px;border-radius:16px;box-shadow:0 8px 30px #172b4d18;max-width:420px;width:calc(100% - 64px)}button{background:#087f5b;color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:700;cursor:pointer;width:100%}.muted{color:#64748b;font-size:13px}</style></head><body><main class="card"><h1>Unlock new profile</h1><p>One-time profile fee</p><h2>₹2,000</h2><p class="muted">Razorpay TEST MODE. Use test payment credentials/cards only; no real money should be charged in test mode.</p><button id="pay">Continue to payment</button><p id="status" role="status"></p></main><script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>
const options={key:${JSON.stringify(keyId)},amount:${record.amount_paise},currency:'INR',name:'Multi-Dataset Autofill',description:'One new profile',order_id:${JSON.stringify(record.order_id)},handler:async function(r){document.getElementById('status').textContent='Verifying payment…';try{const res=await fetch('/api/verify-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:r.razorpay_order_id,payment_id:r.razorpay_payment_id,signature:r.razorpay_signature})});const data=await res.json();document.getElementById('status').textContent=res.ok?'Payment verified. Return to Chrome and reopen the extension to activate the profile.':(data.error||'Verification failed.');}catch(e){document.getElementById('status').textContent='Could not verify payment. Keep this page open and contact support.'}},modal:{ondismiss:function(){document.getElementById('status').textContent='Checkout closed. No profile is activated until payment is verified.'}}};
document.getElementById('pay').onclick=()=>new Razorpay(options).open();</script></body></html>`);
  } catch (e) { console.error('checkout failed:', e.message); res.status(500).send('Could not load checkout. Please retry.'); }
});
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body || {};
    if (!order_id || !payment_id || !signature) return res.status(400).json({ error: 'Missing payment verification fields.' });
    const orderId = String(order_id), paymentId = String(payment_id), sig = String(signature);
    const record = await orders.findOne({ order_id: orderId });
    if (!record) return res.status(404).json({ error: 'Order not found. Please contact support before paying again.' });
    if (!record.user_id || !record.profile_name || !record.profile_fields) return res.status(409).json({ error: 'This legacy order is not linked to a profile account. Contact support before retrying.' });
    if (record.status === 'paid' && record.payment_id !== paymentId) return res.status(409).json({ error: 'This order was already paid with a different payment. Contact support.' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Payment signature verification failed.' });
    const rpPayment = await gateway().payments.fetch(paymentId);
    if (rpPayment.order_id !== orderId || Number(rpPayment.amount) !== Number(record.amount_paise) || rpPayment.currency !== 'INR' || rpPayment.status !== 'captured') {
      return res.status(400).json({ error: 'Razorpay payment details do not match this order or payment is not authorized.' });
    }
    // Atomic update prevents two concurrent callbacks from activating different payments for the same order.
    const updated = await orders.updateOne(
      { order_id: orderId, status: { $ne: 'paid' } },
      { $set: { status: 'paid', payment_id: paymentId, paid_at: new Date() } }
    );
    if (updated.modifiedCount === 0) {
      const latest = await orders.findOne({ order_id: orderId });
      if (!(latest?.status === 'paid' && latest.payment_id === paymentId)) return res.status(409).json({ error: 'This order was already paid with a different payment. Contact support.' });
    }
    // Create exactly one profile from the fields attached to this user's paid order.
    // source_order_id uniqueness makes retries safe and prevents duplicate profiles.
    let profile = await profiles.findOne({ source_order_id: orderId, user_id: record.user_id });
    if (!profile) {
      const profileDoc = { user_id: record.user_id, source_order_id: orderId, name: record.profile_name, fields: record.profile_fields || {}, created_at: new Date(), updated_at: new Date() };
      try {
        const inserted = await profiles.insertOne(profileDoc);
        profile = { ...profileDoc, _id: inserted.insertedId };
      } catch (insertError) {
        if (insertError.code !== 11000) throw insertError;
        profile = await profiles.findOne({ source_order_id: orderId, user_id: record.user_id });
      }
    }
    await orders.updateOne({ order_id: orderId, user_id: record.user_id }, { $set: { profile_id: profile?._id?.toString() || null } });
    res.json({ ok: true, status: 'paid', orderId, profile: profile ? { id: profile._id.toString(), name: profile.name } : undefined });
  } catch (e) {
    console.error('verify-payment failed:', e.message);
    res.status(500).json({ error: 'Payment verification could not complete. Do not pay again; retry verification or contact support.' });
  }
});
app.get('/api/payment-status/:orderId', authRequired, async (req, res) => {
  try {
    const record = await orders.findOne({ order_id: String(req.params.orderId), user_id: req.auth.sub }, { projection: { order_id: 1, status: 1, profile_id: 1 } });
    if (!record) return res.status(404).json({ status: 'unknown', error: 'Order not found in persistent database.' });
    res.json({ orderId: record.order_id, status: record.status, profileId: record.profile_id || null });
  } catch (e) { console.error('payment-status failed:', e.message); res.status(500).json({ error: 'Could not check payment status.' }); }
});
(async () => {
  try { await initDb(); app.listen(PORT, () => console.log(`Payment backend listening on port ${PORT}; persistent MongoDB connected.`)); }
  catch (e) { console.error('Database initialization failed:', e.message); process.exit(1); }
})();
