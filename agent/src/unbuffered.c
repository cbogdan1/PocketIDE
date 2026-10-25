/* Compiled into programs started with "Run current file". Output goes through a pipe, where C would buffer
   it until exit, so a prompt printed before scanf() would only appear after the input. */
#include <stdio.h>

__attribute__((constructor)) static void pocketide_unbuffered(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
}
