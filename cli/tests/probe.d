// Drives the protocol from the outside so the interop tests can compare what this
// implementation derives against what the browser derives.
//
// Prints its public key on the first line, then reads one line from stdin - a sealed
// payload, or empty - and prints the result as JSON.
module probe;

import secret;

import std.json : JSONValue;
import std.stdio : readln, stdout, writeln;
import std.string : strip;

int main(string[] args)
{
   if (args.length < 3)
   {
      writeln("usage: probe <peer-public-key> <room-id> [plaintext]");
      return 2;
   }

   auto self = createIdentity();
   writeln(self.pub);
   stdout.flush();

   auto session = deriveSession(self, args[1], args[2]);

   JSONValue out_;
   out_["pub"] = self.pub;
   out_["symbols"] = [
      cast(int) session.symbols[0], cast(int) session.symbols[1],
      cast(int) session.symbols[2], cast(int) session.symbols[3],
   ];

   if (args.length > 3)
      out_["ct"] = seal(session, args[2], cast(const(ubyte)[]) args[3]);

   auto incoming = readln();
   if (incoming !is null && incoming.strip.length)
      out_["opened"] = cast(string) unseal(session, args[2], incoming.strip);

   writeln(out_.toString());
   stdout.flush();
   return 0;
}
