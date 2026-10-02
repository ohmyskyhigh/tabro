#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602

#include <windows.h>
#include <winhttp.h>
#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <fstream>
#include <regex>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "winhttp.lib")

namespace {

constexpr std::uint32_t kMaxMessageBytes = 1024 * 1024;
std::mutex g_stdoutMutex;

bool readExact(HANDLE handle, void* buffer, DWORD bytes) {
  auto* cursor = static_cast<unsigned char*>(buffer);
  DWORD remaining = bytes;
  while (remaining > 0) {
    DWORD received = 0;
    if (!ReadFile(handle, cursor, remaining, &received, nullptr) || received == 0) return false;
    cursor += received;
    remaining -= received;
  }
  return true;
}

bool writeExact(HANDLE handle, const void* buffer, DWORD bytes) {
  const auto* cursor = static_cast<const unsigned char*>(buffer);
  DWORD remaining = bytes;
  while (remaining > 0) {
    DWORD written = 0;
    if (!WriteFile(handle, cursor, remaining, &written, nullptr) || written == 0) return false;
    cursor += written;
    remaining -= written;
  }
  return true;
}

bool readNativeMessage(std::string& message) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::uint32_t length = 0;
  if (!readExact(input, &length, sizeof(length))) return false;
  if (length == 0 || length > kMaxMessageBytes) return false;
  message.resize(length);
  return readExact(input, &message[0], length);
}

bool writeNativeMessage(const std::string& message) {
  if (message.size() > kMaxMessageBytes) return false;
  std::lock_guard<std::mutex> lock(g_stdoutMutex);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  const auto length = static_cast<std::uint32_t>(message.size());
  return writeExact(output, &length, sizeof(length)) &&
    writeExact(output, message.data(), length);
}

std::string escapeJson(const std::string& value) {
  std::string result;
  result.reserve(value.size());
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (character >= 0x20) result += static_cast<char>(character);
        break;
    }
  }
  return result;
}

void sendControl(const char* type, const std::string& message = std::string(), DWORD code = 0) {
  std::string json = "{\"nativeControl\":{\"type\":\"" + std::string(type) + "\"";
  if (!message.empty()) json += ",\"message\":\"" + escapeJson(message) + "\"";
  if (code != 0) json += ",\"code\":" + std::to_string(code);
  json += "}}";
  writeNativeMessage(json);
}

bool extractJsonString(const std::string& json, const std::string& key, std::string& value) {
  const std::string marker = "\"" + key + "\"";
  std::size_t position = json.find(marker);
  if (position == std::string::npos) return false;
  position = json.find(':', position + marker.size());
  if (position == std::string::npos) return false;
  position = json.find('"', position + 1);
  if (position == std::string::npos) return false;
  ++position;
  value.clear();
  bool escaped = false;
  for (; position < json.size(); ++position) {
    const char character = json[position];
    if (escaped) {
      switch (character) {
        case '"': value += '"'; break;
        case '\\': value += '\\'; break;
        case '/': value += '/'; break;
        case 'b': value += '\b'; break;
        case 'f': value += '\f'; break;
        case 'n': value += '\n'; break;
        case 'r': value += '\r'; break;
        case 't': value += '\t'; break;
        default: return false;
      }
      escaped = false;
    } else if (character == '\\') {
      escaped = true;
    } else if (character == '"') {
      return true;
    } else {
      value += character;
    }
  }
  return false;
}

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return std::wstring();
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
    static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return std::wstring();
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), &result[0], length) <= 0) return std::wstring();
  return result;
}

bool discoverRelayUrl(std::string& relayUrl, std::string& error) {
  wchar_t executable[32768]{};
  const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
  if (length == 0 || length >= 32768) { error = "Cannot locate native companion."; return false; }
  std::wstring path(executable, length);
  path = path.substr(0, path.find_last_of(L"\\/")) + L"\\relay-runtime.json";
  if (GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) return true; // Legacy fixed-port installation.
  std::ifstream file(path.c_str(), std::ios::binary);
  std::string json;
  char buffer[4096];
  file.read(buffer, sizeof(buffer));
  json.assign(buffer, static_cast<std::size_t>(file.gcount()));
  if (!file.eof() || !extractJsonString(json, "relayUrl", relayUrl)) {
    error = "Invalid Tabro runtime discovery record."; return false;
  }
  std::smatch match;
  if (!std::regex_search(json, match, std::regex("\\\"schemaVersion\\\"\\s*:\\s*1\\s*[,}]")) ||
      !std::regex_search(json, match, std::regex("\\\"processId\\\"\\s*:\\s*([1-9][0-9]*)\\s*[,}]"))) {
    error = "Unsupported Tabro runtime discovery record."; return false;
  }
  unsigned long processId = 0;
  try { processId = std::stoul(match[1].str()); } catch (...) { error = "Invalid Broker process ID."; return false; }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  DWORD exitCode = 0;
  const bool alive = process && GetExitCodeProcess(process, &exitCode) && exitCode == STILL_ACTIVE;
  if (process) CloseHandle(process);
  if (!alive) { error = "The discovered Tabro Broker is not running."; return false; }
  if (!std::regex_match(relayUrl, std::regex("ws://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/relay"))) {
    error = "Discovered relay must use the local Tabro endpoint."; return false;
  }
  return true;
}

struct WebSocketConnection {
  HINTERNET session = nullptr;
  HINTERNET connection = nullptr;
  HINTERNET socket = nullptr;

  ~WebSocketConnection() {
    if (socket) WinHttpCloseHandle(socket);
    if (connection) WinHttpCloseHandle(connection);
    if (session) WinHttpCloseHandle(session);
  }
};

bool openWebSocket(const std::string& relayUrl, WebSocketConnection& result, std::string& error, DWORD& errorCode) {
  const bool secure = relayUrl.rfind("wss://", 0) == 0;
  if (!secure && relayUrl.rfind("ws://", 0) != 0) {
    error = "Broker URL must use ws:// or wss://.";
    return false;
  }

  std::string httpUrl = (secure ? "https://" : "http://") + relayUrl.substr(secure ? 6 : 5);
  std::wstring wideUrl = utf8ToWide(httpUrl);
  if (wideUrl.empty()) {
    error = "Broker URL is not valid UTF-8.";
    return false;
  }

  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  components.dwSchemeLength = static_cast<DWORD>(-1);
  components.dwHostNameLength = static_cast<DWORD>(-1);
  components.dwUrlPathLength = static_cast<DWORD>(-1);
  components.dwExtraInfoLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(wideUrl.c_str(), 0, 0, &components)) {
    errorCode = GetLastError();
    error = "Could not parse the broker URL.";
    return false;
  }

  std::wstring host(components.lpszHostName, components.dwHostNameLength);
  for (auto& character : host) character = static_cast<wchar_t>(towlower(character));
  if (host != L"127.0.0.1" && host != L"localhost" && host != L"::1") {
    error = "Native companion only permits loopback broker addresses.";
    return false;
  }

  std::wstring path = components.dwUrlPathLength
    ? std::wstring(components.lpszUrlPath, components.dwUrlPathLength)
    : L"/";
  if (components.dwExtraInfoLength) {
    path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
  }

  result.session = WinHttpOpen(L"ProfileAwareBrowserRelay/0.1",
    WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!result.session) {
    errorCode = GetLastError();
    error = "Could not initialize the Windows HTTP client.";
    return false;
  }
  WinHttpSetTimeouts(result.session, 5000, 5000, 5000, 5000);

  result.connection = WinHttpConnect(result.session, host.c_str(), components.nPort, 0);
  if (!result.connection) {
    errorCode = GetLastError();
    error = "Could not connect to the local broker.";
    return false;
  }

  HINTERNET request = WinHttpOpenRequest(result.connection, L"GET", path.c_str(), nullptr,
    WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
  if (!request) {
    errorCode = GetLastError();
    error = "Could not create the WebSocket upgrade request.";
    return false;
  }

  if (!WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) ||
      !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
      !WinHttpReceiveResponse(request, nullptr)) {
    errorCode = GetLastError();
    error = "The local broker WebSocket upgrade failed.";
    WinHttpCloseHandle(request);
    return false;
  }

  result.socket = WinHttpWebSocketCompleteUpgrade(request, 0);
  errorCode = result.socket ? 0 : GetLastError();
  WinHttpCloseHandle(request);
  if (!result.socket) {
    error = "Could not complete the local broker WebSocket upgrade.";
    return false;
  }
  return true;
}

void receiveLoop(HINTERNET socket) {
  std::vector<unsigned char> buffer(64 * 1024);
  std::string message;
  while (true) {
    DWORD received = 0;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type = WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE;
    const DWORD result = WinHttpWebSocketReceive(socket, buffer.data(),
      static_cast<DWORD>(buffer.size()), &received, &type);
    if (result != NO_ERROR) {
      sendControl("ERROR", "Reading from the local broker failed.", result);
      ExitProcess(1);
    }
    if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
      USHORT status = 1006;
      DWORD reasonLength = 0;
      unsigned char reason[124]{};
      WinHttpWebSocketQueryCloseStatus(socket, &status, reason, sizeof(reason), &reasonLength);
      sendControl("CLOSED", std::string(reinterpret_cast<char*>(reason), reasonLength), status);
      ExitProcess(0);
    }
    if (type == WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE ||
        type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
      sendControl("ERROR", "The broker sent an unsupported binary message.");
      ExitProcess(1);
    }
    if (message.size() + received > kMaxMessageBytes) {
      sendControl("ERROR", "The broker message exceeded the 1 MiB limit.");
      ExitProcess(1);
    }
    message.append(reinterpret_cast<char*>(buffer.data()), received);
    if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
      if (!writeNativeMessage(message)) ExitProcess(1);
      message.clear();
    }
  }
}

}  // namespace

int main() {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

  std::string controlMessage;
  if (!readNativeMessage(controlMessage)) return 1;
  std::string relayUrl;
  if (!extractJsonString(controlMessage, "url", relayUrl)) {
    sendControl("ERROR", "The first native message must contain a broker URL.");
    return 1;
  }

  WebSocketConnection websocket;
  std::string error;
  DWORD errorCode = 0;
  if (!discoverRelayUrl(relayUrl, error)) {
    sendControl("ERROR", error);
    return 1;
  }
  if (!openWebSocket(relayUrl, websocket, error, errorCode)) {
    sendControl("ERROR", error, errorCode);
    return 1;
  }

  sendControl("READY");
  std::thread receiver(receiveLoop, websocket.socket);
  receiver.detach();

  std::string message;
  while (readNativeMessage(message)) {
    const DWORD result = WinHttpWebSocketSend(websocket.socket,
      WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
      const_cast<char*>(message.data()), static_cast<DWORD>(message.size()));
    if (result != NO_ERROR) {
      sendControl("ERROR", "Writing to the local broker failed.", result);
      return 1;
    }
  }

  WinHttpWebSocketClose(websocket.socket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
  return 0;
}
