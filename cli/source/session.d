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

/// Past the deadline the server last gave, the room is gone whether or not it can be asked.
private enum deadlineSlack = 5.seconds;

struct Exchange
{
   private Api api;
   private Options options;
   private Identity self;
   private Session session;

   private string id;
   private string token;
   private string peerCommit;
   private bool owner;
   private string role;
   private ulong ver;

   private bool haveSession;
   private bool confirmed;
   private bool sent;
   private bool peerSeen;
   private bool expiryWarned;
   private MonoTime roomDeadline;

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
      request["commit"] = self.commit;
      owner = true;

      auto reply = api.call("create", request);
      if (!reply.ok) return complain(reply);

      id = reply.text("id");
      token = reply.text("token");
      roomDeadline = MonoTime.currTime + 30.seconds;
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
      peerCommit = reply.text("peerCommit");
      roomDeadline = MonoTime.currTime + 30.seconds;
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

         auto reply = persist("poll", request);

         if (!reply.ok)
         {
            if (reply.errorOf == "notfound")
            {
               stderr.writeln("That room is gone. Nothing was left behind.");
               return Exit.gone;
            }
            return complain(reply);
         }

         immutable left = reply.number("expiresIn");
         if (left > 0) roomDeadline = MonoTime.currTime + left.seconds;

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

   /+ A request that did not get through is sent again for as long as the room can still be
    + there: the page does the same, and a moment in a tunnel is not the end of an exchange.
    + Only what is safe to repeat comes through here. A repeated poll, reveal or confirm
    + changes nothing; a repeated delivery is refused when the first one landed, and `unsure`
    + is what lets the caller read that refusal for what it is.
   +/
   private JSONValue persist(string op, JSONValue request)
   {
      bool unsure;
      return persist(op, request, unsure);
   }

   private JSONValue persist(string op, JSONValue request, out bool unsure)
   {
      bool warned;

      while (true)
      {
         auto reply = api.call(op, request);
         if (reply.errorOf != "network") return reply;

         unsure = true;
         if (MonoTime.currTime > roomDeadline + deadlineSlack) return reply;

         if (!warned)
         {
            warned = true;
            stderr.writeln("Trouble reaching the server. Still trying.");
         }

         Thread.sleep(1.seconds);
         if (interrupted) return failure("interrupted");
      }
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
         // Whoever joined holds the promise made before they arrived; whoever opened the
         // room hands its key over only now, having seen the other one.
         if (!owner && !opens(peerCommit, peerPub))
         {
            stderr.writeln(tampered);
            cancel();
            return Exit.refused;
         }

         session = deriveSession(self, peerPub, id);
         haveSession = true;

         if (owner)
         {
            JSONValue request;
            request["id"] = id;
            request["token"] = token;
            request["pub"] = self.pub;

            auto revealed = persist("reveal", request);
            if (!revealed.ok) return complain(revealed);
         }

         immutable agreed = agree();
         if (agreed != Exit.running) return agreed;
      }

      auto ct = reply.text("ct");
      if (ct.length)
      {
         // Only a hand on the way can make a sealed payload fail to open once the symbols
         // matched: that is interference, not an outage.
         ubyte[] plain;
         try plain = unseal(session, id, ct);
         catch (Exception e)
         {
            stderr.writeln(e.msg);
            return Exit.refused;
         }
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
         stderr.writeln("Picked up by their device. The room is gone.");
         return Exit.done;
      }

      immutable state = reply.text("state");

      if (state == "ready" && role == "sender" && !sent)
         return hand();

      // Picking the payload up is what burns the room, so a burned room that says it was
      // delivered, to the side that never saw it, lost it on the way here.
      if (state == "burned" && reply.flag("delivered") && role == "receiver")
      {
         stderr.writeln("It was lost on the way here: the connection dropped after it left "
            ~ "the room, and the room went with it. Ask them to send it again.");
         return Exit.unreachable;
      }

      if (state == "burned")
      {
         stderr.writeln("Nothing was sent. The room is gone.");
         return Exit.gone;
      }

      if (state == "ready" && role == "receiver")
         stderr.writeln("Both confirmed. Waiting for them to send it.");

      return Exit.running;
   }

   private Exit agree()
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

         // A confirmation that landed and lost its answer may have been the second one, and
         // the room moved on to ready: the refusal of a repeat means it went through.
         bool unsure;
         auto reply = persist("confirm", request, unsure);
         if (reply.ok || (unsure && reply.errorOf == "state")) return Exit.running;

         if (reply.errorOf == "notfound")
         {
            stderr.writeln("That room is gone. Nothing was left behind.");
            return Exit.gone;
         }

         stderr.writeln("The confirmation did not go through.");
         cancel();
         return Exit.unreachable;
      }

      cancel();

      if (interrupted) return Exit.gone;

      stderr.writeln("Stopped. Nothing was sent.");
      return Exit.refused;
   }

   private Exit hand()
   {
      auto plain = readSecret(options.file);
      scope (exit) wipe(plain);

      if (interrupted)
      {
         cancel();
         return Exit.gone;
      }

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

      bool unsure;
      auto reply = persist("deliver", request, unsure);

      // A delivery whose answer was lost and that landed anyway is refused the second time,
      // because the room already holds one: that refusal is the answer the first one lost.
      immutable landed = reply.ok || (unsure && reply.errorOf == "state");

      if (!landed)
      {
         if (reply.errorOf == "notfound")
         {
            stderr.writeln("That room is gone. Nothing was delivered.");
            return Exit.gone;
         }

         if (reply.errorOf == "network")
         {
            stderr.writeln("The connection dropped while handing it over. It may have arrived "
               ~ "anyway: ask them.");
            return Exit.unreachable;
         }

         stderr.writeln("It did not go through. Nothing was delivered.");
         cancel();
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

   /// Said once, briefly, and even after Ctrl-C: the other side should hear that this one
   /// left rather than wait for the room to run out.
   private void cancel()
   {
      if (id.length == 0 || token.length == 0) return;

      JSONValue request;
      request["id"] = id;
      request["token"] = token;
      api.call("cancel", request, 3.seconds, false);

      id = null;
   }

   /// Every way out that is not the end of the exchange goes through here, and closes the
   /// room on the way, so the other side is not left waiting for someone who has gone.
   private Exit complain(in JSONValue reply)
   {
      immutable reason = reply.errorOf;

      cancel();

      if (reason == "interrupted")
         return Exit.gone;

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

unittest // the client is useful before it is configured
{
   Options fresh;
   assert(fresh.url == "https://neverstored.com",
      "the default instance moved: the page at /cli and the README say where it points");
}
