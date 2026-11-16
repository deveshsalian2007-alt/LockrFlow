const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { hashOtp } = require("../otp");
const { registerDeviceRoutes } = require("../device-api");

function fakeDb(seed) {
  const data = new Map(Object.entries(seed));
  const key = ref => `${ref.collection}/${ref.id}`;
  const doc = (collection, id) => ({ collection, id });
  return {
    collection(collection) { return { doc: id => doc(collection, id) }; },
    async runTransaction(callback) {
      const transaction = {
        async get(ref) {
          const value = data.get(key(ref));
          return { exists: value !== undefined, data: () => value && structuredClone(value) };
        },
        update(ref, changes) {
          const current = data.get(key(ref));
          if (current === undefined) throw new Error("missing document");
          data.set(key(ref), { ...current, ...structuredClone(changes) });
        }
      };
      return callback(transaction);
    },
    read(collection, id) { return data.get(`${collection}/${id}`); }
  };
}

async function start(seed) {
  const app = express();
  app.use(express.json());
  const db = fakeDb(seed);
  registerDeviceRoutes(app, { db, deviceApiKey: "test-device-secret" });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    async request(path, body, key = "test-device-secret") {
      const response = await fetch(url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key === null ? {} : { "X-Device-Api-Key": key }) },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    },
    async close() { await new Promise(resolve => server.close(resolve)); }
  };
}

async function seed({ purpose = "deposit", otp = "123456", expiresAt = Date.now() + 60_000, used = false, status, lockerStatus } = {}) {
  const trackingId = "TRACK-1";
  const lockerId = "LOCKER-1";
  return {
    "parcels/TRACK-1": { trackingId, parcelId: trackingId, lockerId, status: status || (purpose === "deposit" ? "pending_deposit" : "stored") },
    "lockers/LOCKER-1": { lockerId, parcelStatus: lockerStatus || (purpose === "deposit" ? "reserved" : "occupied"), reservedForTrackingId: trackingId },
    [`otp_records/${purpose === "deposit" ? `${trackingId}_deposit` : trackingId}`]: {
      trackingId, parcelId: trackingId, lockerId, purpose, otpHash: await hashOtp(otp),
      expiresAt, attempts: 0, maxAttempts: 5, used
    }
  };
}

test("device API rejects missing and invalid device credentials", async () => {
  const api = await start(await seed());
  try {
    const body = { trackingId: "TRACK-1", lockerId: "LOCKER-1", otp: "123456" };
    assert.equal((await api.request("/api/device/deposit/verify", body, null)).status, 401);
    assert.equal((await api.request("/api/device/deposit/verify", body, "wrong-secret")).status, 401);
  } finally { await api.close(); }
});

test("wrong, expired, and reused OTPs never authorize access", async () => {
  const body = { trackingId: "TRACK-1", lockerId: "LOCKER-1", otp: "123456" };
  const wrong = await start(await seed());
  try {
    const response = await wrong.request("/api/device/deposit/verify", { ...body, otp: "999999" });
    assert.equal(response.status, 401); assert.equal(response.body.authorized, false);
    assert.equal(wrong.db.read("otp_records", "TRACK-1_deposit").attempts, 1);
  } finally { await wrong.close(); }
  const expired = await start(await seed({ expiresAt: Date.now() - 1 }));
  try { assert.equal((await expired.request("/api/device/deposit/verify", body)).status, 410); } finally { await expired.close(); }
  const reused = await start(await seed({ used: true }));
  try { assert.equal((await reused.request("/api/device/deposit/verify", body)).status, 409); } finally { await reused.close(); }
});

test("device API rejects a wrong tracking ID, locker, or state", async () => {
  const api = await start(await seed());
  try {
    assert.equal((await api.request("/api/device/deposit/verify", { trackingId: "OTHER-1", lockerId: "LOCKER-1", otp: "123456" })).status, 404);
    assert.equal((await api.request("/api/device/deposit/verify", { trackingId: "TRACK-1", lockerId: "OTHER-1", otp: "123456" })).status, 409);
  } finally { await api.close(); }
  const badState = await start(await seed({ lockerStatus: "occupied" }));
  try { assert.equal((await badState.request("/api/device/deposit/verify", { trackingId: "TRACK-1", lockerId: "LOCKER-1", otp: "123456" })).status, 409); } finally { await badState.close(); }
});

test("valid deposit and pickup require physical confirmation for final state", async () => {
  const deposit = await start(await seed());
  const body = { trackingId: "TRACK-1", lockerId: "LOCKER-1", otp: "123456" };
  try {
    const verified = await deposit.request("/api/device/deposit/verify", body);
    assert.deepEqual(verified.body, { success: true, authorized: true, operation: "deposit" });
    assert.equal(deposit.db.read("parcels", "TRACK-1").status, "deposit_authorized");
    assert.equal((await deposit.request("/api/device/deposit/confirm", { ...body, doorState: "closed" })).body.confirmed, true);
    assert.equal(deposit.db.read("parcels", "TRACK-1").status, "stored");
    assert.equal(deposit.db.read("lockers", "LOCKER-1").parcelStatus, "occupied");
    const retry = await deposit.request("/api/device/deposit/confirm", { ...body, doorState: "closed" });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.alreadyConfirmed, true);
  } finally { await deposit.close(); }

  const pickup = await start(await seed({ purpose: "pickup" }));
  try {
    assert.equal((await pickup.request("/api/device/pickup/verify", body)).body.authorized, true);
    assert.equal(pickup.db.read("parcels", "TRACK-1").status, "pickup_authorized");
    assert.equal((await pickup.request("/api/device/pickup/confirm", { ...body, doorState: "closed" })).body.confirmed, true);
    assert.equal(pickup.db.read("parcels", "TRACK-1").status, "collected");
    assert.equal(pickup.db.read("lockers", "LOCKER-1").parcelStatus, "empty");
    const retry = await pickup.request("/api/device/pickup/confirm", { ...body, doorState: "closed" });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.alreadyConfirmed, true);
  } finally { await pickup.close(); }
});
