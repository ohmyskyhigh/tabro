#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <Security/Security.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/file.h>
#include <unistd.h>

// Fixed NUL-delimited fields preserve spaces and newlines in process arguments.
static void field(const char *value) {
  fwrite(value, 1, strlen(value) + 1, stdout);
}

static int processes(void) {
  int argmax = 0;
  size_t argmax_size = sizeof(argmax);
  if (sysctlbyname("kern.argmax", &argmax, &argmax_size, NULL, 0) || argmax < 1) return 1;
  int capacity = proc_listallpids(NULL, 0) + 128;
  if (capacity < 128) return 1;
  pid_t *pids = calloc(capacity, sizeof(pid_t));
  char *buffer = malloc(argmax);
  if (!pids || !buffer) return 1;
  int count = proc_listallpids(pids, capacity * sizeof(pid_t));
  if (count < 0 || count >= capacity) return 1;
  uid_t user = getuid();
  for (int i = 0; i < count; i++) {
    int pid = pids[i];
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != user) continue;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) continue;
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t size = argmax;
    if (sysctl(mib, 3, buffer, &size, NULL, 0) || size < sizeof(int)) continue;
    int argc = 0;
    memcpy(&argc, buffer, sizeof(argc));
    char *end = buffer + size;
    char *arg = memchr(buffer + sizeof(int), '\0', size - sizeof(int));
    if (!arg) continue;
    while (arg < end && *arg == '\0') arg++;
    char identity[80];
    snprintf(identity, sizeof(identity), "%d:%llu:%llu", pid, info.pbi_start_tvsec, info.pbi_start_tvusec);
    // A process may exit and its PID be reused during the separate reads.
    struct proc_bsdinfo verified;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &verified, sizeof(verified)) != sizeof(verified) ||
        verified.pbi_start_tvsec != info.pbi_start_tvsec || verified.pbi_start_tvusec != info.pbi_start_tvusec) continue;
    for (int n = 0; n < argc && arg < end; n++) {
      char *next = memchr(arg, '\0', end - arg);
      if (!next) break;
      if (strncmp(arg, "--user-data-dir=", 16) == 0) {
        field(identity);
        field(executable);
        field(arg + 16);
      }
      arg = next + 1;
    }
  }
  free(buffer);
  free(pids);
  return ferror(stdout) ? 1 : 0;
}

static int credential(int write, const char *account) {
  const char *service = "Tabro proxy credentials";
  if (write) {
    char secret[32768];
    size_t size = fread(secret, 1, sizeof(secret), stdin);
    if (size == 0 || size == sizeof(secret) || ferror(stdin)) return 1;
    OSStatus result = SecKeychainAddGenericPassword(NULL, (UInt32)strlen(service), service,
      (UInt32)strlen(account), account, (UInt32)size, secret, NULL);
    memset_s(secret, sizeof(secret), 0, sizeof(secret));
    return result == errSecSuccess ? 0 : 1;
  }
  void *secret = NULL;
  UInt32 size = 0;
  OSStatus result = SecKeychainFindGenericPassword(NULL, (UInt32)strlen(service), service,
    (UInt32)strlen(account), account, &size, &secret, NULL);
  if (result != errSecSuccess) return 1;
  size_t written = fwrite(secret, 1, size, stdout);
  SecKeychainItemFreeContent(NULL, secret);
  return written == size ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc >= 5 && strcmp(argv[1], "lock") == 0) {
    int fd = open(argv[2], O_CREAT | O_RDONLY | O_NOFOLLOW, 0600);
    if (fd < 0) return 1;
    for (int retry = 0; flock(fd, LOCK_EX | LOCK_NB) != 0; retry++) {
      if (errno != EWOULDBLOCK || retry >= 300) {
        fputs("Another Tabro setup or startup is in progress.\n", stderr);
        return 1;
      }
      usleep(100000);
    }
    execv(argv[3], argv + 3);
    return 1;
  }
  if (argc == 2 && strcmp(argv[1], "processes") == 0) return processes();
  if (argc == 3 && strcmp(argv[1], "store") == 0) return credential(1, argv[2]);
  if (argc == 3 && strcmp(argv[1], "lookup") == 0) return credential(0, argv[2]);
  return 1;
}
