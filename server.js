
const express = require("express");
const cors = require("cors");
const { db } = require("./firebase");


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

// 3. Create a parcel
app.post("/api/parcels", async (req, res) => {
  try {
    const { recipientName, lockerId } = req.body;

    if (
      typeof recipientName !== "string" ||
      !recipientName.trim() ||
      typeof lockerId !== "string" ||
      !lockerId.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "recipientName and lockerId are required"
      });
    }

    const lockerRef = db.collection("lockers").doc(lockerId);
    const parcelRef = db.collection("parcels").doc();

    const result = await db.runTransaction(async (transaction) => {
      const lockerDoc = await transaction.get(lockerRef);

      if (!lockerDoc.exists) {
        return { error: "NOT_FOUND" };
      }

      if (lockerDoc.data().parcelStatus !== "empty") {
        return { error: "OCCUPIED" };
      }

      const parcel = {
        parcelId: parcelRef.id,
        recipientName: recipientName.trim(),
        lockerId,
        status: "stored",
        createdAt: new Date().toISOString()
      };

      transaction.set(parcelRef, parcel);
      transaction.update(lockerRef, {
        parcelStatus: "occupied"
      });

      return { parcel };
    });

    if (result.error === "NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "Locker not found"
      });
    }

    if (result.error === "OCCUPIED") {
      return res.status(409).json({
        success: false,
        message: "Locker is not empty"
      });
    }

    return res.status(201).json({
      success: true,
      parcel: result.parcel
    });
  } catch (error) {
    console.error("Parcel creation error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not create parcel"
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

    return res.json(parcelDoc.data());
  } catch (error) {
    console.error("Parcel retrieval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve parcel"
    });
  }
});

// 5. Generate a pickup OTP
app.post("/api/parcels/:parcelId/request-otp", async (req, res) => {
  try {
    const parcelId = req.params.parcelId;

    const parcelRef = db.collection("parcels").doc(parcelId);
    const parcelDoc = await parcelRef.get();

    if (!parcelDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Parcel not found"
      });
    }

    if (parcelDoc.data().status !== "stored") {
      return res.status(409).json({
        success: false,
        message: "Parcel is not available for pickup"
      });
    }

    const otp = generateOtp();
    const otpHash = await hashOtp(otp);
    const expiresAt =
      Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;

    await db.collection("otp_records").doc(parcelId).set({
      parcelId,
      otpHash,
      expiresAt,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      used: false
    });

    // Development only. Do not log OTPs in production.
    console.log(`Development OTP for ${parcelId}: ${otp}`);

    return res.status(201).json({
      success: true,
      message: "OTP generated for development testing",
      parcelId,
      expiresInMinutes: OTP_EXPIRY_MINUTES
    });
  } catch (error) {
    console.error("OTP request error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not generate OTP"
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

      // Ensure the OTP did not change during verification.
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

      transaction.update(otpRef, {
        used: true,
        verifiedAt: Date.now()
      });

      return { success: true };
    });

    if (result.error === "NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "OTP record not found"
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
      message: "OTP verified successfully",
      parcelId
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
