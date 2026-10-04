module tty;

import std.stdio : File, stderr, stdin;

/// Questions go to the terminal, not to stdin, because stdin may be carrying the secret.
/// With no terminal we fall back to stdin, and an empty answer is a refusal: a confirmation
/// nobody gave must never count as a yes.
bool confirm(string question)
{
   import std.string : strip, toLower;

   auto terminal = openTerminal();

   if (terminal.isOpen)
   {
      terminal.write(question ~ " ");
      terminal.flush();

      auto answer = readOrGiveUp(terminal);
      if (answer is null) return false;

      return answer.strip.toLower == "y" || answer.strip.toLower == "yes";
   }

   stderr.write(question ~ " ");
   stderr.flush();

   auto answer = readOrGiveUp(stdin);
   if (answer is null) return false;

   return answer.strip.toLower == "y" || answer.strip.toLower == "yes";
}

/// Reads a secret from the terminal without echoing it.
string askSecret(string prompt)
{
   import core.sys.posix.termios : tcgetattr, tcsetattr, termios, ECHO, TCSAFLUSH;
   import std.string : chomp;

   auto terminal = openTerminal();
   if (!terminal.isOpen) throw new Exception("no terminal to ask on");

   termios before;
   immutable fd = terminal.fileno;
   immutable quiet = tcgetattr(fd, &before) == 0;

   if (quiet)
   {
      auto during = before;
      during.c_lflag &= ~ECHO;
      tcsetattr(fd, TCSAFLUSH, &during);
   }

   scope (exit)
   {
      if (quiet) tcsetattr(fd, TCSAFLUSH, &before);
      terminal.write("\n");
      terminal.flush();
   }

   terminal.write(prompt ~ " ");
   terminal.flush();

   auto line = readOrGiveUp(terminal);
   return line is null ? "" : line.chomp;
}

/// Ctrl-C ends a read that is waiting rather than restarting it, and the read reports that
/// as an error: it is an answer nobody gave, the same as no answer at all.
private string readOrGiveUp(File from)
{
   try return from.readln();
   catch (Exception) return null;
}

private __gshared bool interruptedFlag;

bool interrupted() { return interruptedFlag; }

/// Installed without SA_RESTART, so Ctrl-C ends whatever the client is waiting on: a
/// question on the terminal would otherwise sit there until somebody pressed enter.
void stopOnInterrupt()
{
   import core.sys.posix.signal : sigaction, sigaction_t, sigemptyset, SIGINT;

   sigaction_t action;
   action.sa_handler = &onInterrupt;
   sigemptyset(&action.sa_mask);
   action.sa_flags = 0;
   sigaction(SIGINT, &action, null);
}

private extern (C) void onInterrupt(int) nothrow @nogc
{
   interruptedFlag = true;
}

bool talkingToAPerson()
{
   import core.sys.posix.unistd : isatty;

   return isatty(stderr.fileno) == 1;
}

bool readingIntoATerminal()
{
   import core.sys.posix.unistd : isatty;
   import std.stdio : stdout;

   return isatty(stdout.fileno) == 1;
}

bool secretOnStdin()
{
   import core.sys.posix.unistd : isatty;

   return isatty(stdin.fileno) != 1;
}

private File openTerminal()
{
   File terminal;
   try terminal = File("/dev/tty", "r+");
   catch (Exception) {}

   return terminal;
}
