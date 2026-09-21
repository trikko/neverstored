module neverstored.operator;

struct OperatorConfig
{
   string name    = "Example Operator";
   string contact = "security@example.com";
   string privacy = "privacy@example.com";
   string abuse;
   string expires = defaultExpires();
}

// __DATE__ is "MMM DD YYYY", e.g. "Sep 15 2026"; bump the year by one.
string defaultExpires() pure
{
   import std.conv : to;
   return (__DATE__[$ - 4 .. $].to!int + 1).to!string ~ "-01-01T00:00:00.000Z";
}

OperatorConfig parseOperatorIni(string src) pure
{
   import std.string : lineSplitter, strip;
   import std.algorithm : findSplit;

   OperatorConfig cfg;
   foreach (line; src.lineSplitter)
   {
      auto s = line.strip;
      if (s.length == 0 || s[0] == '#') continue;
      if (auto parts = s.findSplit("="))
      {
         immutable key = parts[0].strip;
         immutable val = parts[2].strip;
         switch (key)
         {
            case "name":    cfg.name    = val; break;
            case "contact": cfg.contact = val; break;
            case "privacy": cfg.privacy = val; break;
            case "abuse":   cfg.abuse   = val; break;
            case "expires": cfg.expires = val; break;
            default: break;
         }
      }
   }
   if (cfg.abuse.length == 0) cfg.abuse = cfg.contact;
   return cfg;
}

unittest
{
   auto cfg = parseOperatorIni("name = Someone\ncontact = sec@example.org\nabuse = abuse@example.org\n");
   assert(cfg.name == "Someone");
   assert(cfg.contact == "sec@example.org");
   assert(cfg.abuse == "abuse@example.org");
}

// An instance that never set one answers abuse reports where it answers everything else,
// rather than at an address nobody reads.
unittest
{
   auto cfg = parseOperatorIni("contact = sec@example.org\n");
   assert(cfg.abuse == "sec@example.org");
}

unittest
{
   auto cfg = parseOperatorIni("# contact = commented@example.org\n\n");
   assert(cfg.contact == "security@example.com");
   assert(cfg.abuse == cfg.contact);
}
