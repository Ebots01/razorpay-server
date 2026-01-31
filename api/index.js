require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// --- DATABASE CONNECTION ---
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

const OrderSchema = new mongoose.Schema({
  qrId: String,
  amount: Number,
  status: { type: String, default: "PENDING" },
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// --- MIDDLEWARE ---
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
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

  try {
    const qrCode = await razorpay.qrCode.create({
      type: "upi_qr",
      name: "Test Payment",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: amount * 100, // Converts 1 to 100 paise
      description: "Scan to Pay",
      close_by: Math.floor(Date.now() / 1000) + 300
    });

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
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROUTE 2: Check Status ---
app.get('/api/check-status/:id', async (req, res) => {
  await connectDB();
  const order = await Order.findOne({ qrId: req.params.id });
  if (!order) return res.status(404).json({ status: "NOT_FOUND" });
  res.json({ status: order.status });
});

// --- ROUTE 3: History ---
app.get('/api/orders', async (req, res) => {
  await connectDB();
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

// --- ROUTE 4: Webhook ---
app.post('/api/webhook', async (req, res) => {
  await connectDB();
  const secret = process.env.WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  const shasum = crypto.createHmac('sha256', secret);
  shasum.update(req.rawBody);
  
  if (shasum.digest('hex') === signature) {
    const event = req.body.event;
    const payload = req.body.payload;

    if (event === 'qr_code.credited') {
      const qrId = payload.qr_code.entity.id;
      await Order.findOneAndUpdate({ qrId: qrId }, { status: "SUCCESS" });
    }
    res.json({ status: 'ok' });
  } else {
    res.status(400).json({ status: 'invalid_signature' });
  }
});

module.exports = app;