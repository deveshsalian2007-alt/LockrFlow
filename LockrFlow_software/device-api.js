const crypto = require("crypto");
const { verifyOtpHash } = require("./otp");

const TRACKING_ID_PATTERN = /^[A-Za-z0-9._-]{3,120}$/;
const LOCKER_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

function constantTimeKeyMatches(presentedKey, configuredKey) {
  if (typeof presentedKey !== "string" || typeof configuredKey !== "string") {
    return false;
  }

  const presented = Buffer.from(presentedKey, "utf8");
  const configured = Buffer.from(configuredKey, "utf8");
  if (presented.length !== configured.length) return false;
  return crypto.timingSafeEqual(presented, configured);
}

function deviceAuthentication(deviceApiKey) {
  return (req, res, next) => {
    // Do not reveal whether a key is configured or which part was incorrect.
    if (!constantTimeKeyMatches(req.get("X-Device-Api-Key"), deviceApiKey)) {
      return res.status(401).json({ success: false, message: "Device authentication failed." });
    }
    return next();
  };
}

function validRequest(body) {
  return body &&
    typeof body.trackingId === "string" && TRACKING_ID_PATTERN.test(body.trackingId) &&
    typeof body.lockerId === "string" && LOCKER_ID_PATTERN.test(body.lockerId);
}

function failure(res, error) {
  const status = {
    INVALID_OTP: 401,
    OTP_NOT_FOUND: 404,
    PARCEL_NOT_FOUND: 404,
    OTP_EXPIRED: 410,
    OTP_USED: 409,
    MAX_ATTEMPTS: 429
  }[error] || 409;
  return res.status(status).json({ success: false, authorized: false, message: "Access was not authorized." });
}

function registerDeviceRoutes(app, { db, deviceApiKey = process.env.DEVICE_API_KEY }) {
  if (!db) throw new Error("A Firestore database is required for device routes.");
  const authenticate = deviceAuthentication(deviceApiKey);

  async function verifyAccess(req, res, purpose) {
    if (!validRequest(req.body) || typeof req.body.otp !== "string" || !/^\d{6}$/.test(req.body.otp)) {
      return res.status(400).json({ success: false, authorized: false, message: "Invalid device request." });
    }

    const { trackingId, lockerId, otp } = req.body;
    const otpRef = db.collection("otp_records").doc(
      purpose === "deposit" ? `${trackingId}_deposit` : trackingId
    );
    const parcelRef = db.collection("parcels").doc(trackingId);

    try {
      const result = await db.runTransaction(async transaction => {
        const [otpDoc, parcelDoc] = await Promise.all([
          transaction.get(otpRef), transaction.get(parcelRef)
        ]);
        if (!otpDoc.exists) return { error: "OTP_NOT_FOUND" };
        if (!parcelDoc.exists) return { error: "PARCEL_NOT_FOUND" };

        const record = otpDoc.data();
        const parcel = parcelDoc.data();
        if (record.purpose !== purpose || record.trackingId !== trackingId || record.lockerId !== lockerId) {
          return { error: "OTP_SCOPE_MISMATCH" };
        }
        if (record.used) return { error: "OTP_USED" };
        if (Date.now() >= record.expiresAt) return { error: "OTP_EXPIRED" };
        if (!Number.isInteger(record.attempts) || !Number.isInteger(record.maxAttempts) || record.attempts >= record.maxAttempts) {
          return { error: "MAX_ATTEMPTS" };
        }
        if (parcel.lockerId !== lockerId || parcel.status !== (purpose === "deposit" ? "pending_deposit" : "stored")) {
          return { error: "PARCEL_STATE_MISMATCH" };
        }

        const lockerRef = db.collection("lockers").doc(lockerId);
        const lockerDoc = await transaction.get(lockerRef);
        if (!lockerDoc.exists) return { error: "LOCKER_NOT_FOUND" };
        const locker = lockerDoc.data();
        const expectedLockerState = purpose === "deposit" ? "reserved" : "occupied";
        if (locker.parcelStatus !== expectedLockerState || locker.reservedForTrackingId !== trackingId) {
          return { error: "LOCKER_STATE_MISMATCH" };
        }

        if (!await verifyOtpHash(otp, record.otpHash)) {
          transaction.update(otpRef, { attempts: record.attempts + 1 });
          return { error: "INVALID_OTP" };
        }

        const now = new Date().toISOString();
        transaction.update(otpRef, { used: true, verifiedAt: Date.now() });
        transaction.update(parcelRef, {
          status: purpose === "deposit" ? "deposit_authorized" : "pickup_authorized",
          [purpose === "deposit" ? "depositAuthorizedAt" : "pickupAuthorizedAt"]: now
        });
        transaction.update(lockerRef, { [purpose === "deposit" ? "depositAuthorized" : "pickupAuthorized"]: true });
        return { success: true };
      });

      if (result.error) {
  console.warn("Device verification rejected:", {
    purpose,
    trackingId: req.body.trackingId,
    lockerId: req.body.lockerId,
    reason: result.error
  });

  return failure(res, result.error);
}
      return res.status(200).json({ success: true, authorized: true, operation: purpose });
    } catch (error) {
      console.error("Device OTP verification error:", error.message);
      return res.status(500).json({ success: false, authorized: false, message: "Device verification unavailable." });
    }
  }

  async function confirmPhysicalOperation(req, res, purpose) {
    // The ESP32 may call this only after its reed switch has observed closure.
    if (!validRequest(req.body) || req.body.doorState !== "closed") {
      return res.status(400).json({ success: false, message: "Invalid device request." });
    }
    const { trackingId, lockerId } = req.body;
    const parcelRef = db.collection("parcels").doc(trackingId);
    const lockerRef = db.collection("lockers").doc(lockerId);

    try {
      const result = await db.runTransaction(async transaction => {
        const [parcelDoc, lockerDoc] = await Promise.all([
          transaction.get(parcelRef), transaction.get(lockerRef)
        ]);
        if (!parcelDoc.exists) return { error: "PARCEL_NOT_FOUND" };
        if (!lockerDoc.exists) return { error: "LOCKER_NOT_FOUND" };
        const parcel = parcelDoc.data();
        const locker = lockerDoc.data();
        const authorizedStatus = purpose === "deposit" ? "deposit_authorized" : "pickup_authorized";
        const expectedLockerState = purpose === "deposit" ? "reserved" : "occupied";

        // A response may be lost after Firestore commits. Recognize the exact
        // final state as a no-op success so the closed-door device can safely
        // retry the same confirmation without reopening the locker.
        const finalParcelStatus = purpose === "deposit" ? "stored" : "collected";
        const finalLockerState = purpose === "deposit" ? "occupied" : "empty";
        const finalReservationMatches = purpose === "deposit"
          ? locker.reservedForTrackingId === trackingId
          : locker.reservedForTrackingId === null;
        if (parcel.lockerId === lockerId && parcel.status === finalParcelStatus &&
            locker.parcelStatus === finalLockerState && finalReservationMatches) {
          return { success: true, alreadyConfirmed: true };
        }
        if (parcel.lockerId !== lockerId || parcel.status !== authorizedStatus ||
            locker.parcelStatus !== expectedLockerState || locker.reservedForTrackingId !== trackingId) {
          return { error: "STATE_MISMATCH" };
        }

        const now = new Date().toISOString();
        if (purpose === "deposit") {
          transaction.update(parcelRef, { status: "stored", depositedAt: now });
          transaction.update(lockerRef, { parcelStatus: "occupied", depositAuthorized: false });
        } else {
          transaction.update(parcelRef, { status: "collected", collectedAt: now });
          transaction.update(lockerRef, {
            parcelStatus: "empty",
            reservedForTrackingId: null,
            pickupAuthorized: false
          });
        }
        return { success: true };
      });

      if (result.error) return failure(res, result.error);
      return res.status(200).json({
        success: true,
        operation: purpose,
        confirmed: true,
        ...(result.alreadyConfirmed ? { alreadyConfirmed: true } : {})
      });
    } catch (error) {
      console.error("Device physical confirmation error:", error.message);
      return res.status(500).json({ success: false, message: "Device confirmation unavailable." });
    }
  }

  app.post("/api/device/deposit/verify", authenticate, (req, res) => verifyAccess(req, res, "deposit"));
  app.post("/api/device/pickup/verify", authenticate, (req, res) => verifyAccess(req, res, "pickup"));
  app.post("/api/device/deposit/confirm", authenticate, (req, res) => confirmPhysicalOperation(req, res, "deposit"));
  app.post("/api/device/pickup/confirm", authenticate, (req, res) => confirmPhysicalOperation(req, res, "pickup"));
}

module.exports = { registerDeviceRoutes, constantTimeKeyMatches };
