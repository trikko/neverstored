module app;

import session;

import std.getopt : config, getopt, GetOptException;
import std.process : environment;
import std.stdio : stderr, stdout;

enum usage = "neverstored — hand a secret to someone while you are both there.

  neverstored send [--file F]     open a room and hand a secret over
  neverstored ask                 open a room and receive a secret
  neverstored open <link|id>      enter a room someone opened

The secret is read from --file, or from stdin when it is piped in, or asked for on the
terminal without echoing. What you receive goes to stdout and nothing else does, so
`neverstored open <link> > key.txt` does what it looks like.

  --file F     read the secret from a file, or from stdin with -
  --url U      the service to use (default $NEVERSTORED_URL or https://neverstored.com)
  --wait N     give up after N seconds waiting for the other side
  --no-qr      do not draw the code to scan
  --dense      draw the code half as tall

Exit: 0 handed over or received, 1 symbols refused, 2 room gone or expired,
3 service unreachable, 4 wrong usage.";

int main(string[] args)
{
   import core.stdc.signal : signal, SIGINT;

   Options options;
   options.url = environment.get("NEVERSTORED_URL", options.url);

   bool noQr, dense, help;
   long wait;

   try
   {
      auto parsed = getopt(args,
         config.caseSensitive,
         "file|f", "read the secret from a file, or - for stdin", &options.file,
         "url|u", "the service to use", &options.url,
         "wait|w", "give up after N seconds", &wait,
         "no-qr", "do not draw the code to scan", &noQr,
         "dense", "draw the code half as tall", &dense,
         "help|h", "show this", &help,
      );

      if (help || parsed.helpWanted)
      {
         stdout.writeln(usage);
         return Exit.done;
      }
   }
   catch (GetOptException e)
   {
      stderr.writeln(e.msg);
      return Exit.misuse;
   }

   options.qr = !noQr;
   options.dense = dense;

   if (wait > 0)
   {
      import core.time : seconds;
      options.wait = wait.seconds;
   }

   while (options.url.length && options.url[$ - 1] == '/')
      options.url = options.url[0 .. $ - 1];

   if (args.length < 2)
   {
      stderr.writeln(usage);
      return Exit.misuse;
   }

   signal(SIGINT, &onInterrupt);

   try
   {
      switch (args[1])
      {
         case "send":
            auto exchange = Exchange(options);
            return exchange.create("send");

         case "ask":
            auto exchange = Exchange(options);
            return exchange.create("request");

         case "open":
            if (args.length < 3)
            {
               stderr.writeln("Which room? Pass the link you were given.");
               return Exit.misuse;
            }

            immutable room = roomOf(args[2]);
            if (room is null)
            {
               stderr.writeln("That does not look like a room link.");
               return Exit.misuse;
            }

            auto exchange = Exchange(options);
            return exchange.join(room);

         default:
            stderr.writeln(usage);
            return Exit.misuse;
      }
   }
   catch (Exception e)
   {
      stderr.writeln(e.msg);
      return Exit.unreachable;
   }
}

/// Accepts either a full link or the bare room id, so pasting either works.
string roomOf(string given) @safe pure
{
   import std.string : lastIndexOf;

   auto cut = given.lastIndexOf('/');
   auto candidate = cut >= 0 ? given[cut + 1 .. $] : given;

   if (candidate.length != 22) return null;

   foreach (c; candidate)
   {
      immutable allowed = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
         || (c >= '0' && c <= '9') || c == '-' || c == '_';
      if (!allowed) return null;
   }

   return candidate;
}

unittest
{
   assert(roomOf("https://neverstored.com/r/IQxLFZiBUNSy6eI2BRUn9Q") == "IQxLFZiBUNSy6eI2BRUn9Q");
   assert(roomOf("IQxLFZiBUNSy6eI2BRUn9Q") == "IQxLFZiBUNSy6eI2BRUn9Q");
   assert(roomOf("http://localhost:8080/r/IQxLFZiBUNSy6eI2BRUn9Q") == "IQxLFZiBUNSy6eI2BRUn9Q");
   assert(roomOf("nope") is null);
   assert(roomOf("https://neverstored.com/r/short") is null);
   assert(roomOf("../../../../etc/passwd") is null);
}
