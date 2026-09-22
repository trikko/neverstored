module neverstored.visitor;

import serverino : Request;

/+ Who is asking, as the reverse proxy reports it.

 + The entry to trust is the LAST one. The proxy appends the address it actually accepted the
 + connection from; anything before it was written by the client and can say whatever it likes,
 + so a visitor who sends a header of their own gets a bucket that still hashes to their real
 + address. The peer address of the connection is never consulted: behind a proxy it is the
 + proxy's, the same for everybody, and counting on it would put every visitor in one bucket.
+/
string forwardedFor(Request request)
{
   import std.algorithm : splitter;
   import std.string : strip;

   string last;
   foreach (hop; request.header.read("x-forwarded-for").splitter(','))
   {
      auto trimmed = hop.strip;
      if (trimmed.length) last = trimmed;
   }

   return last;
}

/+ The unit a visitor is counted in.

 + An IPv4 address is one, but an IPv6 host is handed a whole /64 and may speak from any
 + address in it: counted one address at a time, a single visitor would fill the service. The
 + prefix is written out in one canonical form, so two spellings of it are one visitor.
+/
string networkOf(string ip)
{
   import std.format : format;
   import std.socket : Internet6Address, SocketException;

   ubyte[16] raw;
   try raw = Internet6Address.parse(ip);
   catch (SocketException) return ip;

   immutable ubyte[12] mapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
   if (raw[0 .. 12] == mapped[]) return format("%d.%d.%d.%d", raw[12], raw[13], raw[14], raw[15]);

   return format("%(%02x%)/64", raw[0 .. 8]);
}

/// Set when the instance is knowingly run with no reverse proxy in front of it.
bool noProxy()
{
   import std.process : environment;

   static bool asked;
   static bool answer;

   if (!asked)
   {
      answer = environment.get("NEVERSTORED_NO_PROXY", "").length > 0;
      asked = true;
   }

   return answer;
}

/// A proxy that does not pass the header leaves the instance unable to tell visitors apart.
bool misconfigured(Request request)
{
   return !noProxy() && forwardedFor(request).length == 0;
}

/+ Whether the browser is fetching this ahead of anyone asking for it.

 + A prefetch or a prerender is the one bot-like request that announces itself honestly, each
 + engine in its own spelling. A join made on its behalf would pair the room with nobody and
 + leave the person the link was sent to locked out of it, so the announcement is taken at
 + face value: a client that lies here is simply a client that did not prefetch.
+/
bool speculative(Request request)
{
   import std.algorithm : canFind;
   import std.uni : toLower;

   foreach (name; ["sec-purpose", "purpose", "x-purpose", "x-moz"])
   {
      immutable value = request.header.read(name).toLower;
      if (value.canFind("prefetch") || value.canFind("prerender") || value.canFind("preview"))
         return true;
   }

   return false;
}

unittest // one IPv6 visitor is a /64, not one of the addresses in it
{
   // Every home and every VPS is handed a whole /64: counting single addresses would give
   // each visitor eighteen quintillion allowances, and a few hundred fill the service.
   assert(networkOf("2001:db8:1:2::1") == networkOf("2001:db8:1:2:ffff:ffff:ffff:ffff"));
   assert(networkOf("2001:db8:1:2::1") == networkOf("2001:0db8:0001:0002:0:0:0:7"),
      "two spellings of one network were counted apart");
   assert(networkOf("2001:db8:1:2::1") != networkOf("2001:db8:1:3::1"));

   assert(networkOf("198.51.100.7") == "198.51.100.7");
   assert(networkOf("198.51.100.7") != networkOf("198.51.100.8"));
   assert(networkOf("::ffff:198.51.100.7") == "198.51.100.7",
      "an IPv4 visitor seen through a dual stack socket became someone else");

   assert(networkOf("not an address") == "not an address");
}
