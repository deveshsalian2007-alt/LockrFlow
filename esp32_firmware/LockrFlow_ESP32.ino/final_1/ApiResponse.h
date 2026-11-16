

#ifndef API_RESPONSE_H
#define API_RESPONSE_H

#include <Arduino.h>

struct ApiResponse {
  bool transportOk;
  int statusCode;
  bool success;
  bool authorized;
  bool confirmed;
  String returnedOperation;
};

#endif