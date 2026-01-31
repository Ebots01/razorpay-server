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
    // Connect to MongoDB Atlas
    cached.promise = mongoose.connect(process.env.MONGODB_URI).then((mongoose) => mongoose);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// Define the Schema for our Payment Records
const OrderSchema = new mongoose.Schema({
  qrId: String,           // The ID of the QR Code
  amount: Number,         // Amount in Rupees
  status: { type: String, default: "PENDING" }, // PENDING or SUCCESS
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// --- 2. MIDDLEWARE ---
// Capture Raw Body for Webhook Signature Verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors());

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- ROUTE 1: Create QR Code (Returns Image URL) ---
app.post('/api/create-payment', async (req, res) => {
  await connectDB();
  const { amount, description } = req.body;

  try {
    // Generate a Single-Use UPI QR Code
    const qrCode = await razorpay.qrCode.create({
      type: "upi_qr",
      name: "App Payment",
      usage: "single_use",       // Expire after 1 payment
      fixed_amount: true,        // User cannot change amount
      payment_amount: amount * 100, // Amount in paise (e.g. 500 = ₹5)
      description: description || "Scan to Pay",
      close_by: Math.floor(Date.now() / 1000) + 300 // Expire in 5 mins
    });

    // Save to MongoDB History
    await Order.create({
      qrId: qrCode.id,
      amount: amount,
      status: "PENDING"
    });

    // Return the Direct Image URL
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

// --- ROUTE 2: Check Status (Polling) ---
app.get('/api/check-status/:id', async (req, res) => {
  await connectDB();
  const order = await Order.findOne({ qrId: req.params.id });
  
  if (!order) return res.status(404).json({ status: "NOT_FOUND" });
  res.json({ status: order.status });
});

// --- ROUTE 3: Get All History (For Dashboard Table) ---
app.get('/api/orders', async (req, res) => {
  await connectDB();
  // Return all orders, newest first
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

// --- ROUTE 4: Webhook (The Automatic Verification) ---
app.post('/api/webhook', async (req, res) => {
  await connectDB();
  const secret = process.env.WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  // Verify Signature
  const shasum = crypto.createHmac('sha256', secret);
  shasum.update(req.rawBody);
  
  if (shasum.digest('hex') === signature) {
    const event = req.body.event;
    const payload = req.body.payload;

    // EVENT: When a QR Code receives money
    if (event === 'qr_code.credited') {
      const qrId = payload.qr_code.entity.id;
      console.log(`✅ Payment Received for QR: ${qrId}`);
      
      // Update Database Status
      await Order.findOneAndUpdate(
        { qrId: qrId },
        { status: "SUCCESS" }
      );
    }
    res.json({ status: 'ok' });
  } else {
    res.status(400).json({ status: 'invalid_signature' });
  }
});

// Export for Vercel
module.exports = app;