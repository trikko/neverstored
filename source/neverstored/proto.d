module neverstored.proto;

import std.json : JSONValue, parseJSON;
import std.socket : Socket;

enum maxFrameBytes = 256 * 1024;

/// Length-prefixed JSON. Returns false on a closed or misbehaving peer.
bool sendFrame(Socket sock, JSONValue value)
{
   import std.bitmanip : nativeToBigEndian;

   auto body_ = cast(const(ubyte)[]) value.toString();
   if (body_.length > maxFrameBytes) return false;

   ubyte[4] header = nativeToBigEndian(cast(uint) body_.length);
   return writeAll(sock, header[]) && writeAll(sock, body_);
}

bool receiveFrame(Socket sock, out JSONValue value)
{
   import std.bitmanip : bigEndianToNative;

   ubyte[4] header;
   if (!readAll(sock, header[])) return false;

   immutable length = bigEndianToNative!uint(header);
   if (length == 0 || length > maxFrameBytes) return false;

   auto body_ = new ubyte[length];
   if (!readAll(sock, body_)) return false;

   try value = parseJSON(cast(string) body_);
   catch (Exception) return false;

   return true;
}

private bool writeAll(Socket sock, const(ubyte)[] data)
{
   while (data.length)
   {
      auto sent = sock.send(data);
      if (sent <= 0) return false;
      data = data[sent .. $];
   }
   return true;
}

private bool readAll(Socket sock, ubyte[] buffer)
{
   while (buffer.length)
   {
      auto got = sock.receive(buffer);
      if (got <= 0) return false;
      buffer = buffer[got .. $];
   }
   return true;
}

string readString(in JSONValue value, string key)
{
   import std.json : JSONType;

   if (value.type != JSONType.object) return null;
   auto found = key in value.object;
   if (found is null || found.type != JSONType.string) return null;

   return found.str;
}

ulong readUlong(in JSONValue value, string key)
{
   import std.json : JSONType;

   if (value.type != JSONType.object) return 0;
   auto found = key in value.object;
   if (found is null) return 0;

   // A ulong put back into a JSONValue comes out as uinteger, so a version that made the
   // trip through the worker does not look like the one the client sent.
   if (found.type == JSONType.uinteger) return found.uinteger;
   if (found.type != JSONType.integer) return 0;
   if (found.integer < 0) return 0;

   return cast(ulong) found.integer;
}

JSONValue failure(string reason)
{
   JSONValue out_;
   out_["ok"] = false;
   out_["err"] = reason;
   return out_;
}

unittest // a version survives being handed from the worker to the broker
{
   import std.json : parseJSON;

   // What the client sends, and what the worker forwards after reading it back.
   auto fromClient = parseJSON(`{"v": 7}`);
   assert(fromClient.readUlong("v") == 7);

   JSONValue forwarded;
   forwarded["v"] = fromClient.readUlong("v");
   assert(forwarded.readUlong("v") == 7, "the version was lost between the two processes");

   assert(parseJSON(`{"v": -1}`).readUlong("v") == 0);
   assert(parseJSON(`{"v": "7"}`).readUlong("v") == 0);
   assert(parseJSON(`{}`).readUlong("v") == 0);
}
