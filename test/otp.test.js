const test = require("node:test");
const assert = require("node:assert/strict");

const { generateOtp, hashOtp, verifyOtpHash } = require("../otp");

test("generateOtp returns a six-digit value", () => {
  const otp = generateOtp();

  assert.match(otp, /^\d{6}$/);
});

test("a generated hash verifies only its matching OTP", async () => {
  const otp = "123456";
  const hash = await hashOtp(otp);

  assert.equal(await verifyOtpHash(otp, hash), true);
  assert.equal(await verifyOtpHash("654321", hash), false);
});
