
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const OTP_EXPIRY_MINUTES = 5;
const MAX_ATTEMPTS = 5;

// Generate a cryptographically random six-digit OTP
function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Hash an OTP before storing it
async function hashOtp(otp) {
  return bcrypt.hash(otp, 10);
}

// Verify a submitted OTP against its hash
async function verifyOtpHash(otp, hash) {
  return bcrypt.compare(otp, hash);
}

module.exports = {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  OTP_EXPIRY_MINUTES,
  MAX_ATTEMPTS
};
