module neverstored.memory;

/// No core file, and no other process of the same user attaching or reading /proc/pid/mem.
/// An exec resets this, so every process that handles a payload sets it for itself.
void forbidDumps() @trusted
{
   version (linux)
   {
      import core.sys.linux.sys.prctl : prctl, PR_SET_DUMPABLE;
      import core.sys.posix.sys.resource : rlimit, setrlimit, RLIMIT_CORE;

      rlimit noCore = { 0, 0 };
      setrlimit(RLIMIT_CORE, &noCore);
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
   }
}
