# LockrFlow device/backend contract (stage 2)

## Implemented restricted device API

The following endpoints are implemented for a provisioned ESP32. Every request
must include `X-Device-Api-Key: <DEVICE_API_KEY>` and `Content-Type:
application/json`. The backend compares the key in constant time. A missing or
incorrect key receives `401`; no Firebase credentials, authentication tokens,
OTP hashes, or plaintext OTPs are returned.

| Method and path | Request JSON | Success JSON | State transition |
| --- | --- | --- | --- |
| `POST /api/device/deposit/verify` | `trackingId`, `lockerId`, `otp` | `success`, `authorized: true`, `operation: "deposit"` | `pending_deposit` → `deposit_authorized` |
| `POST /api/device/pickup/verify` | `trackingId`, `lockerId`, `otp` | `success`, `authorized: true`, `operation: "pickup"` | `stored` → `pickup_authorized` |
| `POST /api/device/deposit/confirm` | `trackingId`, `lockerId`, `doorState: "closed"` | `success`, `operation: "deposit"`, `confirmed: true` | `deposit_authorized` → `stored`; locker `reserved` → `occupied` |
| `POST /api/device/pickup/confirm` | `trackingId`, `lockerId`, `doorState: "closed"` | `success`, `operation: "pickup"`, `confirmed: true` | `pickup_authorized` → `collected`; locker `occupied` → `empty` |

The verification calls validate the six-digit OTP, scoped OTP `purpose`,
tracking ID, locker ID, expiry, attempt count, single-use state, parcel state,
and locker reservation in a Firestore transaction. Incorrect OTPs increment
the existing OTP record's attempt count. A `200` verification response is the
only response that may cause the firmware to unlock; it is authorization only,
not a claim of physical deposit or collection. The confirmation calls require
the `doorState: "closed"` observation and revalidate authorization and locker
state in a transaction.

`DEVICE_API_KEY` is required in the backend environment. Generate a high
entropy value and provision it outside source control; `.env.example` contains
only a placeholder.

## ESP32 transport and response rules

The active firmware sends only these JSON bodies, with the header
`X-Device-Api-Key` and `Content-Type: application/json`:

```json
{"trackingId":"TRACKING_ID","lockerId":"LOCKER_ID","otp":"123456"}
```

for verification, and:

```json
{"trackingId":"TRACKING_ID","lockerId":"LOCKER_ID","doorState":"closed"}
```

for confirmation. It unlocks only when the response has HTTP status `200` and
all of `success: true`, `authorized: true`, and the expected `operation`
string. It marks a physical operation complete only when the confirmation has
HTTP `200` plus `success: true`, `confirmed: true`, and the expected operation.
Malformed JSON, timeouts, Wi-Fi loss, other status codes, and mismatched JSON
values keep the servo locked or leave the confirmation pending.

Confirmation is idempotent for the exact final parcel and locker state. If a
device loses the response after Firestore commits, it may resend the same
closed-door confirmation; the backend returns `confirmed: true` and
`alreadyConfirmed: true` without changing state again.

The ESP32 source is prepared for hardware integration but has not been
compiled, uploaded, or tested against real hardware in this repository.

This document defines the implemented boundary between a configured ESP32 and
the backend. The four restricted endpoints authorize the local servo action;
they do not provide a portal-facing remote-unlock command.

## Current state

| Area | Status | Evidence |
| --- | --- | --- |
| `GET /api/health` | EXISTING | Reports that the Express process is running. |
| Locker lookup | EXISTING | `GET /api/lockers/:lockerId` reads Firestore. |
| Parcel lookup and OTP records | EXISTING | `server.js` uses `parcels` and `otp_records`. |
| OTP generation, hashing, expiry, attempt limit, single-use | EXISTING | `otp.js` and the verification transaction. |
| User authorization / parcel ownership | NEEDS CHANGE | Public pages explicitly state that authentication is not implemented. |
| Device enrollment and device identity | NEEDS CHANGE | No device records or device credentials exist. |
| ESP32 keypad, OLED, servo, reed switch, Wi-Fi | IMPLEMENTED IN SOURCE | `final_1.ino` performs Wi-Fi/API operations, but remains uncompiled and untested on hardware. |
| Command delivery, acknowledgement, heartbeat, access history | NEEDS CHANGE | No API, schema, or UI support exists. |

## Future transport and authentication

Use HTTPS request/response polling initially, because the existing backend is
Express/HTTP and there is no MQTT broker or persistent socket infrastructure.
The ESP32 must only contact a TLS endpoint whose certificate it validates.
Do not use plain HTTP outside an isolated local development setup.

Each device needs a unique `deviceId` and a high-entropy secret injected during
physical provisioning. The secret is never placed in the frontend, Firestore,
source control, or logs. Store only a server-side verifier/key reference in the
backend's secret manager. Requests carry a timestamp, nonce, and an HMAC over
the canonical request method, path, body hash, timestamp, and nonce. The server
rejects unknown devices, stale timestamps, reused nonces, and invalid MACs.

The stage-1 endpoints use the backend `DEVICE_API_KEY` described above. The
per-device HMAC design remains a future hardening path for device enrollment
and key rotation.

## Future API messages (not implemented in stage 1)

All endpoints below are **PROPOSED**. Their device authentication headers and
response schema must be implemented together; none is currently available.

| Purpose | Endpoint | Request body | Successful response |
| --- | --- | --- | --- |
| Verify keypad OTP | `POST /api/devices/:deviceId/otp-verifications` | `lockerId`, `otp`, `requestId` | a short-lived `unlockCommand` only when the enrolled device, locker, parcel, OTP, and user authorization all match |
| Fetch pending command | `GET /api/devices/:deviceId/commands/next` | none | one unexpired command or `204 No Content` |
| Acknowledge command | `POST /api/devices/:deviceId/command-acks` | `commandId`, `commandNonce`, `result`, `observedAt` | acknowledgement accepted idempotently |
| Door state | `POST /api/devices/:deviceId/door-events` | `lockerId`, `state` (`open`/`closed`), `observedAt`, `eventId` | event accepted idempotently |
| Heartbeat | `POST /api/devices/:deviceId/heartbeats` | firmware version, Wi-Fi signal, uptime, `observedAt`, `eventId` | heartbeat accepted idempotently |
| Access history | `GET /api/lockers/:lockerId/access-events` | authenticated user context | paginated authorized audit records |

`unlockCommand` is a future design to contain `commandId`, `lockerId`,
`issuedAt`, `expiresAt`, `commandNonce`, and a server signature. The device
must verify the signature and intended locker, reject an expired command, and
persist recently accepted command IDs/nonces before actuating. A servo action
is recorded as an attempt, not proof of a closed door. The reed-switch event is
the source of truth for door state.

## Required server-side transaction rules

The OTP verification transaction must, in one consistent operation, re-read
the OTP record, confirm its parcel's locker association and the enrolled device
association, enforce expiry and attempts, consume the OTP, create an immutable
access event, and create at most one short-lived command. Retries for the same
`requestId` must return the prior outcome rather than create another command.

## Security gates before any remote actuation

1. Add real user/agent authentication and parcel authorization.
2. Define device provisioning, secrets, HTTPS certificate handling, and key
   rotation.
3. Add Firestore rules/schema and server-side validation for devices,
   commands, idempotency keys, and audit events.
4. Implement command signing, expiry, and firmware replay storage.
5. Test rejected authentication, expired/reused OTPs, duplicate requests,
   replayed commands, backend timeout, and malformed JSON.
6. Review the implementation before enabling servo control from network input.
