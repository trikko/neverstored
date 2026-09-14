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
