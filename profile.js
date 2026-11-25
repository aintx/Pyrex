

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1533774437277503518";
const DAPI = process.env.DISCORD_API || "https://discord.com/api";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const HASH = "pyrx:profiles";
const MAX_IMG = 260000;
const MAX_MEMBERS = 1500;
const IMG_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

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

const clean = (s, max, multiline) => {
  s = typeof s === "string" ? s : "";
  s = multiline ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "") : s.replace(/[\u0000-\u001f\u007f]/g, "");
  return s.trim().slice(0, max);
};

const pub = (r) => ({
  id: r.id, username: r.username || "", global_name: r.global_name || "",
  avatar: r.avatar || "", banner: r.banner || "",
  name: r.name || "", tag: r.tag || "", bio: r.bio || "",
  av: r.av || 0, bn: r.bn || 0, joined: r.joined || 0, ts: r.ts || 0,
});

async function discordUser(token) {
  const h = { Authorization: "Bearer " + token };
  const a = await fetch(DAPI + "/oauth2/@me", { headers: h });
  if (!a.ok) return null;
  const j = await a.json();
  if (!j || !j.user || !j.user.id || !j.application || j.application.id !== CLIENT_ID) return null;
  let u = j.user;
  try {
    const b = await fetch(DAPI + "/users/@me", { headers: h });
    if (b.ok) { const bj = await b.json(); if (bj && bj.id === u.id) u = { ...u, ...bj }; }
  } catch (e) {}
  return u;
}

function fail(res, code, error) { res.status(code).json({ error }); }

module.exports = async (req, res) => {
  if (!RURL || !RTOK) return fail(res, 503, "storage_not_configured");
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (q.img) {
        const id = String(q.img), k = q.k === "banner" ? "banner" : "avatar";
        if (!/^\d{5,25}$/.test(id)) return fail(res, 400, "bad_id");
        const v = await redis(["GET", `pyrx:img:${k}:${id}`]);
        const m = typeof v === "string" && v.match(IMG_RE);
        if (!m) return fail(res, 404, "no_image");
        res.setHeader("Content-Type", m[1]);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.status(200).end(Buffer.from(m[2], "base64"));
      }
      const flat = (await redis(["HGETALL", HASH])) || [];
      const profiles = [];
      for (let i = 1; i < flat.length; i += 2) { try { profiles.push(pub(JSON.parse(flat[i]))); } catch (e) {} }
      profiles.sort((a, b) => a.joined - b.joined);
      res.setHeader("Cache-Control", "public, max-age=0, s-maxage=5, stale-while-revalidate=20");
      return res.status(200).json({ profiles });
    }

    if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.token !== "string" || !body.token) return fail(res, 400, "bad_request");

    const u = await discordUser(body.token);
    if (!u) return fail(res, 401, "invalid_or_expired_login");
    const id = u.id;
    const raw = await redis(["HGET", HASH, id]);
    let rec = null; try { rec = raw ? JSON.parse(raw) : null; } catch (e) {}
    const now = Date.now();

    if (body.action === "delete") {
      await redis(["HDEL", HASH, id]);
      await redis(["DEL", "pyrx:img:avatar:" + id, "pyrx:img:banner:" + id]);
      return res.status(200).json({ ok: true });
    }

    if (!rec) {
      const n = await redis(["HLEN", HASH]);
      if (n >= MAX_MEMBERS) return fail(res, 507, "member_list_full");
      rec = { joined: now };
    }

    rec.id = id; rec.username = u.username || ""; rec.global_name = u.global_name || "";
    rec.avatar = u.avatar || ""; rec.banner = u.banner || "";

    if (body.action === "save") {
      rec.name = clean(body.name, 32);
      rec.tag = clean(body.tag, 32).replace(/^@+/, "");
      rec.bio = clean(body.bio, 190, true);
      for (const [field, key, ver] of [["avatarImg", "avatar", "av"], ["bannerImg", "banner", "bn"]]) {
        const v = body[field];
        if (v === undefined || v === null) continue;
        if (v === "") { await redis(["DEL", `pyrx:img:${key}:${id}`]); rec[ver] = 0; continue; }
        if (typeof v !== "string" || v.length > MAX_IMG || !IMG_RE.test(v)) return fail(res, 400, "bad_image");
        await redis(["SET", `pyrx:img:${key}:${id}`, v]);
        rec[ver] = now;
      }
    } else if (body.action !== "sync") {
      return fail(res, 400, "bad_action");
    }

    rec.ts = now;
    await redis(["HSET", HASH, id, JSON.stringify(rec)]);
    return res.status(200).json({ ok: true, profile: pub(rec) });
  } catch (e) {
    console.error("profile api:", e && e.message);
    return fail(res, 500, "server_error");
  }
};
