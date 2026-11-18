/* The lock belongs to the Node process, never to a detachable helper. */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
#define NAPI_AUTO_LENGTH ((size_t)-1)

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <shlobj.h>
#include <sddl.h>
#include <aclapi.h>
#include <wchar.h>
#define EXPORT __declspec(dllexport)
#define NAPI_FUNCTION(name, args) static napi_status (*name) args
NAPI_FUNCTION(napi_create_string_utf8, (napi_env, const char *, size_t, napi_value *));
NAPI_FUNCTION(napi_get_undefined, (napi_env, napi_value *));
NAPI_FUNCTION(napi_create_function, (napi_env, const char *, size_t, napi_callback, void *, napi_value *));
NAPI_FUNCTION(napi_set_named_property, (napi_env, napi_value, const char *, napi_value));
NAPI_FUNCTION(napi_throw_error, (napi_env, const char *, const char *));
NAPI_FUNCTION(napi_get_cb_info, (napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **));
NAPI_FUNCTION(napi_get_value_string_utf8, (napi_env, napi_value, char *, size_t, size_t *));
static HANDLE mutex_handle;

static int trusted_sid(PSID sid) {
  BYTE system_sid[SECURITY_MAX_SID_SIZE], admins_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_size = sizeof(system_sid), admins_size = sizeof(admins_sid);
  int trusted = CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, &system_size) &&
    CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admins_sid, &admins_size) &&
    (EqualSid(sid, system_sid) || EqualSid(sid, admins_sid));
  PSID installer = NULL;
  if (!trusted && ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer)) {
    trusted = EqualSid(sid, installer); LocalFree(installer);
  }
  return trusted;
}

static int current_sid(PSID sid) {
  HANDLE token = NULL;
  DWORD length = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  TOKEN_USER *user = (TOKEN_USER *)malloc(length);
  int equal = user && GetTokenInformation(token, TokenUser, user, length, &length) && EqualSid(sid, user->User.Sid);
  free(user); CloseHandle(token);
  return equal;
}

static int safe_acl(const wchar_t *path, int parent, int private_file) {
  PSID owner = NULL;
  PACL acl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD attrs = GetFileAttributesW(path);
  if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
  if (GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS) return 0;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  int safe = acl && owner && (trusted_sid(owner) || (private_file && current_sid(owner))) &&
    GetSecurityDescriptorControl(descriptor, &control, &revision) &&
    (parent || private_file || (control & SE_DACL_PROTECTED));
  DWORD writes = parent ? (FILE_DELETE_CHILD | GENERIC_ALL | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER | DELETE) :
    (GENERIC_ALL | GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER | FILE_WRITE_DATA |
     FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD);
  if (private_file && !parent) writes |= GENERIC_READ | FILE_READ_DATA;
  for (DWORD i = 0; safe && i < acl->AceCount; i++) {
    void *raw = NULL;
    if (!GetAce(acl, i, &raw)) { safe = 0; break; }
    ACE_HEADER *header = (ACE_HEADER *)raw;
    if ((!parent && !private_file && (header->AceFlags & INHERITED_ACE)) ||
        (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE)) {
      safe = 0; break;
    }
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && !(header->AceFlags & INHERIT_ONLY_ACE)) {
      ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)raw;
      if ((ace->Mask & writes) && !trusted_sid((PSID)&ace->SidStart) && !(private_file && current_sid((PSID)&ace->SidStart))) safe = 0;
    }
  }
  LocalFree(descriptor);
  return safe;
}
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/acl.h>
#else
#include <sys/xattr.h>
#endif
#define EXPORT __attribute__((visibility("default")))
extern napi_status napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
extern napi_status napi_get_undefined(napi_env, napi_value *);
extern napi_status napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern napi_status napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern napi_status napi_throw_error(napi_env, const char *, const char *);
extern napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern napi_status napi_get_value_string_utf8(napi_env, napi_value, char *, size_t, size_t *);
static int lock_fd = -1;
#endif

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value str(napi_env env, const char *value) {
  napi_value result;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != 0) return NULL;
  return result;
}

static napi_value directory(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef _WIN32
  PWSTR folder = NULL;
  char utf8[32768];
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, NULL, &folder))) return fail(env, "Cannot locate machine registration directory.");
  int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, folder, -1, utf8, (int)sizeof(utf8), NULL, NULL);
  CoTaskMemFree(folder);
  if (!length || strlen(utf8) + 7 >= sizeof(utf8)) return fail(env, "Invalid machine registration directory.");
  strcat(utf8, "\\Tabro");
  return str(env, utf8);
#elif defined(__APPLE__)
  return str(env, "/var/db/tabro");
#else
  return str(env, "/var/lib/tabro");
#endif
}

static napi_value account(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef _WIN32
  HANDLE token = NULL;
  DWORD length = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return fail(env, "Cannot identify the current account.");
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  TOKEN_USER *user = (TOKEN_USER *)malloc(length);
  if (!user || !GetTokenInformation(token, TokenUser, user, length, &length)) {
    free(user); CloseHandle(token); return fail(env, "Cannot identify the current account.");
  }
  LPSTR sid = NULL;
  if (!ConvertSidToStringSidA(user->User.Sid, &sid)) {
    free(user); CloseHandle(token); return fail(env, "Cannot identify the current account.");
  }
  napi_value result = str(env, sid);
  LocalFree(sid); free(user); CloseHandle(token);
  return result;
#else
  char value[32];
  snprintf(value, sizeof(value), "%lu", (unsigned long)geteuid());
  return str(env, value);
#endif
}

static napi_value acquire(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef _WIN32
  if (mutex_handle) return fail(env, "Machine Broker lock is already held in this process.");
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)(A;;0x00100001;;;WD)", SDDL_REVISION_1, &descriptor, NULL)) {
    return fail(env, "Cannot secure the machine Broker lock.");
  }
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), descriptor, FALSE };
  mutex_handle = CreateMutexExW(&attributes, L"Global\\Tabro.Broker.v1", 0, MUTEX_ALL_ACCESS);
  LocalFree(descriptor);
  PSID mutex_owner = NULL;
  PSECURITY_DESCRIPTOR mutex_security = NULL;
  if (!mutex_handle || GetSecurityInfo(mutex_handle, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
        &mutex_owner, NULL, NULL, NULL, &mutex_security) != ERROR_SUCCESS ||
      !mutex_owner || (!trusted_sid(mutex_owner) && !current_sid(mutex_owner))) {
    if (mutex_security) LocalFree(mutex_security);
    if (mutex_handle) { CloseHandle(mutex_handle); mutex_handle = NULL; }
    return fail(env, "The machine Broker lock has an untrusted owner.");
  }
  LocalFree(mutex_security);
  DWORD wait_result = mutex_handle ? WaitForSingleObject(mutex_handle, 0) : WAIT_FAILED;
  if (!mutex_handle || (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED)) {
    if (mutex_handle) { CloseHandle(mutex_handle); mutex_handle = NULL; }
    return fail(env, "The machine Broker lock is unavailable.");
  }
#else
  if (lock_fd != -1) return fail(env, "Machine Broker lock is already held in this process.");
#if defined(__APPLE__)
  const char *path = "/var/db/tabro/broker.lock";
#else
  const char *path = "/var/lib/tabro/broker.lock";
#endif
  int fd = open(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  struct stat statbuf;
  if (fd < 0 || fstat(fd, &statbuf) != 0 || !S_ISREG(statbuf.st_mode) || (geteuid() != 0 && statbuf.st_uid != geteuid()) ||
      (statbuf.st_mode & 0777) != 0600 || statbuf.st_nlink != 1 || flock(fd, LOCK_EX | LOCK_NB) != 0) {
    if (fd >= 0) close(fd);
    return fail(env, "The machine Broker lock is unavailable or unsafe.");
  }
  lock_fd = fd;
#endif
  napi_value result;
  if (napi_get_undefined(env, &result) != 0) return NULL;
  return result;
}

static napi_value verify_permissions(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef _WIN32
  PWSTR folder = NULL;
  wchar_t directory_path[32768], registration_path[32768];
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, NULL, &folder))) return fail(env, "Cannot locate machine registration directory.");
  int valid = wcslen(folder) + 25 < sizeof(directory_path) / sizeof(directory_path[0]);
  if (valid) {
    wcscpy(directory_path, folder); wcscat(directory_path, L"\\Tabro");
    wcscpy(registration_path, directory_path); wcscat(registration_path, L"\\registration.json");
    valid = safe_acl(folder, 1, 0) && safe_acl(directory_path, 0, 0) && safe_acl(registration_path, 0, 0);
  }
  CoTaskMemFree(folder);
  if (!valid) return fail(env, "Machine registration ACL is unsupported or unsafe.");
  napi_value result;
  if (napi_get_undefined(env, &result) != 0) return NULL;
  return result;
#else
#if defined(__APPLE__)
  const char *paths[] = { "/var/db/tabro", "/var/db/tabro/registration.json", "/var/db/tabro/broker.lock" };
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
    errno = 0;
    acl_t acl = acl_get_file(paths[i], ACL_TYPE_EXTENDED);
    if (!acl) {
      if (errno == ENOENT) continue;
      return fail(env, "Cannot inspect machine registration ACL.");
    }
    acl_entry_t entry;
    errno = 0;
    int present = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
    int failure = errno;
    acl_free(acl);
    if (present == 0 || failure != EINVAL) return fail(env, "Machine registration ACL is unsupported or unsafe.");
  }
#else
  const char *paths[] = { "/var/lib/tabro", "/var/lib/tabro/registration.json", "/var/lib/tabro/broker.lock" };
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
    errno = 0;
    ssize_t length = getxattr(paths[i], "system.posix_acl_access", NULL, 0);
    if (length >= 0 || (errno != ENODATA && errno != ENOTSUP)) return fail(env, "Machine registration ACL is unsupported or unsafe.");
  }
#endif
  napi_value result;
  if (napi_get_undefined(env, &result) != 0) return NULL;
  return result;
#endif
}

static napi_value verify_path(napi_env env, napi_callback_info info, int ancestor) {
  size_t argc = 1, length = 0;
  napi_value argument;
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != 0 || argc != 1 ||
      napi_get_value_string_utf8(env, argument, NULL, 0, &length) != 0 || !length || length > 32767) return fail(env, "Invalid private path.");
  char *path = (char *)malloc(length + 1);
  if (!path) return fail(env, "Cannot inspect private path.");
  if (napi_get_value_string_utf8(env, argument, path, length + 1, &length) != 0) { free(path); return fail(env, "Invalid private path."); }
  int safe = 0;
#ifdef _WIN32
  int chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  wchar_t *wide = chars ? (wchar_t *)malloc((size_t)chars * sizeof(wchar_t)) : NULL;
  if (wide && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, chars)) safe = safe_acl(wide, ancestor != 0, ancestor != 2);
  free(wide);
#elif defined(__APPLE__)
  errno = 0;
  acl_t acl = acl_get_file(path, ACL_TYPE_EXTENDED);
  if (!acl) safe = errno == ENOENT;
  else {
    acl_entry_t entry;
    int next = ACL_FIRST_ENTRY;
    safe = 1;
    for (;;) {
      errno = 0;
      if (acl_get_entry(acl, next, &entry) != 0) { if (errno != EINVAL) safe = 0; break; }
      acl_tag_t tag;
      if (!ancestor || acl_get_tag_type(entry, &tag) != 0 || tag != ACL_EXTENDED_DENY) { safe = 0; break; }
      next = ACL_NEXT_ENTRY;
    }
    acl_free(acl);
  }
#else
  (void)ancestor;
  errno = 0;
  ssize_t acl_result = getxattr(path, "system.posix_acl_access", NULL, 0);
  safe = acl_result < 0 && (errno == ENODATA || errno == ENOTSUP);
#endif
  free(path);
  if (!safe) return fail(env, "Private path ACL is unsupported or unsafe.");
  napi_value result;
  if (napi_get_undefined(env, &result) != 0) return NULL;
  return result;
}

static napi_value verify_private(napi_env env, napi_callback_info info) { return verify_path(env, info, 0); }
static napi_value verify_ancestor(napi_env env, napi_callback_info info) { return verify_path(env, info, 1); }
static napi_value verify_system_ancestor(napi_env env, napi_callback_info info) { return verify_path(env, info, 2); }

EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
#ifdef _WIN32
  HMODULE node = GetModuleHandleW(NULL);
#define LOAD(name) do { *(FARPROC *)&name = GetProcAddress(node, #name); if (!name) return NULL; } while (0)
  LOAD(napi_create_string_utf8); LOAD(napi_get_undefined); LOAD(napi_create_function);
  LOAD(napi_set_named_property); LOAD(napi_throw_error);
  LOAD(napi_get_cb_info); LOAD(napi_get_value_string_utf8);
#undef LOAD
#endif
  struct { const char *name; napi_callback callback; } methods[] = {
    { "directory", directory }, { "account", account }, { "acquire", acquire }, { "verifyPermissions", verify_permissions },
    { "verifyPrivate", verify_private }, { "verifyAncestor", verify_ancestor }, { "verifySystemAncestor", verify_system_ancestor }
  };
  for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
    napi_value function;
    if (napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, methods[i].callback, NULL, &function) != 0 ||
        napi_set_named_property(env, exports, methods[i].name, function) != 0) return NULL;
  }
  return exports;
}
