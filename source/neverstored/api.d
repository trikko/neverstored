module neverstored.api;

import neverstored.client;
import neverstored.proto;
import neverstored.room : maxPayloadBytes, wipe;
import neverstored.visitor : forwardedFor, noProxy, speculative;

import serverino;
import std.json : JSONValue, JSONType, parseJSON;

/// The largest honest request is a delivery: 8256 bytes of payload become 11008 characters
/// of base64, plus a few dozen of JSON around them. Everything else is far smaller.
enum maxBodyBytes = 12 * 1024;

@endpoint @route!(r => r.path == "/api/create" || r.path == "/api/join"
   || r.path == "/api/poll" || r.path == "/api/confirm"
   || r.path == "/api/deliver" || r.path == "/api/cancel")
void api(Request request, Output output)
{
   output.addHeader("content-type", "application/json");
   output.addHeader("cache-control", "no-store");

   if (request.method != Request.Method.Post)
   {
      output.status = 405;
      output ~= failure("method").toString();
      return;
   }

   if (speculative(request))
   {
      output ~= failure("speculative").toString();
      return;
   }

   auto raw = request.body.data;
   if (raw.length == 0 || raw.length > maxBodyBytes)
   {
      output.status = 413;
      output ~= failure("toobig").toString();
      return;
   }

   JSONValue incoming;
   try incoming = parseJSON(raw);
   catch (Exception)
   {
      output.status = 400;
      output ~= failure("badjson").toString();
      return;
   }

   if (incoming.type != JSONType.object)
   {
      output.status = 400;
      output ~= failure("badjson").toString();
      return;
   }

   JSONValue query;
   query["op"] = request.path["/api/".length .. $];

   if (query["op"].str == "create" && !noProxy())
   {
      immutable who = forwardedFor(request);
      if (who.length == 0)
      {
         output ~= failure("misconfigured").toString();
         return;
      }

      query["ip"] = who;
   }

   foreach (key; ["id", "token", "pub", "ct", "flow"])
   {
      auto value = incoming.readString(key);
      if (value.length) query[key] = value;
   }

   query["v"] = incoming.readUlong("v");

   auto reply = ask(query);
   auto text = reply.toString();

   output ~= text;
   wipe(cast(ubyte[]) text);
}
