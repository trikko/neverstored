module evp;

// The few OpenSSL entry points the protocol needs, declared here instead of pulled in
// as a binding package: the list is short and this way it cannot drift.
extern (C) nothrow @nogc:

struct EVP_PKEY;
struct EVP_PKEY_CTX;
struct EVP_CIPHER_CTX;
struct EVP_CIPHER;
struct EVP_MD;
struct ENGINE;
struct OSSL_LIB_CTX;

enum EVP_PKEY_HKDF = 1036;
enum EVP_CTRL_AEAD_SET_IVLEN = 0x9;
enum EVP_CTRL_AEAD_GET_TAG = 0x10;
enum EVP_CTRL_AEAD_SET_TAG = 0x11;

EVP_PKEY* EVP_PKEY_Q_keygen(OSSL_LIB_CTX* libctx, const(char)* propq, const(char)* type, ...);
EVP_PKEY* EVP_PKEY_new();
void EVP_PKEY_free(EVP_PKEY* key);
int EVP_PKEY_copy_parameters(EVP_PKEY* to, const(EVP_PKEY)* from);
size_t EVP_PKEY_get1_encoded_public_key(EVP_PKEY* key, ubyte** pub);
int EVP_PKEY_set1_encoded_public_key(EVP_PKEY* key, const(ubyte)* pub, size_t len);

EVP_PKEY_CTX* EVP_PKEY_CTX_new(EVP_PKEY* key, ENGINE* engine);
EVP_PKEY_CTX* EVP_PKEY_CTX_new_id(int id, ENGINE* engine);
void EVP_PKEY_CTX_free(EVP_PKEY_CTX* ctx);
int EVP_PKEY_derive_init(EVP_PKEY_CTX* ctx);
int EVP_PKEY_derive_set_peer(EVP_PKEY_CTX* ctx, EVP_PKEY* peer);
int EVP_PKEY_derive(EVP_PKEY_CTX* ctx, ubyte* key, size_t* len);

int EVP_PKEY_CTX_set_hkdf_md(EVP_PKEY_CTX* ctx, const(EVP_MD)* md);
int EVP_PKEY_CTX_set1_hkdf_salt(EVP_PKEY_CTX* ctx, const(ubyte)* salt, int len);
int EVP_PKEY_CTX_set1_hkdf_key(EVP_PKEY_CTX* ctx, const(ubyte)* key, int len);
int EVP_PKEY_CTX_add1_hkdf_info(EVP_PKEY_CTX* ctx, const(ubyte)* info, int len);

const(EVP_MD)* EVP_sha256();
const(EVP_CIPHER)* EVP_aes_256_gcm();

EVP_CIPHER_CTX* EVP_CIPHER_CTX_new();
void EVP_CIPHER_CTX_free(EVP_CIPHER_CTX* ctx);
int EVP_CIPHER_CTX_ctrl(EVP_CIPHER_CTX* ctx, int type, int arg, void* ptr);
int EVP_EncryptInit_ex(EVP_CIPHER_CTX* ctx, const(EVP_CIPHER)* cipher, ENGINE* engine,
   const(ubyte)* key, const(ubyte)* iv);
int EVP_EncryptUpdate(EVP_CIPHER_CTX* ctx, ubyte* out_, int* outl, const(ubyte)* in_, int inl);
int EVP_EncryptFinal_ex(EVP_CIPHER_CTX* ctx, ubyte* out_, int* outl);
int EVP_DecryptInit_ex(EVP_CIPHER_CTX* ctx, const(EVP_CIPHER)* cipher, ENGINE* engine,
   const(ubyte)* key, const(ubyte)* iv);
int EVP_DecryptUpdate(EVP_CIPHER_CTX* ctx, ubyte* out_, int* outl, const(ubyte)* in_, int inl);
int EVP_DecryptFinal_ex(EVP_CIPHER_CTX* ctx, ubyte* out_, int* outl);

int RAND_bytes(ubyte* buf, int num);

/// OPENSSL_free is a macro in C; this is what it expands to.
void CRYPTO_free(void* ptr, const(char)* file, int line);

void OPENSSL_free(void* ptr)
{
   CRYPTO_free(ptr, __FILE__.ptr, __LINE__);
}
