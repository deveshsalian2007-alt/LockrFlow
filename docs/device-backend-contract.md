# LockrFlow device/backend contract (stage 1)

This document defines the boundary between an enrolled ESP32 and the backend.
It is a design and implementation checklist only. No remote unlock endpoint is
enabled by this stage.

## Current state

| Area | Status | Evidence |
| --- | --- | --- |
| `GET /api/health` | EXISTING | Reports that the Express process is running. |
| Locker lookup | EXISTING | `GET /api/lockers/:lockerId` reads Firestore. |
| Parcel lookup and OTP records | EXISTING | `server.js` uses `parcels` and `otp_records`. |
| OTP generation, hashing, expiry, attempt limit, single-use | EXISTING | `otp.js` and the verification transaction. |
| User authorization / parcel ownership | NEEDS CHANGE | Public pages explicitly state that authentication is not implemented. |
| Device enrollment and device identity | NEEDS CHANGE | No device records or device credentials exist. |
| ESP32 keypad, OLED, servo, reed switch, Wi-Fi | NEEDS CHANGE | The only firmware behavior is serial output. |
| Command delivery, acknowledgement, heartbeat, access history | NEEDS CHANGE | No API, schema, or UI support exists. |

## Proposed transport and authentication

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

The provisioning mechanism and production secret store are **PROPOSED** and
must be selected before device endpoints are implemented.

## Proposed API messages

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

`unlockCommand` is **PROPOSED** to contain `commandId`, `lockerId`,
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
