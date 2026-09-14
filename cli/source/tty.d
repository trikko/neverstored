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

      auto answer = terminal.readln();
      if (answer is null) return false;

      return answer.strip.toLower == "y" || answer.strip.toLower == "yes";
   }

   stderr.write(question ~ " ");
   stderr.flush();

   auto answer = stdin.readln();
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

   auto line = terminal.readln();
   return line is null ? "" : line.chomp;
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
