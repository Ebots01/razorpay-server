require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// --- 1. DATABASE CONNECTION (Cached for Vercel) ---
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGODB_URI).then((mongoose) => mongoose);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// --- 2. UPDATED SCHEMA ---
// Added paymentId to track the actual transaction reference
const OrderSchema = new mongoose.Schema({
  qrId: { type: String, required: true, unique: true },
  amount: Number,
  status: { type: String, default: "PENDING" }, // PENDING, SUCCESS, FAILED
  paymentId: { type: String, default: null },   // Stores Razorpay Payment ID (pay_...)
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// --- 3. MIDDLEWARE (Crucial for Webhook Security) ---
// We need the 'rawBody' to verify the signature accurately.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cors());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- ROUTE 1: Create QR Code ---
app.post('/api/create-payment', async (req, res) => {
  await connectDB();
  const { amount } = req.body;

  // Safety: Validate amount
  if (!amount || amount < 1) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  try {
    // Docs: "fixed_amount: true" ensures user cannot change price
    const qrCode = await razorpay.qrCode.create({
      type: "upi_qr",
      name: "Flutter App Payment",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: amount * 100, // Razorpay expects amount in paise (1 INR = 100 paise)
      description: "App Transaction",
      close_by: Math.floor(Date.now() / 1000) + 300 // Expires in 5 minutes
    });

    // Save to MongoDB immediately
    await Order.create({
      qrId: qrCode.id,
      amount: amount,
      status: "PENDING"
    });

    res.json({
      id: qrCode.id,
      imageUrl: qrCode.image_url,
      status: "PENDING"
    });

  } catch (error) {
    console.error("Razorpay Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROUTE 2: Check Status (Low Load Polling) ---
// App calls this. We check MONGODB, NOT Razorpay API.
app.get('/api/check-status/:id', async (req, res) => {
  await connectDB();
  const order = await Order.findOne({ qrId: req.params.id });
  
  if (!order) return res.status(404).json({ status: "NOT_FOUND" });
  
  res.json({ 
    status: order.status,
    paymentId: order.paymentId 
  });
});

// --- ROUTE 3: Transaction History ---
app.get('/api/orders', async (req, res) => {
  await connectDB();
  // Limit to last 20 to save bandwidth
  const orders = await Order.find().sort({ createdAt: -1 }).limit(20);
  res.json(orders);
});

// --- ROUTE 4: WEBHOOK (The Core Logic) ---
app.post('/api/webhook', async (req, res) => {
  await connectDB();
  
  const secret = process.env.WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  // 1. Security: Verify Signature
  // Docs: "The hash signature is calculated using HMAC with SHA256 algorithm"
  const shasum = crypto.createHmac('sha256', secret);
  shasum.update(req.rawBody);
  const digest = shasum.digest('hex');

  if (digest === signature) {
    console.log("Webhook verified");
    const event = req.body.event;
    const payload = req.body.payload;

    // 2. Handle 'qr_code.credited'
    // Docs: "Triggered when a payment is made using a QR code."
    if (event === 'qr_code.credited') {
      const qrEntity = payload.qr_code.entity;
      const paymentEntity = payload.payment.entity;

      // Update DB with Success and Payment ID
      await Order.findOneAndUpdate(
        { qrId: qrEntity.id }, 
        { 
          status: "SUCCESS", 
          paymentId: paymentEntity.id // Save the 'pay_...' ID
        }
      );
      console.log(`Order ${qrEntity.id} marked SUCCESS`);
    }

    // 3. Always return 200 OK quickly (within 5 seconds)
    res.json({ status: 'ok' });
  } else {
    // Security Fail
    console.error("Invalid Webhook Signature");
    res.status(400).json({ status: 'invalid_signature' });
  }
});

module.exports = app;