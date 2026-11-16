#pragma once

// Copy this file to locker_config.h in the same directory. Never commit that
// private file. The backend DEVICE_API_KEY and this device key must match.
#define LOCKRFLOW_WIFI_SSID "replace-with-wifi-name"
#define LOCKRFLOW_WIFI_PASSWORD "replace-with-wifi-password"
#define LOCKRFLOW_BACKEND_BASE_URL "https://locker.example.com"
#define LOCKRFLOW_DEVICE_API_KEY "replace-with-device-api-key"
#define LOCKRFLOW_LOCKER_ID "replace-with-this-lockers-firestore-lockerId"

// Production must use HTTPS (1) and a real CA certificate for the backend.
// Set to 0 only on an isolated local development network; HTTP exposes the
// API key and OTP and must never be used on a public or production network.
#define LOCKRFLOW_USE_TLS 1

// PEM root/intermediate CA which validates LOCKRFLOW_BACKEND_BASE_URL.
// Leave empty only while using the explicit HTTP development mode above.
static const char LOCKRFLOW_ROOT_CA[] = R"EOF(
-----BEGIN CERTIFICATE-----
replace-with-the-ca-certificate-for-your-backend
-----END CERTIFICATE-----
)EOF";
