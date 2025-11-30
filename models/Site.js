const mongoose = require('mongoose');

const siteSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  size_bytes: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'deleted'],
    default: 'active'
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

// Create index on slug for faster queries
siteSchema.index({ slug: 1 });
siteSchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('Site', siteSchema);
