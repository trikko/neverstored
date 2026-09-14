module neverstored.broker;

import neverstored.proto;
import neverstored.rnd;
import neverstored.room;

import core.time : Duration, MonoTime, msecs, seconds;
import std.json : JSONType, JSONValue;
import std.socket;

enum maxRoomsPerVisitor = 20;
enum maxRooms = 10_000;

struct Broker
{
   private Room[string] rooms;
   private int[string] roomsPerBucket;
   private ubyte[32] bucketKey;
   private bool keyed;

   /+ Addresses are counted, never kept.

    + The key comes from the CSPRNG when the first room is created and never leaves memory, so
    + the bucket cannot be turned back into an address: a bare digest could not promise that,
    + because the whole IPv4 space is small enough to hash exhaustively. It dies with the
    + process, which also means the same visitor is a different bucket after a restart.
   +/
   private string bucketOf(string ip)
   {
      import std.digest : toHexString;
      import std.digest.hmac : HMAC;
      import std.digest.sha : SHA256;

      if (!keyed)
      {
         fillRandom(bucketKey[]);
         keyed = true;
      }

      auto mac = HMAC!SHA256(bucketKey[]);
      mac.put(cast(const(ubyte)[]) ip);

      return mac.finish()[0 .. 16].toHexString().idup;
   }

   JSONValue handle(in JSONValue request, MonoTime now)
   {
      switch (request.readString("op"))
      {
         case "create": return create(request, now);
         case "join": return join(request, now);
         case "poll": return poll(request, now);
         case "confirm": return confirm(request, now);
         case "deliver": return deliver(request, now);
         case "cancel": return cancel(request, now);
         default: return failure("badop");
      }
   }

   void sweep(MonoTime now)
   {
      string[] doomed;

      foreach (id, ref room; rooms)
         if (room.expired(now)) doomed ~= id;

      foreach (id; doomed) drop(id, now);
   }

   size_t roomCount() const { return rooms.length; }

   private void drop(string id, MonoTime now)
   {
      auto room = id in rooms;
      if (room is null) return;

      room.burn(now);

      if (room.creatorBucket.length)
      {
         auto counter = room.creatorBucket in roomsPerBucket;
         if (counter !is null && --(*counter) <= 0) roomsPerBucket.remove(room.creatorBucket);
      }

      rooms.remove(id);
   }

   private JSONValue create(in JSONValue request, MonoTime now)
   {
      import std.base64 : Base64;

      if (rooms.length >= maxRooms) return failure("busy");

      /+ No address means the instance was started with NEVERSTORED_NO_PROXY: the operator
       + has said there is no proxy to ask, and only the global ceiling above applies. The API
       + refuses to create a room without one in every other case.
      +/
      immutable ip = request.readString("ip");
      immutable bucket = ip.length ? bucketOf(ip) : "";
      if (bucket.length && roomsPerBucket.get(bucket, 0) >= maxRoomsPerVisitor)
         return failure("ratelimit");

      ubyte[] pubKey;
      if (!decodeKey(request.readString("pub"), pubKey)) return failure("badinput");

      immutable flowName = request.readString("flow");
      if (flowName != "send" && flowName != "request") return failure("badinput");

      Room room;
      room.id = randomToken();
      room.flow = flowName == "send" ? Flow.send : Flow.request;
      room.state = State.created;
      room.tokens = [randomToken(), randomToken()];
      room.pubKeys[Side.creator] = pubKey;
      room.deadline = now + createdTimeout;
      room.creatorBucket = bucket;

      rooms[room.id] = room;
      if (bucket.length) roomsPerBucket[bucket] = roomsPerBucket.get(bucket, 0) + 1;

      JSONValue reply;
      reply["ok"] = true;
      reply["id"] = room.id;
      reply["token"] = room.tokens[Side.creator];
      reply["side"] = "creator";
      reply["ver"] = room.ver;
      return reply;
   }

   private JSONValue join(in JSONValue request, MonoTime now)
   {
      auto room = request.readString("id") in rooms;
      if (room is null || room.expired(now)) return failure("notfound");

      ubyte[] pubKey;
      if (!decodeKey(request.readString("pub"), pubKey)) return failure("badinput");

      immutable err = room.join(pubKey, now);
      if (err == Err.occupied) return failure("occupied");
      if (err != Err.ok) return failure("notfound");

      JSONValue reply;
      reply["ok"] = true;
      reply["token"] = room.tokens[Side.joiner];
      reply["side"] = "joiner";
      reply["ver"] = room.ver;
      return reply;
   }

   /+ How long the room has left, so neither client has to guess.

    + Every deadline in room.d is reported the same way, and it shrinks as the exchange moves
    + on: what the page counts down is the real sweep, not a copy of the constants that could
    + drift away from them.
   +/
   private static long secondsLeft(in Room room, MonoTime now)
   {
      immutable left = room.deadline - now;
      return left <= Duration.zero ? 0 : left.total!"seconds";
   }

   private JSONValue poll(in JSONValue request, MonoTime now)
   {
      Side side;
      auto room = authenticate(request, now, side);
      if (room is null) return failure("notfound");

      immutable seen = request.readUlong("v");
      if (seen == room.ver) return JSONValue([
         "ok": JSONValue(true),
         "changed": JSONValue(false),
         "expiresIn": JSONValue(secondsLeft(*room, now)),
      ]);

      JSONValue reply;
      reply["ok"] = true;
      reply["changed"] = true;
      reply["ver"] = room.ver;
      reply["expiresIn"] = secondsLeft(*room, now);
      reply["state"] = stateName(room.state);
      reply["role"] = side == room.sender ? "sender" : "receiver";
      reply["peer"] = room.state != State.created;
      reply["youConfirmed"] = room.confirmed[side];
      reply["peerConfirmed"] = room.confirmed[1 - side];
      reply["delivered"] = room.delivered;

      auto peerKey = room.pubKeys[1 - side];
      if (peerKey.length) reply["peerPub"] = encodeKey(peerKey);

      if (side == room.receiver && room.payload.length)
      {
         ubyte[] ciphertext;
         if (room.take(side, now, ciphertext) == Err.ok)
         {
            reply["ct"] = encodeKey(ciphertext);
            reply["ver"] = room.ver;
            reply["state"] = stateName(room.state);
            reply["delivered"] = true;
            wipe(ciphertext);
         }
      }

      return reply;
   }

   private JSONValue confirm(in JSONValue request, MonoTime now)
   {
      Side side;
      auto room = authenticate(request, now, side);
      if (room is null) return failure("notfound");

      if (room.confirm(side, now) != Err.ok) return failure("state");

      return JSONValue(["ok": JSONValue(true), "ver": JSONValue(room.ver)]);
   }

   private JSONValue deliver(in JSONValue request, MonoTime now)
   {
      Side side;
      auto room = authenticate(request, now, side);
      if (room is null) return failure("notfound");

      ubyte[] ciphertext;
      if (!decodePayload(request.readString("ct"), ciphertext)) return failure("badinput");

      immutable err = room.deliver(side, ciphertext, now);
      wipe(ciphertext);

      if (err == Err.tooBig) return failure("toobig");
      if (err != Err.ok) return failure("state");

      return JSONValue(["ok": JSONValue(true), "ver": JSONValue(room.ver)]);
   }

   private JSONValue cancel(in JSONValue request, MonoTime now)
   {
      Side side;
      auto room = authenticate(request, now, side);
      if (room is null) return failure("notfound");

      drop(room.id, now);
      return JSONValue(["ok": JSONValue(true)]);
   }

   /// A room id alone proves nothing: every operation needs the participant token
   /// handed out when that side entered the room.
   private Room* authenticate(in JSONValue request, MonoTime now, out Side side)
   {
      auto room = request.readString("id") in rooms;
      if (room is null || room.expired(now)) return null;

      immutable token = request.readString("token");
      if (token.length == 0) return null;

      if (constantTimeEquals(token, room.tokens[Side.creator])) side = Side.creator;
      else if (constantTimeEquals(token, room.tokens[Side.joiner])) side = Side.joiner;
      else return null;

      return room;
   }
}

private bool decodeKey(string encoded, out ubyte[] raw)
{
   return decodeBase64(encoded, maxPubKeyBytes, raw);
}

private bool decodePayload(string encoded, out ubyte[] raw)
{
   return decodeBase64(encoded, maxPayloadBytes, raw);
}

private bool decodeBase64(string encoded, size_t limit, out ubyte[] raw)
{
   import std.base64 : Base64;

   // Four base64 characters per three bytes: anything longer cannot decode within the
   // limit, so it is refused before spending anything on decoding it.
   if (encoded.length == 0 || encoded.length > ((limit + 2) / 3) * 4) return false;

   try raw = Base64.decode(encoded);
   catch (Exception) return false;

   return raw.length > 0 && raw.length <= limit;
}

private string encodeKey(const(ubyte)[] raw)
{
   import std.base64 : Base64;

   return Base64.encode(raw);
}

private string stateName(State state)
{
   final switch (state)
   {
      case State.created: return "created";
      case State.paired: return "paired";
      case State.ready: return "ready";
      case State.burned: return "burned";
   }
}

/// Runs on a thread of the daemon. Workers are spawned with fork followed by exec,
/// so they never inherit a page of this memory.
void startBroker(string socketPath)
{
   import core.thread : Thread;

   harden();

   auto thread = new Thread({ brokerLoop(socketPath); });
   thread.isDaemon = true;
   thread.start();
}

private void brokerLoop(string socketPath)
{
   import std.experimental.logger : info;
   import std.file : exists, remove;

   if (socketPath.exists) socketPath.remove();

   auto listener = new Socket(AddressFamily.UNIX, SocketType.STREAM);
   listener.bind(new UnixAddress(socketPath));
   listener.listen(64);
   restrictSocketFile(socketPath);

   info("broker listening on ", socketPath);

   Broker broker;
   Socket[] clients;
   auto readable = new SocketSet();

   while (true)
   {
      readable.reset();
      readable.add(listener);
      foreach (client; clients) readable.add(client);

      Socket.select(readable, null, null, 1.seconds);
      immutable now = MonoTime.currTime;

      if (readable.isSet(listener))
      {
         auto arrival = listener.accept();

         // Reading a frame blocks this loop, and this loop is also what expires rooms and
         // wipes payloads. A peer that stops mid-frame must cost a closed connection, not
         // a service that stops keeping its promises.
         arrival.setOption(SocketOptionLevel.SOCKET, SocketOption.RCVTIMEO, 250.msecs);
         arrival.setOption(SocketOptionLevel.SOCKET, SocketOption.SNDTIMEO, 250.msecs);

         clients ~= arrival;
      }

      Socket[] alive;
      foreach (client; clients)
      {
         if (!readable.isSet(client)) { alive ~= client; continue; }

         JSONValue request;
         if (!receiveFrame(client, request)) { client.close(); continue; }

         auto reply = broker.handle(request, now);
         if (!sendFrame(client, reply)) { client.close(); continue; }

         alive ~= client;
      }
      clients = alive;

      broker.sweep(now);
   }
}

/// Rooms live in this process now, so it must not be dumpable or swappable.
private void harden() @trusted
{
   version (linux)
   {
      import core.sys.linux.sys.prctl : prctl, PR_SET_DUMPABLE;
      import core.sys.posix.sys.mman : mlockall, MCL_CURRENT, MCL_FUTURE;
      import core.sys.posix.sys.resource : rlimit, setrlimit, RLIMIT_CORE;

      rlimit noCore = { 0, 0 };
      setrlimit(RLIMIT_CORE, &noCore);
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
      mlockall(MCL_CURRENT | MCL_FUTURE);
   }
}

private void restrictSocketFile(string path) @trusted
{
   version (Posix)
   {
      import std.string : toStringz;
      import core.sys.posix.sys.stat : chmod, S_IRUSR, S_IWUSR;

      chmod(path.toStringz, S_IRUSR | S_IWUSR);
   }
}

version (unittest)
{
   private JSONValue ask(const(char)[][string] fields)
   {
      JSONValue request;
      foreach (key, value; fields) request[key] = value.idup;
      return request;
   }

   private string[2] readyRoom(ref Broker broker, MonoTime now)
   {
      import std.base64 : Base64;

      immutable pub = Base64.encode(cast(const(ubyte)[]) "a public key");

      auto created = broker.handle(
         ask(["op": "create", "flow": "send", "pub": pub, "ip": "test"]), now);
      immutable id = created["id"].str;
      immutable creator = created["token"].str;

      auto joined = broker.handle(ask(["op": "join", "id": id, "pub": pub]), now);
      immutable joiner = joined["token"].str;

      broker.handle(ask(["op": "confirm", "id": id, "token": creator]), now);
      broker.handle(ask(["op": "confirm", "id": id, "token": joiner]), now);

      return [id, creator];
   }
}

unittest // a payload nobody ever picks up is wiped and forgotten, not left waiting
{
   import core.time : seconds;
   import std.base64 : Base64;

   Broker broker;
   immutable now = MonoTime.currTime;
   auto room = readyRoom(broker, now);

   auto delivered = broker.handle(ask([
      "op": "deliver", "id": room[0], "token": room[1],
      "ct": Base64.encode(cast(const(ubyte)[]) "sealed bytes"),
   ]), now);
   import std.json : JSONType;
   assert(delivered["ok"].type == JSONType.true_);

   auto held = (room[0] in broker.rooms).payload;
   assert(held.length > 0);

   broker.sweep(now + readyTimeout + 1.seconds);

   assert((room[0] in broker.rooms) is null, "the room outlived its deadline");
   foreach (b; held) assert(b == 0, "the payload was dropped without being wiped");
}

unittest // an untouched room goes the same way, and frees its rate limit slot
{
   import core.time : seconds;

   Broker broker;
   immutable now = MonoTime.currTime;
   auto room = readyRoom(broker, now);

   assert(broker.roomCount == 1);
   broker.sweep(now + readyTimeout + 1.seconds);
   assert(broker.roomCount == 0);

   foreach (i; 0 .. maxRoomsPerVisitor)
      readyRoom(broker, now + readyTimeout + 2.seconds);
}

unittest // visitors are counted apart, and one of them cannot spend everybody's allowance
{
   import std.base64 : Base64;
   import std.json : JSONType;

   Broker broker;
   immutable now = MonoTime.currTime;
   immutable pub = Base64.encode(cast(const(ubyte)[]) "a public key");

   JSONValue open(string ip)
   {
      return broker.handle(ask(["op": "create", "flow": "send", "pub": pub, "ip": ip]), now);
   }

   foreach (i; 0 .. maxRoomsPerVisitor)
      assert(open("198.51.100.7")["ok"].type == JSONType.true_);

   assert(open("198.51.100.7").readString("err") == "ratelimit");
   assert(open("198.51.100.8")["ok"].type == JSONType.true_,
      "one visitor's allowance was charged to another");
}

unittest // the address is counted, never kept: what a room holds cannot be read back
{
   import std.algorithm : canFind;
   import std.base64 : Base64;

   Broker broker;
   immutable now = MonoTime.currTime;
   immutable pub = Base64.encode(cast(const(ubyte)[]) "a public key");
   immutable ip = "198.51.100.7";

   auto created = broker.handle(ask(["op": "create", "flow": "send", "pub": pub, "ip": ip]), now);
   immutable kept = (created["id"].str in broker.rooms).creatorBucket;

   assert(kept.length, "the visitor was not counted at all");
   assert(!kept.canFind(ip), "the room kept the address itself");
   assert(kept != broker.bucketOf("198.51.100.8"), "two addresses landed in one bucket");
   assert(kept == broker.bucketOf(ip), "the same address moved between buckets");

   Broker other;
   assert(other.bucketOf(ip) != kept, "the bucket survives the key it was made with");
}

unittest // with no address to count, only the global ceiling is left
{
   import std.base64 : Base64;
   import std.json : JSONType;

   Broker broker;
   immutable now = MonoTime.currTime;
   immutable pub = Base64.encode(cast(const(ubyte)[]) "a public key");

   foreach (i; 0 .. maxRoomsPerVisitor + 5)
      assert(broker.handle(ask(["op": "create", "flow": "send", "pub": pub]), now)["ok"].type
         == JSONType.true_);

   assert(broker.roomCount == maxRoomsPerVisitor + 5);
}

unittest // the room says how long it has, and says less of it as the exchange moves on
{
   import core.time : minutes, seconds;
   import std.base64 : Base64;

   Broker broker;
   immutable now = MonoTime.currTime;
   immutable pub = Base64.encode(cast(const(ubyte)[]) "a public key");

   auto created = broker.handle(
      ask(["op": "create", "flow": "send", "pub": pub, "ip": "198.51.100.7"]), now);
   immutable id = created["id"].str;
   immutable creator = created["token"].str;

   JSONValue pollAt(ulong seen, MonoTime at)
   {
      JSONValue request;
      request["op"] = "poll";
      request["id"] = id;
      request["token"] = creator;
      request["v"] = seen;
      return broker.handle(request, at);
   }

   long left(MonoTime at) { return pollAt(0, at)["expiresIn"].integer; }

   assert(left(now) == createdTimeout.total!"seconds");
   assert(left(now + 1.minutes) == (createdTimeout - 1.minutes).total!"seconds",
      "the countdown does not follow the clock");

   auto joined = broker.handle(ask(["op": "join", "id": id, "pub": pub]), now);
   assert(left(now) == pairedTimeout.total!"seconds", "pairing did not shorten the room");

   broker.handle(ask(["op": "confirm", "id": id, "token": creator]), now);
   broker.handle(ask(["op": "confirm", "id": id, "token": joined["token"].str]), now);
   assert(left(now) == readyTimeout.total!"seconds");

   // An unchanged reply is the one the page sees most of the time: it has to carry it too.
   immutable ver = pollAt(0, now)["ver"].uinteger;
   auto quiet = pollAt(ver, now);
   assert(quiet["changed"].type == JSONType.false_, "the room reported a change it did not have");
   assert(quiet["expiresIn"].integer == readyTimeout.total!"seconds");

   assert(left(now + readyTimeout - 1.seconds) == 1, "the last second was not counted");

   // Past the deadline there is nothing left to report on: the room is simply not there.
   assert(pollAt(0, now + readyTimeout).readString("err") == "notfound");
}
