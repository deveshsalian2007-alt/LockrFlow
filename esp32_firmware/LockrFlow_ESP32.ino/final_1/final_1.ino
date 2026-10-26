
#include <Wire.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "locker_config.h"

// ---------- OLED ----------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C

Adafruit_SSD1306 display(
  SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET
);

bool oledReady = false;

// ---------- PIN ASSIGNMENTS ----------
#define SERVO_PIN 14
#define REED_PIN 27
#define BUZZER_PIN 33

// ---------- LOCK SETTINGS ----------
const int LOCKED_ANGLE = 0;
const int UNLOCKED_ANGLE = 90;
const int MAGNET_NEAR_VALUE = 0;

const unsigned long UNLOCK_TIMEOUT = 15000;

// ---------- KEYPAD ----------
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

// ---------- SERVO ----------
Servo lockServo;
bool servoReady = false;

// ---------- STATE ----------
String enteredPIN = "";

bool isUnlocked = false;
bool authorizedOpening = false;
bool doorWasOpen = false;
bool accessMessageActive = false;

unsigned long unlockStartedAt = 0;
unsigned long accessMessageAt = 0;

// ---------- BUZZER ----------
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

void warningBeep() {
  for (int i = 0; i < 3; i++) {
    beep(120);
    delay(100);
  }
}

// ---------- DOOR SENSOR ----------
bool isDoorClosed() {
  return digitalRead(REED_PIN) == MAGNET_NEAR_VALUE;
}

// ---------- OLED DISPLAY ----------
void showScreen(
  const String &line1,
  const String &line2 = "",
  const String &line3 = "",
  const String &line4 = ""
) {
  if (!oledReady) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);
  display.println("LOCKRFLOW");
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  display.setCursor(0, 18);
  display.println(line1);

  display.setCursor(0, 31);
  display.println(line2);

  display.setCursor(0, 43);
  display.println(line3);

  display.setCursor(0, 55);
  display.println(line4);

  display.display();
}

void showHomeScreen() {
  if (isUnlocked) {
    showScreen(
      "LOCK UNLOCKED",
      "Door: " + String(isDoorClosed() ? "CLOSED" : "OPEN"),
      "Timeout: 15 sec",
      "* Clear PIN"
    );
  } else {
    showScreen(
      "LOCKER LOCKED",
      "Enter PIN:",
      "PIN: " + String(enteredPIN.length(), '*'),
      "* Clear   # Submit"
    );
  }
}

// ---------- LOCK CONTROL ----------
void lockLocker() {
  if (servoReady) {
    lockServo.write(LOCKED_ANGLE);
  } else {
    Serial.println("Cannot lock: servo is not attached.");
    showScreen("SERVO ERROR", "Check connections");
    return;
  }

  isUnlocked = false;
  authorizedOpening = false;
  enteredPIN = "";

  Serial.println("Timeout/lock command: servo set to 0 degrees.");

  showScreen(
    "LOCKER LOCKED",
    "Lock command sent",
    "Door: " + String(isDoorClosed() ? "CLOSED" : "OPEN"),
    "Enter PIN"
  );
}

void unlockLocker() {
  if (!servoReady) {
    Serial.println("Servo is not attached.");
    showScreen("SERVO ERROR", "Check connections");
    return;
  }

  if (!isDoorClosed()) {
    Serial.println("Door is already open.");
    showScreen("DOOR IS OPEN", "Close door first");
    deniedBeep();
    return;
  }

  lockServo.write(UNLOCKED_ANGLE);

  isUnlocked = true;
  authorizedOpening = true;
  unlockStartedAt = millis();

  Serial.println("Access granted.");
  Serial.println("Servo commanded to 90 degrees.");
  Serial.println("Auto-lock timer started: 15 seconds.");

  successBeep();

  showScreen(
    "ACCESS GRANTED",
    "Locker unlocked",
    "Open the door",
    "Auto-lock: 15 sec"
  );
}

// ---------- PIN PROCESSING ----------
void processKey(char key) {
  if (key == '*') {
    enteredPIN = "";
    Serial.println("PIN cleared.");
    showHomeScreen();
    return;
  }

  if (key == '#') {
    Serial.println("Checking PIN...");

    if (enteredPIN == CORRECT_PIN) {
      enteredPIN = "";
      unlockLocker();
    } else {
      enteredPIN = "";

      Serial.println("Access denied.");
      deniedBeep();

      showScreen(
        "ACCESS DENIED",
        "Incorrect PIN",
        "Try again",
        "Enter PIN"
      );

      accessMessageActive = true;
      accessMessageAt = millis();
    }

    return;
  }

  if (key >= '0' && key <= '9') {
    if (enteredPIN.length() < 8) {
      enteredPIN += key;
    }

    Serial.print("PIN entered: ");
    for (unsigned int i = 0; i < enteredPIN.length(); i++) {
      Serial.print('*');
    }
    Serial.println();

    showHomeScreen();
  }
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("=== LockrFlow Starting ===");

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  pinMode(REED_PIN, INPUT);

  // Initialize OLED on ESP32 I2C pins
  Wire.begin(21, 22);

  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    oledReady = true;

    showScreen(
      "SYSTEM STARTING",
      "Initializing...",
      "Please wait"
    );

    Serial.println("OLED initialized.");
  } else {
    Serial.println("OLED initialization failed.");
  }

  // Initialize servo
  lockServo.setPeriodHertz(50);
  lockServo.attach(SERVO_PIN, 500, 2400);
  servoReady = lockServo.attached();

  if (servoReady) {
    lockServo.write(LOCKED_ANGLE);
    Serial.println("Servo attached.");
    Serial.println("Servo commanded to 0 degrees (LOCKED).");
  } else {
    Serial.println("Servo attachment failed.");
  }

  // Initialize keypad
  keypad.setDebounceTime(50);

  delay(500);

  Serial.println("System ready.");
  Serial.println("PIN: 1234");
  Serial.println("Press # to submit PIN.");

  // Initialize the current reed-switch state
  doorWasOpen = !isDoorClosed();

  showHomeScreen();
}

// ---------- MAIN LOOP ----------
void loop() {
  bool doorClosed = isDoorClosed();

  // Detect door opening
  if (!doorClosed && !doorWasOpen) {
    doorWasOpen = true;
    Serial.println("Door opened.");

    if (authorizedOpening && isUnlocked) {
      showScreen(
        "AUTHORIZED ACCESS",
        "Door is OPEN",
        "Take your parcel",
        "Timeout: 15 sec"
      );
    } else {
      Serial.println("WARNING: Unauthorized opening!");
      warningBeep();

      showScreen(
        "SECURITY WARNING",
        "Unauthorized",
        "door opening!",
        "Check locker"
      );
    }
  }

  // Detect door closing.
  // Closing the door does NOT lock the servo.
  if (doorClosed && doorWasOpen) {
    doorWasOpen = false;
    Serial.println("Door closed.");

    if (isUnlocked) {
      showScreen(
        "LOCK UNLOCKED",
        "Door closed",
        "Waiting for timeout",
        "Auto-lock: 15 sec"
      );
    } else {
      showHomeScreen();
    }
  }

  // ---------- AUTOMATIC TIMEOUT LOCK ----------
  // This does NOT depend on the reed-switch state.
  if (isUnlocked &&
      millis() - unlockStartedAt >= UNLOCK_TIMEOUT) {

    Serial.println("15-second timeout reached.");
    lockLocker();
  }

  // Restore home screen after denied access
  if (accessMessageActive &&
      millis() - accessMessageAt >= 2000) {

    accessMessageActive = false;
    showHomeScreen();
  }

  // Read keypad
  char key = keypad.getKey();

  if (key) {
    Serial.print("Key pressed: ");
    Serial.println(key);

    processKey(key);
  }

  delay(20);
}
