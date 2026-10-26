# LockrFlow ESP32 firmware

The active firmware sketch is
`LockrFlow_ESP32.ino/final_1/final_1.ino`. The sibling
`LockrFlow_ESP32.ino/LockrFlow_ESP32.ino.ino` is a minimal legacy serial
sketch retained for reference.

## Arduino libraries

- Keypad
- ESP32Servo
- Adafruit GFX Library
- Adafruit SSD1306

Use an ESP32 board profile. The active sketch controls the keypad, OLED,
servo, buzzer, and reed switch locally. It currently has no Wi-Fi or backend
integration.

## Local configuration

Do not commit Wi-Fi credentials, device tokens, certificates, private keys, or
local configuration. The repository `.gitignore` excludes common credential and
build-artifact paths.
