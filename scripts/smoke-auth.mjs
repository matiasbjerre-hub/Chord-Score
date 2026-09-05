// Ren logik-test af sessions-cookien — ingen netværk/Redis nødvendig.
// Kør: node scripts/smoke-auth.mjs
import assert from "node:assert";

process.env.AUTH_SECRET = "test-secret-not-for-production";
const { signSession, verifySession } = await import("../lib/cookie.js");

const cookie = signSession("user-123");
assert.strictEqual(verifySession(cookie), "user-123", "gyldig cookie skal verificere til samme userId");
assert.strictEqual(verifySession(cookie + "x"), null, "ændret signatur skal afvises");

const forged = "andet-userid." + cookie.split(".")[1];
assert.strictEqual(verifySession(forged), null, "forkert userId med en andens signatur skal afvises");

assert.strictEqual(verifySession(""), null, "tom cookie skal afvises");
assert.strictEqual(verifySession(null), null, "manglende cookie skal afvises");
assert.strictEqual(verifySession("ingen-punktum"), null, "cookie uden separator skal afvises");

const cookie2 = signSession("bruger.med.punktummer");
assert.strictEqual(verifySession(cookie2), "bruger.med.punktummer", "userId må gerne selv indeholde punktummer");

console.log("smoke-auth: OK");
