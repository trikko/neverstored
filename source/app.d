module app;

import neverstored.api;
import neverstored.broker : startBroker;
import neverstored.client : useBroker;
import neverstored.rnd : isRoomId;
import neverstored.visitor : misconfigured, noProxy;

import serverino;

import std.process : environment;

mixin ServerinoMain!(neverstored.api);

static assert(__traits(compiles, import("operator.ini")),
   "static/operator.ini not found. "
   ~ "Copy static/operator.ini.example to static/operator.ini and fill in your details before building.");

private immutable string OPERATOR_NAME;
private immutable string OPERATOR_CONTACT;
private immutable string OPERATOR_PRIVACY;
private immutable string OPERATOR_EXPIRES;

shared static this()
{
   enum cfg = parseOperatorIni(import("operator.ini"));
   OPERATOR_NAME    = cfg.name;
   OPERATOR_CONTACT = cfg.contact;
   OPERATOR_PRIVACY = cfg.privacy;
   OPERATOR_EXPIRES = cfg.expires;
}

private struct OperatorConfig
{
   string name    = "Example Operator";
   string contact = "security@example.com";
   string privacy = "privacy@example.com";
   string expires = defaultExpires();
}

// __DATE__ is "MMM DD YYYY", e.g. "Sep 15 2026"; bump the year by one.
private string defaultExpires() pure
{
   import std.conv : to;
   return (__DATE__[$ - 4 .. $].to!int + 1).to!string ~ "-01-01T00:00:00.000Z";
}

private OperatorConfig parseOperatorIni(string src) pure
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
            case "expires": cfg.expires = val; break;
            default: break;
         }
      }
   }
   return cfg;
}

string brokerSocketPath()
{
   import std.path : buildPath;

   auto explicit = environment.get("NEVERSTORED_SOCKET");
   if (explicit.length) return explicit;

   auto runtimeDir = environment.get("XDG_RUNTIME_DIR");
   if (runtimeDir.length) return buildPath(runtimeDir, "neverstored.sock");

   return "/tmp/neverstored.sock";
}

@onServerInit ServerinoConfig setup()
{
   import core.time : seconds;
   import std.conv : to;

   immutable port = environment.get("NEVERSTORED_PORT", "8080").to!ushort;
   immutable bind = environment.get("NEVERSTORED_BIND", "127.0.0.1");

   return ServerinoConfig.create()
      .addListener(bind, port)
      .setMaxWorkers(12)
      .setMaxRequestTime(3.seconds)
      .enableKeepAlive(10.seconds)
      .setMaxRequestSize(16 * 1024);
}

@onDaemonStart void openRooms()
{
   startBroker(brokerSocketPath());
}

@onWorkerStart void attachToBroker()
{
   useBroker(brokerSocketPath());
}

@endpoint @priority(100)
Fallthrough headers(Request request, Output output)
{
   output.addHeader("referrer-policy", "no-referrer");
   output.addHeader("x-content-type-options", "nosniff");
   output.addHeader("x-frame-options", "DENY");
   output.addHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
   output.addHeader("content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
      ~ "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");

   return Fallthrough.Yes;
}

/+ An instance nobody can tell apart from itself does not open rooms, it explains why.

 + Assets still answer, so the explanation arrives styled rather than as bare text, and /api/
 + is left to api.d, which says the same thing in the JSON the page expects.
+/
@endpoint @priority(90)
Fallthrough proxyCheck(Request request, Output output)
{
   import std.algorithm : endsWith, startsWith;

   if (!misconfigured(request)) return Fallthrough.Yes;
   if (request.path.startsWith("/api/")) return Fallthrough.Yes;
   if (request.path.endsWith(".js") || request.path.endsWith(".css")) return Fallthrough.Yes;

   complain(request);

   output.status = 503;
   page(request, output, import("misconfigured.html"));
   return Fallthrough.No;
}

/+ Why a request was refused, for the operator and nobody else.

 + Only the names of the headers that arrived: the values carry addresses, cookies and the
 + rest of a visitor, and none of that belongs in a log. The one thing worth distinguishing is
 + an absent header from one that arrived blank — a proxy that writes the address into it and
 + resolves nothing leaves the second, and the two accuse different parts of the chain.
+/
private void complain(Request request)
{
   import std.algorithm : sort, map;
   import std.array : join, array;
   import std.experimental.logger : warning;

   warning("refusing ", request.path, ": x-forwarded-for is ",
      request.header.has("x-forwarded-for") ? "present but blank" : "absent",
      "; headers seen: ", request.header.data.map!(x => cast(string)x.key).array.sort.join(" "));
}

@endpoint @route!"/" void home(Request request, Output output) { page(request, output, import("app.html")); }
@endpoint @route!"/how-it-works" void how(Request request, Output output) { page(request, output, import("how.html")); }
@endpoint @route!"/cli" void cli(Request request, Output output) { page(request, output, import("cli.html")); }
@endpoint @route!"/privacy" void privacyPolicy(Request request, Output output) { page(request, output, import("privacy.html")); }

@endpoint @route!(r => r.path.length > 3 && r.path[0 .. 3] == "/r/")
void room(Request request, Output output)
{
   if (!isRoomId(request.path[3 .. $]))
   {
      output.status = 404;
      page(request, output, import("gone.html"));
      return;
   }

   page(request, output, import("app.html"));
}

@endpoint @route!"/app.js" void appScript(Output output) { asset(output, "application/javascript", import("app.js")); }
@endpoint @route!"/symbols.js" void symbolsScript(Output output) { asset(output, "application/javascript", import("symbols.js")); }
@endpoint @route!"/crypto.js" void cryptoScript(Output output) { asset(output, "application/javascript", import("crypto.js")); }
@endpoint @route!"/qr.js" void qrScript(Output output) { asset(output, "application/javascript", import("qr.js")); }
@endpoint @route!"/style.css" void styles(Output output) { asset(output, "text/css", import("style.css")); }
@endpoint @route!"/icon.svg" void icon(Output output) { asset(output, "image/svg+xml", import("icon.svg")); }
@endpoint @route!"/favicon.png" void faviconPng(Output output) { binary(output, "image/png", import("favicon.png")); }
@endpoint @route!"/favicon.ico" void faviconIco(Output output) { binary(output, "image/png", import("favicon.png")); }
@endpoint @route!"/apple-touch-icon.png" void appleIcon(Output output) { binary(output, "image/png", import("apple-touch-icon.png")); }
@endpoint @route!"/social.png" void social(Output output) { binary(output, "image/png", import("social.png")); }

@endpoint @route!"/.well-known/security.txt"
void securityTxt(Request request, Output output)
{
   import std.array : replace;
   output.addHeader("content-type", "text/plain; charset=utf-8");
   output.addHeader("cache-control", "no-store");
   output ~= import("security.txt")
      .replace("{{contact}}", OPERATOR_CONTACT)
      .replace("{{expires}}", OPERATOR_EXPIRES)
      .replace("{{origin}}", origin(request));
}

@endpoint @route!"/security.txt"
void securityTxtAlias(Request request, Output output)
{
   output.status = 301;
   output.addHeader("location", "/.well-known/security.txt");
}

@endpoint @priority(-100)
void notFound(Request request, Output output)
{
   output.status = 404;
   page(request, output, import("gone.html"));
}

/+ Pages carry their own absolute address.

 + A social preview is fetched by a machine that will not resolve a relative og:image, and the
 + server has no configured name of its own: the only thing that knows what this instance is
 + called is the request. So the name travels from the proxy into the page, once per request.
+/
private void page(Request request, Output output, string body_)
{
   import std.array : replace;

   output.addHeader("content-type", "text/html; charset=utf-8");
   output.addHeader("cache-control", "no-store");
   output ~= body_
      .replace("{{origin}}", origin(request))
      .replace("{{operator_name}}", OPERATOR_NAME)
      .replace("{{operator_privacy}}", OPERATOR_PRIVACY);
}

private string origin(Request request)
{
   immutable host = request.header.read("host");
   if (host.length == 0 || host.length > 253) return "";

   foreach (c; host)
      if (c <= ' ' || c == '/' || c == '\\' || c == '"' || c == '\'' || c >= 0x7f) return "";

   // The proxy says so; with no proxy at all there is no certificate either.
   immutable claimed = request.header.read("x-forwarded-proto");
   immutable proto = claimed.length ? (claimed == "http" ? "http" : "https")
      : (noProxy() ? "http" : "https");

   return proto ~ "://" ~ host;
}

/+ Icons and the preview card change only when the binary does, and the binary is the only
 + thing deployed, so they may be cached hard. Nothing here is derived from a secret.
+/
private void binary(Output output, string type, string body_)
{
   output.addHeader("content-type", type);
   output.addHeader("cache-control", "public, max-age=604800");
   output ~= body_;
}

private void asset(Output output, string type, string body_)
{
   output.addHeader("content-type", type ~ "; charset=utf-8");
   output.addHeader("cache-control", "no-store");
   output ~= body_;
}
