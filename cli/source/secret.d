module secret;

import evp;

import std.base64 : Base64;
import std.exception : enforce;
import std.string : representation;

enum context = "neverstored-v1";
enum ivBytes = 12;
enum tagBytes = 16;

/// An ephemeral key pair. The public half travels as a raw uncompressed point in
/// standard base64, exactly as the browser sends it.
struct Identity
{
   private EVP_PKEY* key;
   string pub;

   @disable this(this);

   ~this()
   {
      if (key !is null) EVP_PKEY_free(key);
      key = null;
   }
}

struct Session
{
   ubyte[32] key;
   ubyte[4] symbols;

   ~this() { wipe(key[]); }
}

Identity createIdentity()
{
   Identity self;
   self.key = EVP_PKEY_Q_keygen(null, null, "EC".ptr, "P-256".ptr);
   enforce(self.key !is null, "cannot generate a key pair");

   ubyte* raw;
   immutable length = EVP_PKEY_get1_encoded_public_key(self.key, &raw);
   enforce(length > 0, "cannot export the public key");
   scope (exit) OPENSSL_free(raw);

   self.pub = Base64.encode(raw[0 .. length]);
   return self;
}

/// The transcript pins the room and both public keys, so someone in the middle
/// cannot make the two sides land on the same symbols.
Session deriveSession(ref Identity self, string peerPub, string roomId)
{
   auto shared_ = agree(self, peerPub);
   scope (exit) wipe(shared_);

   auto ordered = self.pub < peerPub ? [self.pub, peerPub] : [peerPub, self.pub];
   immutable info = context ~ "|" ~ roomId ~ "|" ~ ordered[0] ~ "|" ~ ordered[1];

   auto bits = hkdf(shared_, roomId.representation, info.representation, 36);
   scope (exit) wipe(bits);

   Session session;
   session.key[] = bits[0 .. 32];
   session.symbols[] = bits[32 .. 36];
   return session;
}

string seal(ref Session session, string roomId, const(ubyte)[] plain)
{
   ubyte[ivBytes] iv;
   enforce(RAND_bytes(iv.ptr, ivBytes) == 1, "no randomness available");

   auto ctx = EVP_CIPHER_CTX_new();
   enforce(ctx !is null, "cannot start the cipher");
   scope (exit) EVP_CIPHER_CTX_free(ctx);

   enforce(EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), null, session.key.ptr, iv.ptr) == 1,
      "cannot start the cipher");

   int written;
   auto aad = roomId.representation;
   enforce(EVP_EncryptUpdate(ctx, null, &written, aad.ptr, cast(int) aad.length) == 1,
      "cannot bind the room to the payload");

   auto out_ = new ubyte[ivBytes + plain.length + tagBytes];
   out_[0 .. ivBytes] = iv[];
   scope (exit) wipe(out_);

   enforce(EVP_EncryptUpdate(ctx, out_.ptr + ivBytes, &written, plain.ptr,
      cast(int) plain.length) == 1, "cannot encrypt");

   int tail;
   enforce(EVP_EncryptFinal_ex(ctx, out_.ptr + ivBytes + written, &tail) == 1, "cannot encrypt");

   immutable body_ = ivBytes + written + tail;
   enforce(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_GET_TAG, tagBytes, out_.ptr + body_) == 1,
      "cannot seal");

   return Base64.encode(out_[0 .. body_ + tagBytes]);
}

ubyte[] unseal(ref Session session, string roomId, string payload)
{
   ubyte[] raw;
   try raw = Base64.decode(payload);
   catch (Exception) throw new Exception("the payload is not valid base64");

   enforce(raw.length > ivBytes + tagBytes, "the payload is too short to be real");
   scope (exit) wipe(raw);

   auto ctx = EVP_CIPHER_CTX_new();
   enforce(ctx !is null, "cannot start the cipher");
   scope (exit) EVP_CIPHER_CTX_free(ctx);

   enforce(EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), null, session.key.ptr, raw.ptr) == 1,
      "cannot start the cipher");

   int written;
   auto aad = roomId.representation;
   enforce(EVP_DecryptUpdate(ctx, null, &written, aad.ptr, cast(int) aad.length) == 1,
      "cannot bind the room to the payload");

   immutable body_ = raw.length - ivBytes - tagBytes;
   auto plain = new ubyte[body_];

   enforce(EVP_DecryptUpdate(ctx, plain.ptr, &written, raw.ptr + ivBytes, cast(int) body_) == 1,
      "cannot decrypt");

   enforce(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, tagBytes,
      cast(void*)(raw.ptr + ivBytes + body_)) == 1, "cannot read the seal");

   int tail;
   if (EVP_DecryptFinal_ex(ctx, plain.ptr + written, &tail) != 1)
   {
      wipe(plain);
      throw new Exception("the payload does not open: it was altered, or it is not for you");
   }

   return plain[0 .. written + tail];
}

/// Unusable key material is not a glitch: no honest client can produce it.
private enum tampered = "the other side answered with something no real neverstored client "
   ~ "could have sent: someone is interfering with this exchange. Nothing was sent. Do not "
   ~ "use this link again, and ask them for a new one somewhere you trust them";

private ubyte[] agree(ref Identity self, string peerPub)
{
   ubyte[] raw;
   try raw = Base64.decode(peerPub);
   catch (Exception) throw new Exception("the other side sent an unreadable key");

   auto peer = EVP_PKEY_new();
   enforce(peer !is null, "cannot read the other key");
   scope (exit) EVP_PKEY_free(peer);

   enforce(EVP_PKEY_copy_parameters(peer, self.key) == 1, "cannot read the other key");
   enforce(EVP_PKEY_set1_encoded_public_key(peer, raw.ptr, raw.length) == 1,
      tampered);

   auto ctx = EVP_PKEY_CTX_new(self.key, null);
   enforce(ctx !is null, "cannot agree on a key");
   scope (exit) EVP_PKEY_CTX_free(ctx);

   enforce(EVP_PKEY_derive_init(ctx) == 1, "cannot agree on a key");
   enforce(EVP_PKEY_derive_set_peer(ctx, peer) == 1,
      tampered);

   size_t length;
   enforce(EVP_PKEY_derive(ctx, null, &length) == 1 && length > 0, "cannot agree on a key");

   auto out_ = new ubyte[length];
   enforce(EVP_PKEY_derive(ctx, out_.ptr, &length) == 1, "cannot agree on a key");

   return out_[0 .. length];
}

private ubyte[] hkdf(const(ubyte)[] material, const(ubyte)[] salt, const(ubyte)[] info, size_t length)
{
   auto ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, null);
   enforce(ctx !is null, "cannot derive the key");
   scope (exit) EVP_PKEY_CTX_free(ctx);

   enforce(EVP_PKEY_derive_init(ctx) == 1, "cannot derive the key");
   enforce(EVP_PKEY_CTX_set_hkdf_md(ctx, EVP_sha256()) == 1, "cannot derive the key");
   enforce(EVP_PKEY_CTX_set1_hkdf_salt(ctx, salt.ptr, cast(int) salt.length) == 1,
      "cannot derive the key");
   enforce(EVP_PKEY_CTX_set1_hkdf_key(ctx, material.ptr, cast(int) material.length) == 1,
      "cannot derive the key");
   enforce(EVP_PKEY_CTX_add1_hkdf_info(ctx, info.ptr, cast(int) info.length) == 1,
      "cannot derive the key");

   auto out_ = new ubyte[length];
   auto size = length;
   enforce(EVP_PKEY_derive(ctx, out_.ptr, &size) == 1 && size == length, "cannot derive the key");

   return out_;
}

/// Overwrite a buffer so the compiler cannot elide the store.
void wipe(ubyte[] buf) @trusted
{
   import core.volatile : volatileStore;

   foreach (i; 0 .. buf.length) volatileStore(&buf[i], ubyte(0));
}

void wipe(char[] buf) @trusted
{
   wipe(cast(ubyte[]) buf);
}
