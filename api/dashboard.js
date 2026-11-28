const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1533774437277503518";
const DAPI = process.env.DISCORD_API || "https://discord.com/api";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const OWNERS = (process.env.OWNER_IDS || "1524068719297429586,1555522126788952066").split(",").map((s) => s.trim()).filter(Boolean);

const SITE = "pyrx:site";
const PROFILES = "pyrx:profiles";
const ROLES = "pyrx:roles";
const ARCH = "pyrx:arch";
const SONGS = "pyrx:songs";
const ROLE_KEYS = ["above", "pyrx", "trust", "members"];

async function redis(cmd) {
  const r = await fetch(RURL, {
    method: "POST",
    headers: { Authorization: "Bearer " + RTOK, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const pairs = (flat) => {
  const o = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const clean = (s, max) => (typeof s === "string" ? s : "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const fail = (res, code, error) => res.status(code).json({ error });

async function discordUser(token) {
  const a = await fetch(DAPI + "/oauth2/@me", { headers: { Authorization: "Bearer " + token } });
  if (!a.ok) return null;
  const j = await a.json();
  if (!j || !j.user || !j.user.id || !j.application || j.application.id !== CLIENT_ID) return null;
  return j.user;
}

async function readSite() {
  const s = pairs(await redis(["HGETALL", SITE]));
  return { tagline: s.tagline || "", announcement: s.announcement || "", ts: Number(s.ts) || 0 };
}

module.exports = async (req, res) => {
  if (!RURL || !RTOK) return fail(res, 503, "storage_not_configured");
  try {
    // Public: the site settings every visitor needs (home tagline + announcement).
    if (req.method === "GET") {
      res.setHeader("Cache-Control", "public, max-age=0, s-maxage=5, stale-while-revalidate=20");
      return res.status(200).json(await readSite());
    }

    if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.token !== "string" || !body.token) return fail(res, 400, "bad_request");

    const u = await discordUser(body.token);
    if (!u) return fail(res, 401, "invalid_or_expired_login");
    // Everything below is owner-only, checked here on the server.
    if (!OWNERS.includes(u.id)) return fail(res, 403, "owners_only");

    if (body.action === "stats") {
      const [rf, af, sf, profiles] = await Promise.all([
        redis(["HGETALL", ROLES]), redis(["HGETALL", ARCH]), redis(["HGETALL", SONGS]), redis(["HLEN", PROFILES]),
      ]);
      const roles = {};
      ROLE_KEYS.forEach((k) => { roles[k] = 0; });
      Object.values(pairs(rf)).forEach((r) => { if (r in roles) roles[r]++; });

      const archive = { total: 0, images: 0, videos: 0, pending: 0, bytes: 0 };
      for (const v of Object.values(pairs(af))) {
        const r = parse(v);
        if (!r) continue;
        if (r.st === "pending") { archive.pending++; continue; }
        if (r.st !== "ready") continue;
        archive.total++;
        if (r.type === "image") archive.images++; else archive.videos++;
        archive.bytes += r.size || 0;
      }

      const songs = { custom: 0, hidden: 0, bytes: 0 };
      for (const [id, v] of Object.entries(pairs(sf))) {
        const r = parse(v);
        if (!r) continue;
        if (r.hide) songs.hidden++;
        if (/^b\d$/.test(id)) continue;
        if (r.st === "ready") { songs.custom++; songs.bytes += r.size || 0; }
      }
      return res.status(200).json({ ok: true, owners: OWNERS.length, profiles: Number(profiles) || 0, roles, archive, songs });
    }

    if (body.action === "settings_save") {
      const tagline = clean(body.tagline, 60);
      const announcement = clean(body.announcement, 160);
      const now = Date.now();
      // An empty value removes the field so the site falls back to its default.
      if (tagline) await redis(["HSET", SITE, "tagline", tagline]); else await redis(["HDEL", SITE, "tagline"]);
      if (announcement) await redis(["HSET", SITE, "announcement", announcement, "ts", String(now)]);
      else await redis(["HDEL", SITE, "announcement"]);
      return res.status(200).json({ ok: true, ...(await readSite()) });
    }

    return fail(res, 400, "bad_action");
  } catch (e) {
    console.error("dashboard api:", e && e.message);
    return fail(res, 500, "server_error");
  }
};
