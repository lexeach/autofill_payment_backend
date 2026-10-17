require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json({ limit: '32kb' }));
const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed by CORS')); } }));
const PORT = Number(process.env.PORT || 4242);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRICE_PAISE = 200000;
const orders = new Map(); // Demo/test mode only. Use a persistent database in production.
let razorpay;
function gateway() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_ID.includes('replace_me')) throw new Error('Set Razorpay TEST credentials in payment-backend/.env first.');
  if (!razorpay) razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return razorpay;
}
app.get('/health', (_req, res) => res.json({ ok: true, mode: 'test-setup', pricePaise: PRICE_PAISE }));
app.post('/api/create-order', async (req, res) => {
  try {
    const name = String(req.body?.profileName || '').trim().slice(0, 80);
    const amount = Number(req.body?.amount);
    if (!name) return res.status(400).json({ error: 'Profile name is required.' });
    if (amount !== PRICE_PAISE) return res.status(400).json({ error: 'Profile price must be ₹2,000.' });
    const rp = gateway();
    const order = await rp.orders.create({ amount: PRICE_PAISE, currency: 'INR', receipt: `profile_${Date.now()}`.slice(0, 40), notes: { purpose: 'new-profile', profileName: name } });
    orders.set(order.id, { orderId: order.id, amount: PRICE_PAISE, status: 'created', createdAt: Date.now(), profileName: name });
    const checkoutUrl = `/checkout/${encodeURIComponent(order.id)}`;
    res.json({ orderId: order.id, checkoutUrl: `${PUBLIC_BASE_URL}${checkoutUrl}`, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) { res.status(500).json({ error: e.message || 'Could not create order.' }); }
});
app.get('/checkout/:orderId', (req, res) => {
  const record = orders.get(req.params.orderId);
  if (!record) return res.status(404).send('Order not found. Create a new payment attempt from the extension.');
  let keyId;
  try { gateway(); keyId = process.env.RAZORPAY_KEY_ID; } catch (e) { return res.status(500).send(e.message); }
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay ₹2,000</title><style>body{font:16px system-ui;background:#f4f7fb;color:#152238;display:grid;place-items:center;min-height:95vh;margin:0}.card{background:white;padding:28px;border-radius:16px;box-shadow:0 8px 30px #172b4d18;max-width:420px;width:calc(100% - 64px)}button{background:#087f5b;color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:700;cursor:pointer;width:100%}.muted{color:#64748b;font-size:13px}</style></head><body><main class="card"><h1>Unlock new profile</h1><p>One-time profile fee</p><h2>₹2,000</h2><p class="muted">Razorpay TEST MODE. Use test payment credentials/cards only; no real money should be charged in test mode.</p><button id="pay">Continue to payment</button><p id="status" role="status"></p></main><script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>
const options={key:${JSON.stringify(keyId)},amount:${record.amount},currency:'INR',name:'Multi-Dataset Autofill',description:'One new profile',order_id:${JSON.stringify(record.orderId)},handler:async function(r){document.getElementById('status').textContent='Verifying payment…';try{const res=await fetch('/api/verify-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:r.razorpay_order_id,payment_id:r.razorpay_payment_id,signature:r.razorpay_signature})});const data=await res.json();document.getElementById('status').textContent=res.ok?'Payment verified. Return to Chrome and reopen the extension to activate the profile.':(data.error||'Verification failed.');}catch(e){document.getElementById('status').textContent='Could not verify payment. Keep this page open and contact support.'}},modal:{ondismiss:function(){document.getElementById('status').textContent='Checkout closed. No profile is activated until payment is verified.'}}};
document.getElementById('pay').onclick=()=>new Razorpay(options).open();</script></body></html>`);
});
app.post('/api/verify-payment', (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body || {};
    const record = orders.get(String(order_id || ''));
    if (!record) return res.status(404).json({ error: 'Order not found or server restarted. Please retry payment.' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${order_id}|${payment_id}`).digest('hex');
    const a = Buffer.from(String(signature || '')); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Payment signature verification failed.' });
    record.status = 'paid'; record.paymentId = String(payment_id); record.paidAt = Date.now();
    res.json({ ok: true, status: 'paid' });
  } catch (e) { res.status(500).json({ error: 'Verification error.' }); }
});
app.get('/api/payment-status/:orderId', (req, res) => {
  const record = orders.get(req.params.orderId);
  if (!record) return res.status(404).json({ status: 'unknown', error: 'Order not found. Test backend stores orders in memory.' });
  res.json({ orderId: record.orderId, status: record.status });
});
app.listen(PORT, () => console.log(`Payment backend listening at http://localhost:${PORT} (Razorpay test credentials required)`));
