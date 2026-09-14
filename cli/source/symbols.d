module symbols;

/// The same 256 symbols the page shows, read from its source at compile time: one table
/// for both, and a mismatch becomes a build error instead of two people seeing different
/// pictures for the same key.
immutable string[2][256] SYMBOLS = parse(import("symbols.js"));

private string[2][256] parse(string source)
{
   string[2][256] table;
   size_t found;

   for (size_t i = 0; i + 1 < source.length && found < 256; i++)
   {
      if (source[i] != '[' || source[i + 1] != '"') continue;

      auto emoji = until(source, i + 2, `","`);
      if (emoji.next == 0) continue;

      auto word = until(source, emoji.next, `"]`);
      if (word.next == 0) continue;

      table[found++] = [emoji.text, word.text];
      i = word.next;
   }

   if (found != 256)
      throw new Exception("symbols.js must hold exactly 256 entries");

   return table;
}

private auto until(string source, size_t from, string mark)
{
   struct Found { string text; size_t next; }

   for (size_t i = from; i + mark.length <= source.length; i++)
      if (source[i .. i + mark.length] == mark)
         return Found(source[from .. i], i + mark.length);

   return Found(null, 0);
}

string say(ubyte index)
{
   return SYMBOLS[index][0] ~ "  " ~ SYMBOLS[index][1];
}

unittest
{
   assert(SYMBOLS[0][1] == "cat");
   assert(SYMBOLS[255][0].length > 0);

   bool[string] seen;
   foreach (entry; SYMBOLS)
   {
      assert(entry[1] !in seen, "duplicate word: " ~ entry[1]);
      seen[entry[1]] = true;
   }
}
