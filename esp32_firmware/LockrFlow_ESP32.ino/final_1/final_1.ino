
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <string.h>
#include "locker_config.h"
#include "ApiResponse.h"

// ==================== PIN CONFIGURATION ====================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C

#define SERVO_PIN 14
#define BUZZER_PIN 33

const int LOCKED_ANGLE = 120;
const int UNLOCKED_ANGLE = 0;

const unsigned long UNLOCK_TIMEOUT_MS = 15000UL;
const unsigned long MULTITAP_WINDOW_MS = 800UL;
const unsigned long WIFI_RETRY_MS = 15000UL;

// ==================== HARDWARE OBJECTS ====================

Adafruit_SSD1306 display(
  SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET
);

Servo lockServo;

bool oledReady = false;
bool servoReady = false;
bool isUnlocked = false;

// Keypad layout and pins
const byte ROWS = 4;
const byte COLS = 4;

char keys[ROWS][COLS] = {
  {'D', 'C', 'B', 'A'},
  {'#', '9', '6', '3'},
  {'0', '8', '5', '2'},
  {'*', '7', '4', '1'}
};

byte rowPins[ROWS] = {16, 17, 18, 19};
byte colPins[COLS] = {23, 25, 26, 32};

Keypad keypad = Keypad(
  makeKeymap(keys), rowPins, colPins, ROWS, COLS
);

// ==================== OPERATION STATES ====================

enum Operation {
  NO_OPERATION,
  DEPOSIT,
  PICKUP
};

enum InputState {
  SELECT_OPERATION,
  ENTER_TRACKING,
  ENTER_OTP,
  WAIT_FOR_DOOR,
  CONFIRMATION_PENDING
};

Operation operation = NO_OPERATION;
InputState inputState = SELECT_OPERATION;

String trackingId = "";
String otp = "";

char pendingKey = 0;
uint8_t pendingIndex = 0;

unsigned long pendingKeyAt = 0;
unsigned long lastWiFiAttemptAt = 0;
unsigned long unlockStartedAt = 0;

bool unlockTimerActive = false;
bool timeoutHandled = false;
bool confirmationPending = false;
bool lastHomeWifiConnected = false;

// ==================== OLED DISPLAY ====================

void showScreen(
  const String &a,
  const String &b = "",
  const String &c = "",
  const String &d = ""
) {
  if (!oledReady) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);
  display.println("LOCKRFLOW");

  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  display.setCursor(0, 18);
  display.println(a);

  display.setCursor(0, 31);
  display.println(b);

  display.setCursor(0, 43);
  display.println(c);

  display.setCursor(0, 55);
  display.println(d);

  display.display();
}

// ==================== BUZZER ====================

void beep(int durationMs) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(durationMs);
  digitalWrite(BUZZER_PIN, LOW);
}

void successBeep() {
  beep(120);
}

void deniedBeep() {
  beep(100);
  delay(100);
  beep(100);
}

// ==================== SERVO CONTROL ====================

// Commands the servo to lock.
// Does not clear the timeout completion flag.
void lockServoOnly() {
  if (!servoReady) {
    Serial.println("ERROR: Servo is not attached");
    return;
  }

  lockServo.write(LOCKED_ANGLE);
  isUnlocked = false;

  Serial.println("SERVO COMMAND: LOCKED - 0 degrees");
}

// Opens the servo and starts a fresh 15-second timer.
bool unlockServoOnly() {
  if (!servoReady) {
    Serial.println("ERROR: Servo is not attached");
    showScreen("SERVO ERROR", "Check servo wiring");
    return false;
  }

  // Reset the previous timer state.
  timeoutHandled = false;
  unlockTimerActive = false;

  // Command the servo to unlock.
  lockServo.write(UNLOCKED_ANGLE);
  isUnlocked = true;

  // Start timing immediately after the unlock command.
  unlockStartedAt = millis();
  unlockTimerActive = true;

 Serial.println("SERVO COMMAND: UNLOCKED - 120 degrees");
  Serial.println("15-second timer started");

  successBeep();
  return true;
}

// Called continuously from loop().
// No other timer or sensor controls automatic relocking.
void checkUnlockTimeout() {
  if (!unlockTimerActive || timeoutHandled) {
    return;
  }

  unsigned long elapsed = millis() - unlockStartedAt;

  if (elapsed < UNLOCK_TIMEOUT_MS) {
    return;
  }

  // Mark the timeout before commanding the servo.
  timeoutHandled = true;
  unlockTimerActive = false;

  Serial.println("15 seconds elapsed");
  Serial.println("Commanding servo to LOCKED - 0 degrees");

  lockServoOnly();

  // Keep the operation and tracking ID for manual confirmation.
  if (inputState == WAIT_FOR_DOOR) {
    showScreen(
      "SERVO RELocked",
      "Check physical door",
      "Press C to confirm",
      "Backend not updated"
    );
  }
}

// ==================== OPERATION HELPERS ====================

const char *operationName() {
  return operation == DEPOSIT ? "deposit" : "pickup";
}

const char *multiTapChars(char key) {
  switch (key) {
    case '0': return "0";
    case '1': return "1.-_";
    case '2': return "ABC2";
    case '3': return "DEF3";
    case '4': return "GHI4";
    case '5': return "JKL5";
    case '6': return "MNO6";
    case '7': return "PQRS7";
    case '8': return "TUV8";
    case '9': return "WXYZ9";
    default: return "";
  }
}

char pendingCharacter() {
  if (!pendingKey) return 0;

  const char *chars = multiTapChars(pendingKey);
  size_t count = strlen(chars);

  if (count == 0) return 0;

  return chars[pendingIndex % count];
}

void commitPendingCharacter() {
  if (!pendingKey) return;

  if (trackingId.length() < 120) {
    trackingId += pendingCharacter();
  }

  pendingKey = 0;
  pendingIndex = 0;
}

void showHomeScreen() {
  showScreen(
    "A: deposit B: pickup",
    "Select operation",
    WiFi.status() == WL_CONNECTED
      ? "Wi-Fi connected"
      : "Wi-Fi unavailable"
  );
}

void showTrackingScreen() {
  String value = trackingId;

  if (pendingKey) {
    value += pendingCharacter();
  }

  showScreen(
    String(operationName()) + " tracking ID",
    value,
    "Multi-tap letters",
    "*=delete #=next"
  );
}

void showOtpScreen() {
  String masked = "";

  for (unsigned int i = 0; i < otp.length(); i++) {
    masked += '*';
  }

  showScreen(
    String(operationName()) + " OTP",
    "Code: " + masked,
    "Enter 6 digits",
    "*=delete #=verify"
  );
}

void clearOperation() {
  trackingId = "";
  otp = "";

  pendingKey = 0;
  pendingIndex = 0;

  confirmationPending = false;
  unlockTimerActive = false;
  unlockStartedAt = 0;
  timeoutHandled = false;

  operation = NO_OPERATION;
  inputState = SELECT_OPERATION;
}

void lockAndReturnHome() {
  lockServoOnly();
  clearOperation();
  showHomeScreen();
}

// ==================== WI-FI ====================

bool connectWiFi(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  WiFi.begin(
    LOCKRFLOW_WIFI_SSID,
    LOCKRFLOW_WIFI_PASSWORD
  );

  unsigned long startedAt = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startedAt < timeoutMs
  ) {
    delay(100);
  }

  return WiFi.status() == WL_CONNECTED;
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  if (millis() - lastWiFiAttemptAt < WIFI_RETRY_MS) {
    return;
  }

  lastWiFiAttemptAt = millis();

  Serial.println("Wi-Fi disconnected; retrying");

  WiFi.disconnect(false, false);
  delay(100);

  WiFi.begin(
    LOCKRFLOW_WIFI_SSID,
    LOCKRFLOW_WIFI_PASSWORD
  );
}

// ==================== BACKEND API ====================


ApiResponse postJson(
  const char *path,
  const String &payload
) {
  ApiResponse response = {
    false, 0, false, false, false, ""
  };

  if (!connectWiFi(7000)) {
    Serial.println("API ERROR: Wi-Fi unavailable");
    return response;
  }

  String url =
    String(LOCKRFLOW_BACKEND_BASE_URL) + path;

  HTTPClient http;

#if LOCKRFLOW_USE_TLS

  if (
    !url.startsWith("https://") ||
    strlen(LOCKRFLOW_ROOT_CA) == 0
  ) {
    Serial.println("API ERROR: TLS configuration invalid");
    return response;
  }

  WiFiClientSecure client;
  client.setCACert(LOCKRFLOW_ROOT_CA);

  if (!http.begin(client, url)) {
    Serial.println("API ERROR: HTTPS initialization failed");
    return response;
  }

#else

  if (!url.startsWith("http://")) {
    Serial.println("API ERROR: Expected HTTP development URL");
    return response;
  }

  WiFiClient client;

  if (!http.begin(client, url)) {
    Serial.println("API ERROR: HTTP initialization failed");
    return response;
  }

#endif

  http.setConnectTimeout(7000);
  http.setTimeout(7000);

  http.addHeader("Content-Type", "application/json");
  http.addHeader(
    "X-Device-Api-Key",
    LOCKRFLOW_DEVICE_API_KEY
  );

  Serial.print("POST ");
  Serial.println(path);

  response.statusCode = http.POST(payload);

  Serial.print("HTTP status: ");
  Serial.println(response.statusCode);

  if (response.statusCode <= 0) {
    Serial.print("HTTP error: ");
    Serial.println(
      http.errorToString(response.statusCode)
    );

    http.end();
    return response;
  }

  String body = http.getString();
  http.end();

  Serial.print("Backend response: ");
  Serial.println(body);

  DynamicJsonDocument json(1024);

  DeserializationError jsonError =
    deserializeJson(json, body);

  if (jsonError) {
    Serial.print("API JSON error: ");
    Serial.println(jsonError.c_str());
    return response;
  }

  response.transportOk = true;
  response.success = json["success"] == true;
  response.authorized = json["authorized"] == true;
  response.confirmed = json["confirmed"] == true;

  response.returnedOperation =
    (const char *)(json["operation"] | "");

  return response;
}

bool expectedOperation(const ApiResponse &response) {
  return response.returnedOperation == operationName();
}

// ==================== OTP VERIFICATION ====================

void verifyOtpWithBackend() {
  showScreen(
    "VERIFYING OTP",
    operationName(),
    "Please wait"
  );

  String path =
    operation == DEPOSIT
      ? "/api/device/deposit/verify"
      : "/api/device/pickup/verify";

  String payload =
    "{\"trackingId\":\"" + trackingId +
    "\",\"lockerId\":\"" +
    String(LOCKRFLOW_LOCKER_ID) +
    "\",\"otp\":\"" + otp + "\"}";

  ApiResponse response = postJson(
    path.c_str(),
    payload
  );

  // Do not retain the OTP after verification.
  otp = "";

  if (
    response.transportOk &&
    response.statusCode == 200 &&
    response.success &&
    response.authorized &&
    expectedOperation(response)
  ) {
    Serial.println("Backend authorized access");

    if (!unlockServoOnly()) {
      inputState = ENTER_OTP;
      showScreen("SERVO ERROR", "Access not opened");
      return;
    }

    confirmationPending = false;
    inputState = WAIT_FOR_DOOR;

    showScreen(
      "ACCESS GRANTED",
      operationName(),
      "Wait 15 seconds",
      "Then close/check door"
    );

    return;
  }

  Serial.println("Authorization rejected");

  deniedBeep();
  inputState = ENTER_OTP;

  if (!response.transportOk) {
    showScreen(
      "NETWORK ERROR",
      "No authorization",
      "Check server/Wi-Fi",
      "Re-enter OTP"
    );
  } else {
    showScreen(
      "ACCESS DENIED",
      "HTTP " + String(response.statusCode),
      "Check OTP/backend",
      "Try again"
    );
  }
}

// ==================== MANUAL CONFIRMATION ====================

void attemptConfirmation() {
  if (!confirmationPending) {
    return;
  }

  // Safety guard: never confirm before the 15-second
  // servo timer has completed.
  if (!timeoutHandled || isUnlocked || unlockTimerActive) {
    Serial.println(
      "Confirmation blocked: 15-second timer not complete"
    );

    showScreen(
      "PLEASE WAIT",
      "Servo timer active",
      "C not accepted yet"
    );

    return;
  }

  showScreen(
    "CONFIRMING",
    operationName(),
    "Contacting backend"
  );

  String path =
    operation == DEPOSIT
      ? "/api/device/deposit/confirm"
      : "/api/device/pickup/confirm";

  String payload =
    "{\"trackingId\":\"" + trackingId +
    "\",\"lockerId\":\"" +
    String(LOCKRFLOW_LOCKER_ID) +
    "\",\"doorState\":\"closed\"}";

  ApiResponse response = postJson(
    path.c_str(),
    payload
  );

  if (
    response.transportOk &&
    response.statusCode == 200 &&
    response.success &&
    response.confirmed &&
    expectedOperation(response)
  ) {
    Serial.println("Backend confirmed operation");

    confirmationPending = false;

    showScreen(
      operation == DEPOSIT
        ? "DEPOSIT CONFIRMED"
        : "PICKUP CONFIRMED",
      "Backend updated"
    );

    successBeep();
    delay(1000);

    lockAndReturnHome();
    return;
  }

  // Do not clear the tracking ID or operation.
  // The user can press C again to retry.
  Serial.println(
    "Confirmation failed; press C to retry"
  );

  inputState = CONFIRMATION_PENDING;

  showScreen(
    "CONFIRM FAILED",
    "HTTP " + String(response.statusCode),
    "Press C to retry",
    "Keep door closed"
  );
}

// ==================== TRACKING ID INPUT ====================

void handleTrackingKey(char key) {
  if (key == '*') {
    if (pendingKey) {
      pendingKey = 0;
      pendingIndex = 0;
    } else if (trackingId.length() > 0) {
      trackingId.remove(trackingId.length() - 1);
    }

    showTrackingScreen();
    return;
  }

  if (key == '#') {
    commitPendingCharacter();

    if (trackingId.length() < 3) {
      showScreen(
        "TRACK ID TOO SHORT",
        "Minimum 3 characters"
      );

      deniedBeep();
      showTrackingScreen();
      return;
    }

    Serial.print("Tracking ID entered: ");
    Serial.println(trackingId);

    inputState = ENTER_OTP;
    showOtpScreen();
    return;
  }

  if (key < '0' || key > '9') return;

  const char *chars = multiTapChars(key);
  size_t count = strlen(chars);

  if (count == 0) return;

  if (
    pendingKey == key &&
    millis() - pendingKeyAt < MULTITAP_WINDOW_MS
  ) {
    pendingIndex = (pendingIndex + 1) % count;
  } else {
    commitPendingCharacter();
    pendingKey = key;
    pendingIndex = 0;
  }

  pendingKeyAt = millis();
  showTrackingScreen();
}

// ==================== KEYPAD PROCESSING ====================

void processKey(char key) {
  Serial.print("Key pressed: ");
  Serial.println(key);

  // After a failed confirmation, C retries the API request.
  if (inputState == CONFIRMATION_PENDING) {
    if (key == 'C') {
      attemptConfirmation();
    }
    return;
  }

  // C is accepted only after the 15-second timer has
  // completed and the servo has been commanded to lock.
  if (inputState == WAIT_FOR_DOOR && key == 'C') {
    if (!timeoutHandled || isUnlocked || unlockTimerActive) {
      Serial.println(
        "C ignored: wait for the full 15-second timer"
      );

      showScreen(
        "PLEASE WAIT",
        "Servo timer active",
        "C not accepted yet"
      );

      return;
    }

    Serial.println(
      "Manual door-close confirmation requested"
    );

    confirmationPending = true;
    inputState = CONFIRMATION_PENDING;

    attemptConfirmation();
    return;
  }

  if (inputState == SELECT_OPERATION) {
    if (key == 'A' || key == 'B') {
      operation = key == 'A' ? DEPOSIT : PICKUP;

      trackingId = "";
      otp = "";
      pendingKey = 0;
      pendingIndex = 0;

      inputState = ENTER_TRACKING;
      showTrackingScreen();
    }

    return;
  }

  if (inputState == ENTER_TRACKING) {
    handleTrackingKey(key);
    return;
  }

  if (inputState == ENTER_OTP) {
    if (key == '*') {
      if (otp.length() > 0) {
        otp.remove(otp.length() - 1);
        showOtpScreen();
      } else {
        inputState = ENTER_TRACKING;
        showTrackingScreen();
      }

      return;
    }

    if (key == '#') {
      if (otp.length() == 6) {
        verifyOtpWithBackend();
      } else {
        showScreen(
          "OTP MUST BE 6",
          "Enter all digits"
        );

        deniedBeep();
        showOtpScreen();
      }

      return;
    }

    if (
      key >= '0' &&
      key <= '9' &&
      otp.length() < 6
    ) {
      otp += key;
      showOtpScreen();
    }
  }
}

// ==================== SETUP ====================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("================================");
  Serial.println("       LOCKRFLOW SYSTEM");
  Serial.println("================================");

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Initialize OLED.
  Wire.begin(21, 22);

  oledReady = display.begin(
    SSD1306_SWITCHCAPVCC,
    OLED_ADDR
  );

  Serial.println(
    oledReady
      ? "OLED initialized"
      : "WARNING: OLED not detected"
  );

  // Initialize servo and command locked position once
  // during startup. The 15-second timer begins only
  // after successful OTP verification.
  lockServo.setPeriodHertz(50);
  lockServo.attach(SERVO_PIN, 500, 2400);

  servoReady = lockServo.attached();

  if (servoReady) {
    Serial.println("Servo attached successfully");

    lockServo.write(LOCKED_ANGLE);
    isUnlocked = false;
  } else {
    Serial.println("ERROR: Servo attach failed");
  }

  keypad.setDebounceTime(50);

  // Initialize Wi-Fi.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  showScreen(
    "SYSTEM STARTING",
    "Connecting Wi-Fi"
  );

  lastWiFiAttemptAt = millis();

  if (connectWiFi(20000)) {
    Serial.println("Wi-Fi connected");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.print("Wi-Fi connection failed. Status: ");
    Serial.println((int)WiFi.status());
  }

  showHomeScreen();
  lastHomeWifiConnected =
    (WiFi.status() == WL_CONNECTED);

  Serial.println("System ready");
  Serial.println("A = deposit, B = pickup");
  Serial.println("Servo opens for 15 seconds after OTP approval");
  Serial.println("C confirms only after automatic relocking");
}

// ==================== MAIN LOOP ====================

void loop() {
  maintainWiFi();

  bool wifiConnected =
    (WiFi.status() == WL_CONNECTED);

  if (
    inputState == SELECT_OPERATION &&
    !confirmationPending &&
    wifiConnected != lastHomeWifiConnected
  ) {
    showHomeScreen();
    lastHomeWifiConnected = wifiConnected;
  }

  // This runs continuously and does not use any door sensor.
  checkUnlockTimeout();

  char key = keypad.getKey();

  if (key) {
    processKey(key);
  }

  delay(10);
}
