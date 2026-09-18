module session;

import secret;
import symbols;
import tty;
import wire;

import core.thread : Thread;
import core.time : Duration, MonoTime, msecs, seconds;
import std.json : JSONValue;
import std.stdio : stderr, stdout;

/// Kept in step with the server, which refuses anything larger anyway.
enum maxSecretBytes = 8 * 1024;

enum Exit
{
   done = 0,
   refused = 1,
   gone = 2,
   unreachable = 3,
   misuse = 4,

   /// Not an exit code: means the exchange is still running. Anything but a distinct
   /// member here would collide with a real code and swallow it.
   running = 255,
}

struct Options
{
   string url = "https://neverstored.com";
   string file;
   bool qr = true;
   bool dense;
   Duration wait;
}

private enum fastPoll = 500.msecs;
private enum slowPoll = 3.seconds;

struct Exchange
{
   private Api api;
   private Options options;
   private Identity self;
   private Session session;

   private string id;
   private string token;
   private string role;
   private ulong ver;

   private bool haveSession;
   private bool confirmed;
   private bool sent;
   private bool peerSeen;
   private bool expiryWarned;

   @disable this(this);

   this(Options options)
   {
      this.options = options;
      this.api = Api(options.url);
      this.self = createIdentity();
   }

   /// Opens a room and waits for the other side.
   Exit create(string flow)
   {
      JSONValue request;
      request["flow"] = flow;
      request["pub"] = self.pub;

      auto reply = api.call("create", request);
      if (!reply.ok) return complain(reply);

      id = reply.text("id");
      token = reply.text("token");
      announce();

      return loop();
   }

   /// Enters a room someone else opened. What happens next is decided by the server:
   /// this side may turn out to be the one holding the secret, or the one waiting for it.
   Exit join(string room)
   {
      JSONValue request;
      request["id"] = room;
      request["pub"] = self.pub;

      auto reply = api.call("join", request);
      if (!reply.ok)
      {
         if (reply.errorOf == "occupied")
         {
            stderr.writeln("Two people are already in that room.");
            return Exit.gone;
         }

         if (reply.errorOf == "notfound")
         {
            stderr.writeln("That link leads nowhere. It may have been used already.");
            return Exit.gone;
         }

         return complain(reply);
      }

      id = room;
      token = reply.text("token");
      stderr.writeln("Connected. Waiting for the other side.");

      return loop();
   }

   private Exit loop()
   {
      immutable deadline = options.wait > Duration.zero
         ? MonoTime.currTime + options.wait : MonoTime.zero;

      while (true)
      {
         if (interrupted)
         {
            cancel();
            return Exit.gone;
         }

         JSONValue request;
         request["id"] = id;
         request["token"] = token;
         request["v"] = ver;

         auto reply = api.call("poll", request);

         if (!reply.ok)
         {
            if (reply.errorOf == "notfound")
            {
               stderr.writeln("That room is gone. Nothing was left behind.");
               return Exit.gone;
            }
            return complain(reply);
         }

         warnIfExpiring(reply);

         if (reply.flag("changed"))
         {
            auto step = advance(reply);
            if (step != Exit.running) return step;
         }

         if (deadline != MonoTime.zero && MonoTime.currTime > deadline)
         {
            stderr.writeln("Nobody showed up in time. Nothing was sent.");
            cancel();
            return Exit.gone;
         }

         Thread.sleep(peerSeen ? fastPoll : slowPoll);
      }
   }

   /+ The room dies on a schedule of its own, and the last thing anyone wants is to find out
    + by having it disappear mid-exchange. Said once, on stderr: stdout carries the secret and
    + nothing else, and a line repeated every poll would be noise to scroll past.
   +/
   private void warnIfExpiring(in JSONValue reply)
   {
      enum warnBelow = 60;

      immutable left = reply.number("expiresIn");
      if (left == 0 || left > warnBelow || expiryWarned) return;

      expiryWarned = true;
      stderr.writefln("Less than a minute left: this room expires in %d seconds.", left);
   }

   /// Returns Exit.running while there is more to do.
   private Exit advance(in JSONValue reply)
   {
      ver = reply.number("ver");
      role = reply.text("role");

      if (reply.flag("peer") && !peerSeen)
      {
         peerSeen = true;
         stderr.writeln("Someone is here.");
      }

      auto peerPub = reply.text("peerPub");
      if (peerPub.length && !haveSession)
      {
         session = deriveSession(self, peerPub, id);
         haveSession = true;

         if (!agree()) return Exit.refused;
      }

      auto ct = reply.text("ct");
      if (ct.length)
      {
         auto plain = unseal(session, id, ct);
         scope (exit) wipe(plain);

         // The secret itself is the only thing on stdout, so a redirect holds exactly it.
         // The rules that make it readable on a terminal go to stderr.
         immutable framed = readingIntoATerminal;

         if (framed)
         {
            stderr.writeln();
            stderr.writeln("-----BEGIN SECRET-----");
            stderr.flush();
         }

         stdout.rawWrite(plain);
         stdout.flush();

         if (framed)
         {
            if (plain.length && plain[$ - 1] != '\n') stderr.writeln();
            stderr.writeln("-----END SECRET-----");
         }

         stderr.writeln("Received. The room is gone.");
         return Exit.done;
      }

      if (reply.flag("delivered") && role == "sender")
      {
         stderr.writeln("Delivered. The room is gone.");
         return Exit.done;
      }

      immutable state = reply.text("state");

      if (state == "ready" && role == "sender" && !sent)
         return hand();

      if (state == "burned")
      {
         stderr.writeln("Nothing was sent. The room is gone.");
         return Exit.gone;
      }

      if (state == "ready" && role == "receiver")
         stderr.writeln("Both confirmed. Waiting for them to send it.");

      return Exit.running;
   }

   private bool agree()
   {
      stderr.writeln();
      stderr.writeln("Do you both see these four?");
      stderr.writeln();

      foreach (index; session.symbols)
         stderr.writeln("   " ~ index.say);

      stderr.writeln();

      if (confirm("They match on both screens? [y/N]"))
      {
         confirmed = true;

         JSONValue request;
         request["id"] = id;
         request["token"] = token;

         auto reply = api.call("confirm", request);
         if (reply.ok) return true;

         stderr.writeln("The confirmation did not go through.");
         return false;
      }

      stderr.writeln("Stopped. Nothing was sent.");
      cancel();
      return false;
   }

   private Exit hand()
   {
      auto plain = readSecret(options.file);
      scope (exit) wipe(plain);

      if (plain.length == 0)
      {
         stderr.writeln("Nothing to send.");
         cancel();
         return Exit.misuse;
      }

      if (plain.length > maxSecretBytes)
      {
         import std.conv : to;

         stderr.writeln("That is " ~ (plain.length / 1024).to!string ~ " KB. This is made for "
            ~ "secrets — a password, a key, a short config — not for files.");
         cancel();
         return Exit.misuse;
      }

      JSONValue request;
      request["id"] = id;
      request["token"] = token;
      request["ct"] = seal(session, id, plain);

      auto reply = api.call("deliver", request);
      if (!reply.ok)
      {
         stderr.writeln("It did not go through. Nothing was delivered.");
         return Exit.unreachable;
      }

      sent = true;
      stderr.writeln("Sent. Waiting for them to pick it up.");

      return Exit.running;
   }

   private void announce()
   {
      immutable link = options.url ~ "/r/" ~ id;

      stderr.writeln();
      stderr.writeln("   " ~ link);
      stderr.writeln();

      if (options.qr && talkingToAPerson)
      {
         import qr : ErrorCorrectionLevel, QrCode;

         stderr.write(QrCode(link, ErrorCorrectionLevel.MEDIUM_LOW)
            .toString(2, options.dense, false));
         stderr.writeln();
      }

      stderr.writeln("This link is not a secret: it is just an address. Send it however you like.");
      stderr.writeln("Waiting for the other side. Keep this running.");
   }

   private void cancel()
   {
      if (id.length == 0 || token.length == 0) return;

      JSONValue request;
      request["id"] = id;
      request["token"] = token;
      api.call("cancel", request);
   }

   private Exit complain(in JSONValue reply)
   {
      immutable reason = reply.errorOf;

      if (reason == "network")
         stderr.writeln("Cannot reach " ~ options.url ~ ".");
      else if (reason == "ratelimit")
         stderr.writeln("Too many rooms opened from here. Try again shortly.");
      else if (reason == "busy")
         stderr.writeln("The service is full at the moment.");
      else
         stderr.writeln("The server refused: " ~ reason ~ ".");

      return Exit.unreachable;
   }
}

/// The secret never travels through the command line, where every process could read it.
private ubyte[] readSecret(string file)
{
   import std.file : read;
   import std.stdio : stdin;
   import std.string : chomp;

   if (file.length)
   {
      if (file == "-") return readAll();
      return cast(ubyte[]) read(file);
   }

   if (secretOnStdin) return readAll();

   auto typed = askSecret("The secret:");
   return cast(ubyte[]) typed.dup;
}

private ubyte[] readAll()
{
   import std.stdio : stdin;

   ubyte[] all;
   ubyte[4096] chunk;

   while (!stdin.eof)
   {
      auto got = stdin.rawRead(chunk[]);
      if (got.length == 0) break;
      all ~= got;
   }

   return all;
}

private __gshared bool interruptedFlag;

bool interrupted() { return interruptedFlag; }

extern (C) void onInterrupt(int) nothrow @nogc
{
   interruptedFlag = true;
}

unittest // the client is useful before it is configured
{
   Options fresh;
   assert(fresh.url == "https://neverstored.com",
      "the default instance moved: the page at /cli and the README say where it points");
}
