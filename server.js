/**
 * DRIVMAN Backend — Entry Point
 * ---------------------------------------------------------------------------
 * STATUS: Placeholder only. Per the agreed plan, backend development (Phase 4)
 * begins only after the full frontend (client/) is reviewed and approved.
 *
 * This file is wired enough to confirm your local setup (MongoDB Atlas,
 * Hostinger, npm packages) is working, without yet building real features.
 * When Phase 4 starts, routes/controllers/models will be filled in and
 * mounted here one resource at a time (auth, products, orders, etc.).
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());

// Health check — confirms the server itself is running
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'drivman-backend', phase: 'pre-development (Phase 4 not started)' });
});

// TODO (Phase 4): mount real routes here, one resource at a time, e.g.
// app.use('/api/v1/auth', require('./routes/authRoutes'));
// app.use('/api/v1/products', require('./routes/productRoutes'));
// app.use('/api/v1/orders', require('./routes/orderRoutes'));

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    if (process.env.MONGO_URI && !process.env.MONGO_URI.includes('<db_password>')) {
      await mongoose.connect(process.env.MONGO_URI);
      console.log('MongoDB Atlas connected.');
    } else {
      console.log('MONGO_URI not set yet — skipping DB connection (expected before Phase 4).');
    }
    app.listen(PORT, () => console.log(`DRIVMAN backend placeholder running on port ${PORT}`));
  } catch (err) {
    console.error('Startup error:', err.message);
  }
}

start();
