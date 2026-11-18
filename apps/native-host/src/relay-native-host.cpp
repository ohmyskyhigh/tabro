#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <aclapi.h>
#include <shellapi.h>
#include <sddl.h>
#include <cstdint>
#include <fstream>
#include <regex>
#include <string>
#include <vector>

namespace {
void error(const char* message) {
  const std::string text = std::string("{\"nativeControl\":{\"type\":\"ERROR\",\"message\":\"") + message + "\"}}";
  const std::uint32_t length = static_cast<std::uint32_t>(text.size());
  DWORD written = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  WriteFile(output, &length, sizeof(length), &written, nullptr);
  WriteFile(output, text.data(), length, &written, nullptr);
}

bool trusted(PSID sid) {
  BYTE system[SECURITY_MAX_SID_SIZE], admins[SECURITY_MAX_SID_SIZE];
  DWORD systemLength = sizeof(system), adminsLength = sizeof(admins);
  if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &systemLength) ||
      !CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admins, &adminsLength)) return false;
  if (EqualSid(sid, system) || EqualSid(sid, admins)) return true;
  PSID installer = nullptr;
  if (ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer)) {
    const bool same = EqualSid(sid, installer) != FALSE;
    LocalFree(installer);
    if (same) return true;
  }
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD length = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &length);
  std::vector<BYTE> buffer(length);
  const bool same = length && GetTokenInformation(token, TokenUser, buffer.data(), length, &length) &&
    EqualSid(sid, reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid);
  CloseHandle(token);
  return same;
}

bool safePath(const std::wstring& path, bool parent) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  bool valid = acl && owner && trusted(owner);
  const DWORD writes = parent ? (FILE_DELETE_CHILD | GENERIC_ALL | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER | DELETE) :
    (GENERIC_ALL | GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER | FILE_WRITE_DATA | FILE_APPEND_DATA |
     FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD);
  for (DWORD i = 0; valid && i < acl->AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(acl, i, &raw)) { valid = false; break; }
    const auto* header = static_cast<ACE_HEADER*>(raw);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) { valid = false; break; }
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && !(header->AceFlags & INHERIT_ONLY_ACE)) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      if ((ace->Mask & writes) && !trusted(const_cast<DWORD*>(&ace->SidStart))) valid = false;
    }
  }
  LocalFree(descriptor);
  return valid;
}

std::wstring parentOf(const std::wstring& path) {
  const auto position = path.find_last_of(L"\\/");
  return position == std::wstring::npos ? std::wstring() : path.substr(0, position);
}

std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  std::size_t slashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') { ++slashes; continue; }
    result.append(ch == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    result += ch;
  }
  result.append(slashes * 2, L'\\');
  return result + L"\"";
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2 || std::wstring(argv[1]) != L"chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/") {
    error("Tabro extension origin is required."); return 1;
  }
  wchar_t executable[32768]{};
  const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
  if (!length || length >= 32768) { error("Cannot locate native companion."); return 1; }
  const std::wstring bootstrap = parentOf(std::wstring(executable, length));
  const std::wstring root = parentOf(bootstrap);
  const std::wstring pointer = bootstrap + L"\\current-native-release.txt";
  const std::wstring node = bootstrap + L"\\node.exe";
  if (root.empty() || !safePath(bootstrap, false) || !safePath(pointer, false) || !safePath(node, false)) {
    error("Unsafe native companion installation."); return 1;
  }
  for (std::wstring ancestor = root; ancestor.size() > 2; ancestor = parentOf(ancestor)) {
    if (!safePath(ancestor, true)) { error("Unsafe native companion parent directory."); return 1; }
    const std::wstring parent = parentOf(ancestor);
    if (parent.empty() || parent == ancestor || parent.size() <= 2) break;
  }
  std::ifstream file(pointer.c_str(), std::ios::binary);
  std::string release((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  if (!file || !std::regex_match(release, std::regex("releases/[0-9]+\\.[0-9]+\\.[0-9]+-[a-f0-9]{12}\\n"))) {
    error("Invalid native companion release selection."); return 1;
  }
  release.pop_back();
  std::wstring relative(release.begin(), release.end());
  const std::wstring releaseRoot = root + L"\\" + relative;
  const std::wstring nativeRoot = releaseRoot + L"\\native-host";
  const std::wstring script = nativeRoot + L"\\relay-native-host.js";
  const std::wstring addon = nativeRoot + L"\\machine-lock.node";
  if (!safePath(root + L"\\releases", true) || !safePath(releaseRoot, true) || !safePath(nativeRoot, true) ||
      !safePath(script, false) || !safePath(addon, false)) {
    error("Unsafe native companion release."); return 1;
  }
  std::wstring command = quote(node) + L" --experimental-default-type=module " + quote(script) + L" \"\" " + quote(argv[1]);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(node.c_str(), &command[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, bootstrap.c_str(), &startup, &process)) {
    error("Cannot start native companion."); return 1;
  }
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hProcess);
  return static_cast<int>(code);
}
