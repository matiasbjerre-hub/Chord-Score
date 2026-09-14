// Signerer/verificerer sessions-cookien: "<userId>.<hmac>". Uden AUTH_SECRET kan ingen
// forfalske en cookie for en anden bruger, og uden secret sat fejler login helt i stedet
// for at falde tilbage til noget usikkert.
import crypto from "node:crypto";

const COOKIE_NAME = "cs_session";
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function hmac(value) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET mangler.");
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function signSession(userId) {
  return `${userId}.${hmac(userId)}`;
}

export function verifySession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string" || !cookieValue.includes(".")) return null;
  const i = cookieValue.lastIndexOf(".");
  const userId = cookieValue.slice(0, i);
  const sig = cookieValue.slice(i + 1);
  if (!userId || !sig) return null;
  let expected;
  try {
    expected = hmac(userId);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}

export function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export function getUserIdFromRequest(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]);
}

export function sessionCookieHeader(userId) {
  const value = encodeURIComponent(signSession(userId));
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${YEAR_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
