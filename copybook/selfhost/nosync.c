// LD_PRELOAD shim for gene's workerd (copybook-api). workerd runs every request on one thread and fsyncs its stores on
// that thread, so one fsync during btrfs's 30-second commit (0.4-4 s on gene, whatever else writes to the disk) freezes
// every request, storage or not. This makes fsync/fdatasync return at once for files under the colon-separated
// NOSYNC_PREFIXES (stores whose loss of the last seconds is acceptable: the R2 mirror of ingest data, per-key meters);
// every other fsync (members, follows, keys, billing in KV and MemberFollows) still goes to the kernel. Skipped data
// still reaches disk at btrfs's next commit (30 s); only a power loss or kernel crash in that window can lose it.
// NOSYNC_LOG (optional): appends one line a minute (real and skipped fsync counts, slowest real one) and a line for
// every real fsync over 200 ms with its path, so what still blocks the thread shows up.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int (*real_fsync)(int);
static int (*real_fdatasync)(int);
static char prefixes[4096];
static int logfd = -2;
static long minute, n_real, n_skip, max_ms;

static void init(void) {
  if (!real_fsync) real_fsync = dlsym(RTLD_NEXT, "fsync");
  if (!real_fdatasync) real_fdatasync = dlsym(RTLD_NEXT, "fdatasync");
  if (logfd == -2) {
    const char *p = getenv("NOSYNC_PREFIXES");
    snprintf(prefixes, sizeof prefixes, "%s", p ? p : "");
    const char *l = getenv("NOSYNC_LOG");
    logfd = l && *l ? open(l, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644) : -1;
  }
}

static int path_of(int fd, char *path) {
  char link[64];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, path, PATH_MAX - 1);
  if (n <= 0) return 0;
  path[n] = 0;
  return 1;
}

static int skip(const char *path) {
  const char *p = prefixes;
  while (*p) {
    const char *e = strchr(p, ':');
    size_t len = e ? (size_t)(e - p) : strlen(p);
    if (len && strncmp(path, p, len) == 0) return 1;
    if (!e) break;
    p = e + 1;
  }
  return 0;
}

static void say(const char *s) {
  if (logfd >= 0) (void)!write(logfd, s, strlen(s));
}

static void tally(long ms, const char *path, int skipped) {
  if (logfd < 0) return;
  time_t now = time(NULL);
  long m = now / 60;
  char line[PATH_MAX + 128], ts[32];
  if (m != minute) {
    if (minute) {
      time_t t = minute * 60;
      strftime(ts, sizeof ts, "%Y-%m-%dT%H:%MZ", gmtime(&t));
      snprintf(line, sizeof line, "%s real=%ld skipped=%ld max_real_ms=%ld\n", ts, n_real, n_skip, max_ms);
      say(line);
    }
    minute = m; n_real = n_skip = max_ms = 0;
  }
  if (skipped) { n_skip++; return; }
  n_real++;
  if (ms > max_ms) max_ms = ms;
  if (ms > 200) {
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));
    snprintf(line, sizeof line, "%s slow %ldms %s\n", ts, ms, path);
    say(line);
  }
}

static int sync_one(int fd, int (*real)(int)) {
  init();
  char path[PATH_MAX] = "?";
  int known = path_of(fd, path);
  if (known && skip(path)) { tally(0, path, 1); return 0; }
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  int r = real(fd);
  clock_gettime(CLOCK_MONOTONIC, &b);
  tally((b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000, path, 0);
  return r;
}

int fsync(int fd) { init(); return sync_one(fd, real_fsync); }
int fdatasync(int fd) { init(); return sync_one(fd, real_fdatasync); }
