module neverstored.room;

import core.time : Duration, MonoTime, minutes, seconds;

enum State : ubyte { created, paired, ready, burned }

/// Who types the secret: the person who created the room (send) or the one who joins (request).
enum Flow : ubyte { send, request }

enum Side : ubyte { creator = 0, joiner = 1 }

enum Err : ubyte
{
   ok,
   notFound,
   wrongState,
   notYourTurn,
   occupied,
   tooBig,
   badInput
}

/// This is for secrets, not for files: a password, a key, a PEM, a short config. Anything
/// larger is somebody using the service as a transfer channel.
enum maxSecretBytes = 8 * 1024;
enum maxPayloadBytes = maxSecretBytes + 64;
enum maxPubKeyBytes = 256;

enum createdTimeout = 10.minutes;
enum pairedTimeout = 5.minutes;
enum readyTimeout = 2.minutes;
enum tombstoneTimeout = 2.minutes;

struct Room
{
   string id;
   Flow flow;
   State state;
   ulong ver = 1;
   MonoTime deadline;

   string[2] tokens;
   ubyte[][2] pubKeys;
   bool[2] confirmed;

   ubyte[] payload;
   bool delivered;
   string creatorBucket;

   Side sender() const
   {
      return flow == Flow.send ? Side.creator : Side.joiner;
   }

   Side receiver() const
   {
      return flow == Flow.send ? Side.joiner : Side.creator;
   }

   bool expired(MonoTime now) const
   {
      return now >= deadline;
   }

   private void touch(Duration lifetime, MonoTime now)
   {
      ver++;
      deadline = now + lifetime;
   }

   Err join(const(ubyte)[] pubKey, MonoTime now)
   {
      if (state != State.created) return state == State.paired || state == State.ready
         ? Err.occupied : Err.wrongState;
      if (pubKey.length == 0 || pubKey.length > maxPubKeyBytes) return Err.badInput;

      pubKeys[Side.joiner] = pubKey.dup;
      state = State.paired;
      touch(pairedTimeout, now);
      return Err.ok;
   }

   Err confirm(Side side, MonoTime now)
   {
      if (state != State.paired) return Err.wrongState;

      confirmed[side] = true;
      if (confirmed[Side.creator] && confirmed[Side.joiner])
      {
         state = State.ready;
         touch(readyTimeout, now);
      }
      else touch(pairedTimeout, now);

      return Err.ok;
   }

   Err deliver(Side side, const(ubyte)[] ciphertext, MonoTime now)
   {
      if (state != State.ready) return Err.wrongState;
      if (side != sender) return Err.notYourTurn;
      if (payload.length) return Err.wrongState;
      if (ciphertext.length == 0) return Err.badInput;
      if (ciphertext.length > maxPayloadBytes) return Err.tooBig;

      payload = ciphertext.dup;
      touch(readyTimeout, now);
      return Err.ok;
   }

   /// The recipient picks the payload up exactly once; the room dies with it.
   Err take(Side side, MonoTime now, out ubyte[] ciphertext)
   {
      if (state != State.ready) return Err.wrongState;
      if (side != receiver) return Err.notYourTurn;
      if (payload.length == 0) return Err.wrongState;

      ciphertext = payload;
      payload = null;
      delivered = true;
      state = State.burned;
      touch(tombstoneTimeout, now);
      return Err.ok;
   }

   void burn(MonoTime now)
   {
      wipe(payload);
      payload = null;
      state = State.burned;
      touch(tombstoneTimeout, now);
   }
}

/// Overwrite a buffer so the compiler cannot elide the store.
void wipe(ubyte[] buf) @trusted
{
   import core.volatile : volatileStore;

   foreach (i; 0 .. buf.length)
      volatileStore(&buf[i], ubyte(0));
}

bool constantTimeEquals(const(char)[] a, const(char)[] b) @safe pure
{
   if (a.length != b.length) return false;

   ubyte diff = 0;
   foreach (i; 0 .. a.length)
      diff |= cast(ubyte)(a[i] ^ b[i]);

   return diff == 0;
}

version (unittest)
{
   private Room makeRoom(Flow flow = Flow.send)
   {
      Room r;
      r.id = "test";
      r.flow = flow;
      r.state = State.created;
      r.tokens = ["a", "b"];
      r.pubKeys[Side.creator] = [1, 2, 3];
      r.deadline = MonoTime.currTime + createdTimeout;
      return r;
   }
}

unittest // a room only pairs once: the third participant finds the door shut
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();

   assert(r.join([4, 5, 6], now) == Err.ok);
   assert(r.state == State.paired);
   assert(r.join([7, 8, 9], now) == Err.occupied);
   assert(r.pubKeys[Side.joiner] == [4, 5, 6]);
}

unittest // no delivery before both sides confirmed the symbols
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();

   assert(r.deliver(Side.creator, [1], now) == Err.wrongState);
   r.join([4], now);
   assert(r.deliver(Side.creator, [1], now) == Err.wrongState);
   r.confirm(Side.creator, now);
   assert(r.state == State.paired);
   assert(r.deliver(Side.creator, [1], now) == Err.wrongState);
   r.confirm(Side.joiner, now);
   assert(r.state == State.ready);
   assert(r.deliver(Side.creator, [1], now) == Err.ok);
}

unittest // only the side holding the secret may deliver, in either flow
{
   auto now = MonoTime.currTime;

   auto send = makeRoom(Flow.send);
   send.join([4], now);
   send.confirm(Side.creator, now);
   send.confirm(Side.joiner, now);
   assert(send.deliver(Side.joiner, [1], now) == Err.notYourTurn);
   assert(send.deliver(Side.creator, [1], now) == Err.ok);

   auto request = makeRoom(Flow.request);
   request.join([4], now);
   request.confirm(Side.creator, now);
   request.confirm(Side.joiner, now);
   assert(request.deliver(Side.creator, [1], now) == Err.notYourTurn);
   assert(request.deliver(Side.joiner, [1], now) == Err.ok);
}

unittest // the payload is picked up once, by the recipient, and burns the room
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();
   r.join([4], now);
   r.confirm(Side.creator, now);
   r.confirm(Side.joiner, now);
   r.deliver(Side.creator, [42], now);

   ubyte[] got;
   assert(r.take(Side.creator, now, got) == Err.notYourTurn);
   assert(r.take(Side.joiner, now, got) == Err.ok);
   assert(got == [42]);
   assert(r.state == State.burned);
   assert(r.delivered);
   assert(r.take(Side.joiner, now, got) == Err.wrongState);
}

unittest // a second delivery on the same room is refused
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();
   r.join([4], now);
   r.confirm(Side.creator, now);
   r.confirm(Side.joiner, now);

   assert(r.deliver(Side.creator, [1], now) == Err.ok);
   assert(r.deliver(Side.creator, [2], now) == Err.wrongState);
}

unittest // oversized and empty payloads are refused
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();
   r.join([4], now);
   r.confirm(Side.creator, now);
   r.confirm(Side.joiner, now);

   auto huge = new ubyte[maxPayloadBytes + 1];
   assert(r.deliver(Side.creator, huge, now) == Err.tooBig);
   assert(r.deliver(Side.creator, [], now) == Err.badInput);
}

unittest // an oversized or empty public key never enters the room
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();

   assert(r.join([], now) == Err.badInput);
   assert(r.join(new ubyte[maxPubKeyBytes + 1], now) == Err.badInput);
   assert(r.state == State.created);
}

unittest // joining a burned room is refused, and burning wipes the payload
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();
   r.join([4], now);
   r.confirm(Side.creator, now);
   r.confirm(Side.joiner, now);
   r.deliver(Side.creator, [1, 2, 3], now);

   auto held = r.payload;
   r.burn(now);
   assert(held == [0, 0, 0]);
   assert(r.state == State.burned);
   assert(r.join([9], now) == Err.wrongState);
}

unittest // every mutation moves the version, so conditional polls cannot miss an event
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();
   auto seen = r.ver;

   r.join([4], now);
   assert(r.ver > seen);
   seen = r.ver;
   r.confirm(Side.creator, now);
   assert(r.ver > seen);
   seen = r.ver;
   r.confirm(Side.joiner, now);
   assert(r.ver > seen);
   seen = r.ver;
   r.deliver(Side.creator, [1], now);
   assert(r.ver > seen);
}

unittest // deadlines shrink as the exchange becomes active
{
   auto now = MonoTime.currTime;
   auto r = makeRoom();
   assert(!r.expired(now));

   r.join([4], now);
   assert(r.deadline == now + pairedTimeout);
   r.confirm(Side.creator, now);
   r.confirm(Side.joiner, now);
   assert(r.deadline == now + readyTimeout);
   assert(r.expired(now + readyTimeout));
}

unittest
{
   assert(constantTimeEquals("abc", "abc"));
   assert(!constantTimeEquals("abc", "abd"));
   assert(!constantTimeEquals("abc", "ab"));
   assert(constantTimeEquals("", ""));
}
