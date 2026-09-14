module wire;

import std.json : JSONValue, parseJSON;

/// Talks to the same JSON API the page uses. Logical failures come back as {ok:false,err},
/// so transport errors are reported the same way and every caller has one thing to check.
struct Api
{
   string base;

   JSONValue call(string op, JSONValue request)
   {
      import std.net.curl : HTTP, post, CurlException;

      auto http = HTTP();
      http.addRequestHeader("content-type", "application/json");
      http.addRequestHeader("user-agent", "neverstored-cli");

      try return parseJSON(cast(string) post(base ~ "/api/" ~ op, request.toString(), http));
      catch (CurlException e) return failure("network");
      catch (Exception e) return failure("badreply");
   }
}

JSONValue failure(string reason)
{
   JSONValue out_;
   out_["ok"] = false;
   out_["err"] = reason;
   return out_;
}

bool ok(in JSONValue reply)
{
   import std.json : JSONType;

   auto found = "ok" in reply.object;
   return found !is null && found.type == JSONType.true_;
}

string errorOf(in JSONValue reply)
{
   return text(reply, "err");
}

string text(in JSONValue value, string key)
{
   import std.json : JSONType;

   if (value.type != JSONType.object) return null;
   auto found = key in value.object;
   if (found is null || found.type != JSONType.string) return null;

   return found.str;
}

bool flag(in JSONValue value, string key)
{
   import std.json : JSONType;

   if (value.type != JSONType.object) return false;
   auto found = key in value.object;

   return found !is null && found.type == JSONType.true_;
}

ulong number(in JSONValue value, string key)
{
   import std.json : JSONType;

   if (value.type != JSONType.object) return 0;
   auto found = key in value.object;
   if (found is null || found.type != JSONType.integer) return 0;
   if (found.integer < 0) return 0;

   return cast(ulong) found.integer;
}
