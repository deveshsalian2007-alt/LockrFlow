require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { db } = require("./firebase");
const { getAuth } = require("firebase-admin/auth");



async function verifyAgentToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const idToken = authHeader.slice(7);
    const decodedToken = await getAuth().verifyIdToken(idToken);

    if (decodedToken.agent !== true) {
      return res.status(403).json({
        success: false,
        message: "Delivery-agent access required"
      });
    }

    req.authenticatedUser = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token"
    });
  }
}

async function verifyAdminToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const idToken = authHeader.slice(7);
    const decodedToken = await getAuth().verifyIdToken(idToken);

    if (decodedToken.admin !== true) {
      return res.status(403).json({
        success: false,
        message: "Admin access required"
      });
    }

    req.authenticatedUser = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token"
    });
  }
}


const {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  OTP_EXPIRY_MINUTES,
  MAX_ATTEMPTS
} = require("./otp");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// 1. Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "LockrFlow backend is running"
  });
});



// 2. Get locker status from Firestore
app.get("/api/lockers/:lockerId", async (req, res) => {
  try {
    const lockerDoc = await db
      .collection("lockers")
      .doc(req.params.lockerId)
      .get();

    if (!lockerDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Locker not found"
      });
    }

    return res.json(lockerDoc.data());
  } catch (error) {
    console.error("Locker retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve locker"
    });
  }
});


 // Get all lockers for the Admin dashboard
app.get("/api/lockers", async (req, res) => {
  try {
    const snapshot = await db.collection("lockers").get();

    const lockers = snapshot.docs.map((doc) => ({
      ...doc.data(),
      lockerId: doc.data().lockerId || doc.id
    }));

    return res.json({
      success: true,
      count: lockers.length,
      lockers
    });
  } catch (error) {
    console.error("Locker list retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve lockers"
    });
  }
});


// 3. Create a parcel

 // 3. Register an existing tracking ID and reserve a locker
app.post("/api/parcels", verifyAgentToken, async (req, res) => {
  try {
    const trackingId =
      typeof req.body.trackingId === "string"
        ? req.body.trackingId.trim()
        : "";

    const lockerId =
      typeof req.body.lockerId === "string"
        ? req.body.lockerId.trim()
        : "";

    // Validate the tracking ID.
    if (!/^[A-Za-z0-9._-]{3,120}$/.test(trackingId)) {
      return res.status(400).json({
        success: false,
        message:
          "Enter a valid tracking ID (3-120 letters, numbers, dots, underscores or hyphens)."
      });
    }

    if (!lockerId) {
      return res.status(400).json({
        success: false,
        message: "Please select an available locker."
      });
    }

    const parcelRef = db.collection("parcels").doc(trackingId);
    const lockerRef = db.collection("lockers").doc(lockerId);

    const result = await db.runTransaction(async (transaction) => {
      const parcelDoc = await transaction.get(parcelRef);
      const lockerDoc = await transaction.get(lockerRef);

      if (parcelDoc.exists) {
        return { error: "DUPLICATE_TRACKING_ID" };
      }

      if (!lockerDoc.exists) {
        return { error: "LOCKER_NOT_FOUND" };
      }

      const locker = lockerDoc.data();

if (
  locker.parcelStatus !== "empty" ||
  locker.reservedForTrackingId
) {
  return { error: "LOCKER_NOT_EMPTY" };
}
      const parcel = {
        parcelId: trackingId,
        trackingId: trackingId,
        lockerId: lockerId,
        status: "pending_deposit",
        createdAt: new Date().toISOString(),
        createdBy: req.authenticatedUser.uid
      };

      transaction.create(parcelRef, parcel);

      transaction.update(lockerRef, {
        parcelStatus: "reserved",
        reservedForTrackingId: trackingId
      });

      return { parcel };
    });

    if (result.error === "DUPLICATE_TRACKING_ID") {
      return res.status(409).json({
        success: false,
        message: "This tracking ID is already registered."
      });
    }

    if (result.error === "LOCKER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "Locker not found."
      });
    }

    if (result.error === "LOCKER_NOT_EMPTY") {
      return res.status(409).json({
        success: false,
        message:
          "That locker is no longer available. Refresh the locker list and choose another."
      });
    }

    return res.status(201).json({
      success: true,
      message:
        "Tracking ID registered and locker reserved. Deposit is not confirmed yet.",
      parcel: result.parcel
    });
  } catch (error) {
    console.error("Parcel registration error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not register tracking ID."
    });
  }
});


// 4. Get parcel details

 
app.get("/api/parcels/:parcelId", async (req, res) => {
  try {
    const parcelDoc = await db
      .collection("parcels")
      .doc(req.params.parcelId)
      .get();

    if (!parcelDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Parcel not found"
      });
    }

    return res.json({
      success: true,
      parcel: {
        ...parcelDoc.data(),
        parcelId: parcelDoc.data().parcelId || parcelDoc.id
      }
    });
  } catch (error) {
    console.error("Parcel retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve parcel"
    });
  }
});



 // Get all parcels for the Admin dashboard

app.get("/api/parcels", verifyAdminToken, async (req, res) => {
  try {
    const snapshot = await db.collection("parcels").get();

    const parcels = snapshot.docs.map((doc) => ({
      ...doc.data(),
      parcelId: doc.data().parcelId || doc.id
    }));

    return res.json({
      success: true,
      count: parcels.length,
      parcels
    });
  } catch (error) {
    console.error("Parcel list retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve parcels"
    });
  }
});

app.get("/api/parcels/:parcelId", async (req, res) => {
  try {
    const { parcelId } = req.params;
    const parcelDoc = await db.collection("parcels").doc(parcelId).get();

    if (!parcelDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Parcel not found"
      });
    }

    return res.json({
      success: true,
      parcel: {
        ...parcelDoc.data(),
        parcelId: parcelDoc.data().parcelId || parcelDoc.id
      }
    });
  } catch (error) {
    console.error("Parcel retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve parcel"
    });
  }
});

// 5. Generate a pickup OTP

 // 5. Generate a pickup OTP (development mode; no SMS)
app.post("/api/parcels/:parcelId/request-deposit-otp", verifyAgentToken, async (req, res) => {
  try {
    const trackingId = req.params.parcelId;
    const parcelRef = db.collection("parcels").doc(trackingId);
    const parcelDoc = await parcelRef.get();

    if (!parcelDoc.exists) {
      return res.status(404).json({ success: false, message: "Tracking ID is not registered." });
    }

    const parcel = parcelDoc.data();
    if (parcel.status !== "pending_deposit") {
      return res.status(409).json({ success: false, message: "This parcel is not awaiting deposit." });
    }

    const lockerRef = db.collection("lockers").doc(parcel.lockerId);
    const lockerDoc = await lockerRef.get();
    if (
      !lockerDoc.exists ||
      lockerDoc.data().parcelStatus !== "reserved" ||
      lockerDoc.data().reservedForTrackingId !== trackingId
    ) {
      return res.status(409).json({ success: false, message: "The assigned locker is not reserved for this tracking ID." });
    }

    const otp = generateOtp();
    const otpHash = await hashOtp(otp);
    const expiresAt = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;

    await db.collection("otp_records").doc(`${trackingId}_deposit`).set({
      parcelId: trackingId,
      trackingId,
      lockerId: parcel.lockerId,
      purpose: "deposit",
      otpHash,
      expiresAt,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      used: false
    });

    // DEVELOPMENT ONLY: show the OTP in the agent webpage. Do not expose
    // plaintext OTPs from a production server.
    return res.status(201).json({
      success: true,
      message: "Development deposit OTP generated.",
      parcelId: trackingId,
      trackingId,
      lockerId: parcel.lockerId,
      otp,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
      developmentOnly: true
    });
  } catch (error) {
    console.error("Deposit OTP request error:", error.message);
    return res.status(500).json({ success: false, message: "Could not generate deposit OTP." });
  }
});



 // Verify a deposit OTP and authorize the deposit
app.post("/api/parcels/:parcelId/verify-deposit-otp", verifyAgentToken, async (req, res) => {
  try {
    const trackingId = req.params.parcelId;
    const { otp } = req.body;

    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid six-digit OTP."
      });
    }

    const otpRef = db.collection("otp_records").doc(`${trackingId}_deposit`);
    const parcelRef = db.collection("parcels").doc(trackingId);

    const result = await db.runTransaction(async (transaction) => {
      const otpDoc = await transaction.get(otpRef);
      const parcelDoc = await transaction.get(parcelRef);

      if (!otpDoc.exists) return { error: "OTP_NOT_FOUND" };
      if (!parcelDoc.exists) return { error: "PARCEL_NOT_FOUND" };

      const record = otpDoc.data();
      const parcel = parcelDoc.data();

      if (record.purpose !== "deposit") return { error: "WRONG_PURPOSE" };
      if (record.trackingId !== trackingId) return { error: "TRACKING_MISMATCH" };
      if (record.used) return { error: "OTP_USED" };
      if (Date.now() >= record.expiresAt) return { error: "OTP_EXPIRED" };
      if (record.attempts >= record.maxAttempts) return { error: "MAX_ATTEMPTS" };

      if (parcel.status !== "pending_deposit") {
        return { error: "INVALID_PARCEL_STATUS" };
      }

      if (!parcel.lockerId || parcel.lockerId !== record.lockerId) {
        return { error: "LOCKER_MISMATCH" };
      }

      const lockerRef = db.collection("lockers").doc(parcel.lockerId);
      const lockerDoc = await transaction.get(lockerRef);

      if (!lockerDoc.exists) return { error: "LOCKER_NOT_FOUND" };

      const locker = lockerDoc.data();

      if (
        locker.parcelStatus !== "reserved" ||
        locker.reservedForTrackingId !== trackingId
      ) {
        return { error: "LOCKER_NOT_RESERVED" };
      }

      const isCorrect = await verifyOtpHash(otp, record.otpHash);

      if (!isCorrect) {
        transaction.update(otpRef, {
          attempts: record.attempts + 1
        });
        return {
          error: "INCORRECT_OTP",
          attemptsRemaining: record.maxAttempts - record.attempts - 1
        };
      }

      transaction.update(otpRef, {
        used: true,
        verifiedAt: Date.now()
      });

      transaction.update(parcelRef, {
        status: "deposit_authorized",
        depositAuthorizedAt: new Date().toISOString()
      });

      transaction.update(lockerRef, {
        depositAuthorized: true
      });

      return { success: true };
    });

    const errors = {
      OTP_NOT_FOUND: [404, "Deposit OTP not found. Request a new OTP."],
      PARCEL_NOT_FOUND: [404, "Tracking ID is not registered."],
      WRONG_PURPOSE: [409, "This OTP is not for parcel deposit."],
      TRACKING_MISMATCH: [409, "OTP does not match this tracking ID."],
      OTP_USED: [409, "This OTP has already been used."],
      OTP_EXPIRED: [410, "OTP expired. Request a new one."],
      MAX_ATTEMPTS: [429, "Maximum OTP attempts reached."],
      INVALID_PARCEL_STATUS: [409, "Parcel is not awaiting deposit."],
      LOCKER_MISMATCH: [409, "OTP locker does not match the parcel locker."],
      LOCKER_NOT_FOUND: [404, "Assigned locker not found."],
      LOCKER_NOT_RESERVED: [409, "Locker is not reserved for this tracking ID."]
    };

    if (result.error === "INCORRECT_OTP") {
      return res.status(401).json({
        success: false,
        message: "Incorrect OTP.",
        attemptsRemaining: result.attemptsRemaining
      });
    }

    if (result.error && errors[result.error]) {
      return res.status(errors[result.error][0]).json({
        success: false,
        message: errors[result.error][1]
      });
    }

    return res.status(200).json({
      success: true,
      message: "Deposit authorized. Physical deposit is not yet confirmed.",
      trackingId,
      lockerId: result.lockerId || undefined,
      status: "deposit_authorized"
    });
  } catch (error) {
    console.error("Deposit OTP verification error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not verify deposit OTP."
    });
  }
});

// 6. Verify a pickup OTP
app.post("/api/parcels/:parcelId/verify-otp", async (req, res) => {
  try {
    const parcelId = req.params.parcelId;
    const { otp } = req.body;

    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid six-digit OTP"
      });
    }

    const otpRef = db.collection("otp_records").doc(parcelId);



    const otpDoc = await otpRef.get();

    if (!otpDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "No OTP found. Please request a new OTP."
      });
    }

    const record = otpDoc.data();

    if (record.used) {
      return res.status(409).json({
        success: false,
        message: "This OTP has already been used"
      });
    }

    if (Date.now() >= record.expiresAt) {
      return res.status(410).json({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    if (record.attempts >= record.maxAttempts) {
      return res.status(429).json({
        success: false,
        message: "Maximum attempts reached. Request a new OTP."
      });
    }

    const isCorrect = await verifyOtpHash(otp, record.otpHash);

    // Recheck the record in a transaction before changing it.

    // Atomically verify the OTP and update the parcel and locker.
    const result = await db.runTransaction(async (transaction) => {
      const latestDoc = await transaction.get(otpRef);

      if (!latestDoc.exists) {
        return { error: "NOT_FOUND" };
      }

      const latest = latestDoc.data();

      if (latest.used) {
        return { error: "USED" };
      }

      if (Date.now() >= latest.expiresAt) {
        return { error: "EXPIRED" };
      }

      if (latest.attempts >= latest.maxAttempts) {
        return { error: "MAX_ATTEMPTS" };
      }

      if (latest.otpHash !== record.otpHash) {
        return { error: "OTP_CHANGED" };
      }

      if (!isCorrect) {
        transaction.update(otpRef, {
          attempts: latest.attempts + 1
        });

        return {
          error: "INCORRECT",
          attemptsRemaining: latest.maxAttempts - latest.attempts - 1
        };
      }

      const parcelRef = db.collection("parcels").doc(parcelId);
      const parcelDoc = await transaction.get(parcelRef);

      if (!parcelDoc.exists) {
        return { error: "PARCEL_NOT_FOUND" };
      }

      const parcel = parcelDoc.data();

      if (parcel.status === "collected") {
        return { error: "ALREADY_COLLECTED" };
      }

      if (parcel.status !== "stored") {
        return { error: "INVALID_PARCEL_STATUS" };
      }

      if (!parcel.lockerId) {
        return { error: "LOCKER_ID_MISSING" };
      }

      const lockerRef = db.collection("lockers").doc(parcel.lockerId);
      const lockerDoc = await transaction.get(lockerRef);

      if (!lockerDoc.exists) {
        return { error: "LOCKER_NOT_FOUND" };
      }

      const locker = lockerDoc.data();

      // Do not mark a locker available if it is already assigned
      // to a different parcel or is in an unexpected state.
      if (locker.parcelStatus !== "occupied") {
        return { error: "LOCKER_NOT_OCCUPIED" };
      }

      transaction.update(otpRef, {
  used: true,
  verifiedAt: Date.now()
});

// OTP verification authorizes pickup, but does not prove
// that the physical parcel has been collected.
transaction.update(parcelRef, {
  status: "pickup_authorized",
  pickupAuthorizedAt: new Date().toISOString()
});

transaction.update(lockerRef, {
  pickupAuthorized: true
});

return { success: true };
    });


    if (result.error === "NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "OTP record not found"
      });
    }

    
    if (result.error === "PARCEL_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "Parcel not found"
      });
    }

    if (result.error === "ALREADY_COLLECTED") {
      return res.status(409).json({
        success: false,
        message: "This parcel has already been collected"
      });
    }

    if (result.error === "INVALID_PARCEL_STATUS") {
      return res.status(409).json({
        success: false,
        message: "Parcel is not available for collection"
      });
    }

    if (result.error === "LOCKER_ID_MISSING") {
      return res.status(409).json({
        success: false,
        message: "Parcel has no assigned locker"
      });
    }

    if (result.error === "LOCKER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "Assigned locker not found"
      });
    }

    if (result.error === "LOCKER_NOT_OCCUPIED") {
      return res.status(409).json({
        success: false,
        message: "Assigned locker is not marked occupied"
      });
    }


    if (result.error === "USED") {
      return res.status(409).json({
        success: false,
        message: "This OTP has already been used"
      });
    }

    if (result.error === "EXPIRED") {
      return res.status(410).json({
        success: false,
        message: "OTP has expired. Please request a new one."
      });
    }

    if (result.error === "MAX_ATTEMPTS") {
      return res.status(429).json({
        success: false,
        message: "Maximum attempts reached. Request a new OTP."
      });
    }

    if (result.error === "OTP_CHANGED") {
      return res.status(409).json({
        success: false,
        message: "OTP changed. Please use the latest OTP."
      });
    }

    if (result.error === "INCORRECT") {
      return res.status(401).json({
        success: false,
        message: "Incorrect OTP",
        attemptsRemaining: result.attemptsRemaining
      });
    }

    return res.status(200).json({
  success: true,
  message: "Pickup authorized. Please collect the parcel from the assigned locker.",
  parcelId,
  status: "pickup_authorized"
});
  } catch (error) {
    console.error("OTP verification error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not verify OTP"
    });
  }
});

// Start server
const PORT = 3000;

app.listen(PORT, () => {
  console.log(`LockrFlow server running on port ${PORT}`);
});
