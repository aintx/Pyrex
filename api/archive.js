const crypto = require("crypto");

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1533774437277503518";
const DAPI = process.env.DISCORD_API || "https://discord.com/api";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const OWNERS = (process.env.OWNER_IDS || "1524068719297429586,1555522126788952066").split(",").map((s) => s.trim()).filter(Boolean);

const ARCH = "pyrx:arch";
const ROLES = "pyrx:roles";
const UPLOAD_ROLES = ["above", "pyrx", "trust"];
const LIMIT = 2;
const MAX_IMG = 600000;
const MAX_THUMB = 120000;
const MAX_VID = 4000000;
const MAX_CHUNK_B64 = 500000;
const MAX_CHUNKS = 12;
const MAX_ITEMS = 1500;
const PENDING_TTL = 10 * 60 * 1000;
const IMG_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;
const VID_MIME = ["video/mp4", "video/webm", "video/quicktime"];
const ID_RE = /^[a-f0-9]{16}$/;

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
const roleOf = (id, roles) => (OWNERS.includes(id) ? "own" : roles[id] || "");
const clean = (s, max) => (typeof s === "string" ? s : "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const fail = (res, code, error) => res.status(code).json({ error });

async function discordUser(token) {
  const a = await fetch(DAPI + "/oauth2/@me", { headers: { Authorization: "Bearer " + token } });
  if (!a.ok) return null;
  const j = await a.json();
  if (!j || !j.user || !j.user.id || !j.application || j.application.id !== CLIENT_ID) return null;
  return j.user;
}

function parseLink(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let yt = "";
  if (h === "youtu.be") yt = u.pathname.slice(1).split("/")[0];
  else if (h === "youtube.com" || h === "youtube-nocookie.com") {
    if (u.pathname === "/watch") yt = u.searchParams.get("v") || "";
    else { const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/); if (m) yt = m[1]; }
  }
  if (/^[\w-]{11}$/.test(yt)) return { kind: "yt", yt };
  if (/\.(mp4|webm|mov|m4v)$/i.test(u.pathname) && u.href.length <= 500) return { kind: "link", url: u.href };
  return null;
}

const chunkKey = (id, i) => `pyrx:arch:v:${id}:${i}`;

async function dropMedia(id, rec) {
  const keys = [`pyrx:arch:m:${id}`, `pyrx:arch:t:${id}`];
  for (let i = 0; i < (rec && rec.n ? rec.n : 0); i++) keys.push(chunkKey(id, i));
  await redis(["DEL", ...keys]);
}

const isLive = (r, now) => r && (r.st === "ready" || (r.st === "pending" && now - (r.ts || 0) < PENDING_TTL));

module.exports = async (req, res) => {
  if (!RURL || !RTOK) return fail(res, 503, "storage_not_configured");
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      const mid = q.media || q.thumb;
      if (mid) {
        const id = String(mid);
        if (!ID_RE.test(id)) return fail(res, 400, "bad_id");
        const rec = parse(await redis(["HGET", ARCH, id]));
        if (!rec || rec.st !== "ready") return fail(res, 404, "not_found");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        if (q.thumb || rec.type === "image") {
          const v = await redis(["GET", q.thumb ? `pyrx:arch:t:${id}` : `pyrx:arch:m:${id}`]);
          const m = typeof v === "string" && v.match(IMG_RE);
          if (!m) return fail(res, 404, "no_media");
          res.setHeader("Content-Type", m[1]);
          return res.status(200).end(Buffer.from(m[2], "base64"));
        }
        if (rec.kind !== "file" || !VID_MIME.includes(rec.mime)) return fail(res, 404, "no_media");
        const keys = [];
        for (let i = 0; i < rec.n; i++) keys.push(chunkKey(id, i));
        const parts = await redis(["MGET", ...keys]);
        if (!parts || parts.some((p) => typeof p !== "string")) return fail(res, 404, "no_media");
        const buf = Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
        const total = buf.length;
        res.setHeader("Content-Type", rec.mime);
        res.setHeader("Accept-Ranges", "bytes");
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
        if (m && (m[1] !== "" || m[2] !== "")) {
          let s, e;
          if (m[1] === "") { s = Math.max(0, total - parseInt(m[2], 10)); e = total - 1; }
          else { s = parseInt(m[1], 10); e = m[2] === "" ? total - 1 : Math.min(parseInt(m[2], 10), total - 1); }
          if (!(s >= 0 && s < total && e >= s)) { res.setHeader("Content-Range", "bytes */" + total); return res.status(416).end(); }
          res.setHeader("Content-Range", `bytes ${s}-${e}/${total}`);
          res.setHeader("Content-Length", String(e - s + 1));
          return res.status(206).end(buf.subarray(s, e + 1));
        }
        res.setHeader("Content-Length", String(total));
        return res.status(200).end(buf);
      }
      const now = Date.now();
      const raw = pairs(await redis(["HGETALL", ARCH]));
      const items = [];
      for (const id of Object.keys(raw)) {
        const r = parse(raw[id]);
        if (!r || r.st !== "ready") continue;
        items.push({ id, uid: r.uid, type: r.type, kind: r.kind, yt: r.yt || "", url: r.url || "", title: r.title || "", ts: r.ts || 0, th: r.th ? 1 : 0 });
      }
      items.sort((a, b) => b.ts - a.ts);
      res.setHeader("Cache-Control", "public, max-age=0, s-maxage=5, stale-while-revalidate=20");
      return res.status(200).json({ items, limit: LIMIT, now });
    }

    if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.token !== "string" || !body.token) return fail(res, 400, "bad_request");

    const u = await discordUser(body.token);
    if (!u) return fail(res, 401, "invalid_or_expired_login");
    const uid = u.id;
    const isOwner = OWNERS.includes(uid);
    const roles = pairs(await redis(["HGETALL", ROLES]));
    const role = roleOf(uid, roles);
    const canUpload = isOwner || UPLOAD_ROLES.includes(role);
    const now = Date.now();

    if (body.action === "arch_delete") {
      const id = String(body.id || "");
      if (!ID_RE.test(id)) return fail(res, 400, "bad_id");
      const rec = parse(await redis(["HGET", ARCH, id]));
      if (!rec) return res.status(200).json({ ok: true });
      if (rec.uid !== uid && !isOwner) return fail(res, 403, "not_yours");
      await redis(["HDEL", ARCH, id]);
      await dropMedia(id, rec);
      return res.status(200).json({ ok: true });
    }

    if (body.action === "arch_create") {
      if (!canUpload) return fail(res, 403, "not_allowed");
      const all = pairs(await redis(["HGETALL", ARCH]));
      const ids = Object.keys(all);
      if (ids.length >= MAX_ITEMS) return fail(res, 507, "archive_full");
      if (!isOwner) {
        let mine = 0;
        for (const id of ids) { const r = parse(all[id]); if (r && r.uid === uid && isLive(r, now)) mine++; }
        if (mine >= LIMIT) return fail(res, 403, "limit_reached");
      }
      const type = body.type === "video" ? "video" : body.type === "image" ? "image" : "";
      if (!type) return fail(res, 400, "bad_type");
      const id = crypto.randomBytes(8).toString("hex");
      const rec = { uid, type, title: clean(body.title, 60), ts: now, st: "ready" };

      if (type === "image") {
        const v = body.data;
        if (typeof v !== "string" || v.length > MAX_IMG || !IMG_RE.test(v)) return fail(res, 400, "bad_image");
        rec.kind = "file";
        await redis(["SET", `pyrx:arch:m:${id}`, v]);
      } else if (body.link) {
        const l = parseLink(body.link);
        if (!l) return fail(res, 400, "bad_link");
        Object.assign(rec, l);
      } else {
        const size = Number(body.size), n = Number(body.chunks), mime = String(body.mime || "");
        if (!(size > 0 && size <= MAX_VID) || !Number.isInteger(n) || n < 1 || n > MAX_CHUNKS || !VID_MIME.includes(mime)) return fail(res, 400, "bad_video");
        rec.kind = "file"; rec.mime = mime; rec.n = n; rec.size = size; rec.st = "pending";
      }
      if (typeof body.thumb === "string" && body.thumb) {
        if (body.thumb.length > MAX_THUMB || !IMG_RE.test(body.thumb)) return fail(res, 400, "bad_image");
        await redis(["SET", `pyrx:arch:t:${id}`, body.thumb]);
        rec.th = 1;
      }
      await redis(["HSET", ARCH, id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true, id, st: rec.st });
    }

    if (body.action === "arch_chunk" || body.action === "arch_finish") {
      const id = String(body.id || "");
      if (!ID_RE.test(id)) return fail(res, 400, "bad_id");
      const rec = parse(await redis(["HGET", ARCH, id]));
      if (!rec || rec.uid !== uid) return fail(res, 404, "not_found");
      if (rec.st !== "pending") return fail(res, 400, "not_pending");
      if (body.action === "arch_chunk") {
        const i = Number(body.i), d = body.data;
        if (!Number.isInteger(i) || i < 0 || i >= rec.n) return fail(res, 400, "bad_chunk");
        if (typeof d !== "string" || !d || d.length > MAX_CHUNK_B64 || !B64_RE.test(d)) return fail(res, 400, "bad_chunk");
        await redis(["SET", chunkKey(id, i), d]);
        return res.status(200).json({ ok: true });
      }
      const keys = [];
      for (let i = 0; i < rec.n; i++) keys.push(chunkKey(id, i));
      const parts = await redis(["MGET", ...keys]);
      if (!parts || parts.some((p) => typeof p !== "string")) return fail(res, 400, "missing_chunks");
      const bytes = parts.reduce((a, p) => a + Buffer.byteLength(p, "base64"), 0);
      if (bytes > MAX_VID || bytes < 1) { await redis(["HDEL", ARCH, id]); await dropMedia(id, rec); return fail(res, 400, "bad_video"); }
      rec.st = "ready"; rec.size = bytes; rec.ts = now;
      await redis(["HSET", ARCH, id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true });
    }

    return fail(res, 400, "bad_action");
  } catch (e) {
    console.error("archive api:", e && e.message);
    return fail(res, 500, "server_error");
  }
};