require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// --- DATABASE CONNECTION (Required for Vercel) ---
const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
};

// Define Schema
const OrderSchema = new mongoose.Schema({
  orderId: String,
  paymentId: String,
  amount: Number,
  status: { type: String, default: "PENDING" }, // PENDING, SUCCESS
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// --- MIDDLEWARE ---
// Capture Raw Body for Webhook Verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cors());

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- ROUTE 1: Default (Test if server is running) ---
app.get('/', (req, res) => {
  res.send('Razorpay Payment Server is Running on Vercel!');
});

// --- ROUTE 2: Create Payment Link ---
app.post('/api/create-payment', async (req, res) => {
  await connectDB();
  const { amount, description } = req.body;

  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: amount * 100,
      currency: "INR",
      description: description || "App Payment",
      customer: { name: "User", contact: "+919000090000" },
      notify: { sms: false, email: false },
      callback_url: "https://your-vercel-app.vercel.app/success", // Optional
    });

    // Save to MongoDB
    await Order.create({
      orderId: paymentLink.id,
      amount: amount,
      status: "PENDING"
    });

    res.json({
      id: paymentLink.id,
      url: paymentLink.short_url,
      status: "PENDING"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ROUTE 3: Check Status ---
app.get('/api/check-status/:id', async (req, res) => {
  await connectDB();
  const order = await Order.findOne({ orderId: req.params.id });
  
  if (!order) return res.status(404).json({ status: "NOT_FOUND" });
  res.json({ status: order.status });
});

// --- ROUTE 4: Webhook ---
app.post('/api/webhook', async (req, res) => {
  await connectDB();
  const secret = process.env.WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];

  // Verify Signature
  const shasum = crypto.createHmac('sha256', secret);
  shasum.update(req.rawBody);
  const digest = shasum.digest('hex');

  if (digest === signature) {
    const event = req.body.event;
    const payload = req.body.payload;

    if (event === 'payment_link.paid') {
      const plinkId = payload.payment_link.entity.id;
      // Update MongoDB
      await Order.findOneAndUpdate(
        { orderId: plinkId },
        { status: "SUCCESS" }
      );
      console.log(`Payment Verified: ${plinkId}`);
    }
    res.json({ status: 'ok' });
  } else {
    res.status(400).json({ status: 'invalid_signature' });
  }
});

// Export for Vercel (Do not use app.listen)
module.exports = app;