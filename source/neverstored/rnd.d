module neverstored.rnd;

/// Room ids and participant tokens come from the OS CSPRNG, never from a PRNG.
string randomToken(size_t bytes = 16)
{
   import std.base64 : Base64URLNoPadding;

   ubyte[] raw = new ubyte[bytes];
   fillRandom(raw);

   return Base64URLNoPadding.encode(raw);
}

void fillRandom(ubyte[] buffer) @trusted
{
   import std.stdio : File;

   static File urandom;
   if (!urandom.isOpen) urandom = File("/dev/urandom", "rb");

   auto got = urandom.rawRead(buffer);
   if (got.length != buffer.length) throw new Exception("CSPRNG short read");
}

unittest // tokens are unique and use the url-safe alphabet only
{
   import std.algorithm : all, canFind;

   bool[string] seen;
   foreach (i; 0 .. 5000)
   {
      auto token = randomToken();
      assert(token !in seen, "CSPRNG produced a duplicate token");
      assert(token.length == 22);
      assert(token.all!(c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
         || (c >= '0' && c <= '9') || c == '-' || c == '_'));
      seen[token] = true;
   }
}

unittest // consecutive tokens must not share a prefix, which would betray a counter or a clock
{
   auto a = randomToken();
   auto b = randomToken();
   assert(a[0 .. 8] != b[0 .. 8]);
}

/// Room ids are base64url tokens; anything else never reaches the broker.
bool isRoomId(string id) @safe pure
{
   if (id.length != 22) return false;

   /+ Sixteen bytes are 128 bits and twenty-two base64 characters hold 132, so the last four
    + bits of the last character are always zero: a real id ends in one of four characters
    + out of sixty-four. Refusing the rest turns fifteen invented links out of sixteen into
    + a plain "nothing here", without asking the broker anything.
   +/
   immutable tail = id[$ - 1];
   if (tail != 'A' && tail != 'Q' && tail != 'g' && tail != 'w') return false;

   foreach (c; id)
   {
      immutable bool allowed = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
         || (c >= '0' && c <= '9') || c == '-' || c == '_';
      if (!allowed) return false;
   }

   return true;
}

unittest // ids outside the alphabet never reach the broker
{
   assert(isRoomId("AAAAAAAAAAAAAAAAAAAAAA"));
   assert(isRoomId(randomToken()));
   assert(!isRoomId(""));
   assert(!isRoomId("short"));
   assert(!isRoomId("../../../../etc/passwd"));
   assert(!isRoomId("AAAAAAAAAAAAAAAAAAAAA."));
   assert(!isRoomId("AAAAAAAAAAAAAAAAAAAAAAA"));
}

unittest // the last character of sixteen random bytes carries two bits, not six
{
   import std.algorithm : all, canFind;

   foreach (i; 0 .. 2000)
      assert(isRoomId(randomToken()));

   // A string the alphabet allows but the encoder can never produce is not a room id, and
   // saying so costs nothing: fifteen invented links out of sixteen stop at the front door.
   assert(!isRoomId("AAAAAAAAAAAAAAAAAAAAAB"));
   assert(!isRoomId("sdflkjsdfsdflkjsdfsdfz"));

   foreach (tail; "AQgw")
      assert(isRoomId("AAAAAAAAAAAAAAAAAAAAA" ~ tail));
}
