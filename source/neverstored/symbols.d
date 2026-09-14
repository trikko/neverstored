module neverstored.symbols;

version (unittest)
{
   import std.regex : matchAll, regex;

   private auto parseSymbols()
   {
      static struct Symbol { string emoji, word; }

      Symbol[] symbols;
      auto pattern = regex(`\["(.+?)","(.+?)"\]`);

      foreach (m; import("symbols.js").matchAll(pattern))
         symbols ~= Symbol(m[1], m[2]);

      return symbols;
   }
}

unittest // the set must be exactly 256, so every byte maps to one symbol
{
   assert(parseSymbols().length == 256);
}

unittest // a duplicate symbol or label would make two different keys look alike
{
   import std.algorithm : sort, uniq;
   import std.array : array;

   auto symbols = parseSymbols();

   string[] emoji, words;
   foreach (s; symbols)
   {
      emoji ~= s.emoji;
      words ~= s.word;
   }

   assert(emoji.sort.uniq.array.length == 256);
   assert(words.sort.uniq.array.length == 256);
}

unittest // no joined sequences or skin tones: they render inconsistently across platforms
{
   foreach (s; parseSymbols())
      foreach (dchar c; s.emoji)
         assert(c != '‍' && !(c >= '\U0001F3FB' && c <= '\U0001F3FF'),
            "unsafe codepoint in " ~ s.word);
}
