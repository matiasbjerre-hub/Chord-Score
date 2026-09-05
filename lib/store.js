// Minimal Upstash Redis REST-klient — ingen SDK, samme rå-fetch-stil som api/chords.js.
// Upstash-integrationen i Vercel sætter KV_REST_API_URL/KV_REST_API_TOKEN automatisk;
// UPSTASH_REDIS_REST_URL/TOKEN dækker en manuelt tilføjet Upstash-database.
import crypto from "node:crypto";

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!BASE || !TOKEN) throw new Error("Redis mangler (KV_REST_API_URL/TOKEN).");
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Redis-fejl (get): ${res.status}`);
  const { result } = await res.json();
  return result;
}

// Værdien sendes i request-body (ikke i URL'en) så den ikke er begrænset af URL-længde
// eller skal URL-encodes — se Upstash REST-dokumentationen for "SET" via POST-body.
async function redisSet(key, value) {
  if (!BASE || !TOKEN) throw new Error("Redis mangler (KV_REST_API_URL/TOKEN).");
  const res = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
    body: value,
  });
  if (!res.ok) throw new Error(`Redis-fejl (set): ${res.status}`);
}

const emptyUserData = () => ({ favorites: [], songOverrides: {}, uploads: [] });

export async function getUser(userId) {
  const raw = await redisGet(`user:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveUser(userId, data) {
  await redisSet(`user:${userId}`, JSON.stringify(data));
}

export async function getUserIdByCode(code) {
  return redisGet(`code:${code}`);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // uden I/O/0/1 — svære at kende fra hinanden

export async function createUser(name) {
  const userId = crypto.randomUUID();
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  await redisSet(`code:${code}`, userId);
  await saveUser(userId, { name, ...emptyUserData() });
  return { userId, code };
}
