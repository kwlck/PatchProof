#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 * This is the only payload used by the credentialed App validation run.  It is
 * deliberately a small, first-party static binary so the validation image can
 * be built from FROM scratch without a registry pull or build-time network.
 */
int main(void) {
  const char *revision = getenv("PATCHPROOF_REVISION");
  if (revision == NULL || (strcmp(revision, "base") != 0 && strcmp(revision, "head") != 0)) {
    fputs("probe: invalid revision\n", stderr);
    return 2;
  }

  /* The production Docker policy must run the probe as the fixed unprivileged user. */
  if (geteuid() != 65532 || getuid() != 65532) {
    fputs("probe: unexpected uid\n", stderr);
    return 3;
  }

  /* A read-only root is part of the production runner contract. */
  int descriptor = open("/patchproof-validation-root-write", O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (descriptor >= 0) {
    close(descriptor);
    fputs("probe: root filesystem is writable\n", stderr);
    return 4;
  }
  /* A missing file under the existing root is not proof of read-only state. */
  if (errno != EROFS) {
    fputs("probe: root filesystem write check was inconclusive\n", stderr);
    return 5;
  }

  if (strcmp(revision, "base") == 0) {
    puts("EXPECTED_BUG: validation base probe intentionally fails");
    return 1;
  }

  puts("assertion passed: validation head probe ran in the isolated container");
  return 0;
}
