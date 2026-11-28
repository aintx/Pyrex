const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1533774437277503518";
const DAPI = process.env.DISCORD_API || "https://discord.com/api";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const OWNERS = (process.env.OWNER_IDS || "1524068719297429586,1555522126788952066").split(",").map((s) => s.trim()).filter(Boolean);

const SONGS = "pyrx:songs";
// The three songs that are embedded in index.html. Owners can rename, reorder or hide them
// (that is stored as an "override" record), but the audio itself stays in the page.
const BUILTIN = [
  { id: "b1", title: "001", artist: "Pyrx", d: 190 },
  { id: "b2", title: "002", artist: "Pyrx", d: 151 },
  { id: "b3", title: "003", artist: "Pyrx", d: 284 },
];
const MAX_AUDIO = 12000000;
const MAX_RAW_CHUNK = 375000; // 375000 bytes -> 500000 base64 chars
const MAX_CHUNK_B64 = 500000;
const MAX_CHUNKS = 40;
const MAX_SONGS = 200;
const RESP_CAP = 1500000; // max bytes returned per audio request (serverless response limit)
const PENDING_TTL = 10 * 60 * 1000;
const AUDIO_MIME = ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/webm"];
const ID_RE = /^[a-f0-9]{16}$/;
const BID_RE = /^b[1-9]$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;

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
const chunkKey = (id, i) => `pyrx:songs:a:${id}:${i}`;

async function discordUser(token) {
  const a = await fetch(DAPI + "/oauth2/@me", { headers: { Authorization: "Bearer " + token } });
  if (!a.ok) return null;
  const j = await a.json();
  if (!j || !j.user || !j.user.id || !j.application || j.application.id !== CLIENT_ID) return null;
  return j.user;
}

function parseAudioLink(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "https:" || u.href.length > 500) return null;
  if (!/\.(mp3|m4a|aac|ogg|oga|wav|webm)$/i.test(u.pathname)) return null;
  return u.href;
}

async function dropAudio(id, rec) {
  const keys = [];
  for (let i = 0; i < (rec && rec.n ? rec.n : 0); i++) keys.push(chunkKey(id, i));
  if (keys.length) await redis(["DEL", ...keys]);
}

// Merge built-in defaults with whatever is stored. Returns every song, in order.
function merge(raw, now) {
  const out = [];
  BUILTIN.forEach((b, i) => {
    const o = parse(raw[b.id]) || {};
    out.push({
      id: b.id, builtin: true, kind: "builtin",
      title: o.title != null ? o.title : b.title,
      artist: o.artist != null ? o.artist : b.artist,
      d: Number.isInteger(o.d) ? o.d : b.d,
      ord: typeof o.ord === "number" ? o.ord : i,
      hide: !!o.hide, edited: !!parse(raw[b.id]),
    });
  });
  for (const id of Object.keys(raw)) {
    if (BID_RE.test(id)) continue;
    const r = parse(raw[id]);
    if (!r) continue;
    const pending = r.st === "pending";
    if (pending && now - (r.ts || 0) >= PENDING_TTL) continue;
    if (r.st !== "ready" && !pending) continue;
    out.push({
      id, builtin: false, kind: r.kind, title: r.title || "Untitled", artist: r.artist || "",
      d: r.d || 0, ord: typeof r.ord === "number" ? r.ord : 1000 + (r.ts || 0) / 1e12,
      hide: !!r.hide, ts: r.ts || 0, size: r.size || 0, url: r.kind === "link" ? r.url : "", pending,
    });
  }
  out.sort((a, b) => a.ord - b.ord);
  return out;
}

const pub = (s) => ({ id: s.id, title: s.title, artist: s.artist, d: s.d, kind: s.kind, url: s.kind === "link" ? s.url : "" });

module.exports = async (req, res) => {
  if (!RURL || !RTOK) return fail(res, 503, "storage_not_configured");
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (q.audio) {
        const id = String(q.audio);
        if (!ID_RE.test(id)) return fail(res, 400, "bad_id");
        const rec = parse(await redis(["HGET", SONGS, id]));
        if (!rec || rec.st !== "ready" || rec.kind !== "file" || !AUDIO_MIME.includes(rec.mime)) return fail(res, 404, "not_found");
        const total = rec.size, cs = rec.cs, n = rec.n;
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("Content-Type", rec.mime);
        res.setHeader("Accept-Ranges", "bytes");
        let s = 0, e = total - 1, ranged = false;
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
        if (m && (m[1] !== "" || m[2] !== "")) {
          ranged = true;
          if (m[1] === "") { s = Math.max(0, total - parseInt(m[2], 10)); e = total - 1; }
          else { s = parseInt(m[1], 10); e = m[2] === "" ? total - 1 : Math.min(parseInt(m[2], 10), total - 1); }
          if (!(s >= 0 && s < total && e >= s)) { res.setHeader("Content-Range", "bytes */" + total); return res.status(416).end(); }
        }
        // A response can't be bigger than the platform allows, so long files are served in segments.
        if (e - s + 1 > RESP_CAP) { e = s + RESP_CAP - 1; ranged = true; }
        const first = Math.floor(s / cs), last = Math.min(n - 1, Math.floor(e / cs));
        const keys = [];
        for (let i = first; i <= last; i++) keys.push(chunkKey(id, i));
        const parts = await redis(["MGET", ...keys]);
        if (!parts || parts.some((p) => typeof p !== "string")) return fail(res, 404, "no_media");
        const buf = Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
        const off = s - first * cs;
        const out = buf.subarray(off, off + (e - s + 1));
        res.setHeader("Content-Length", String(out.length));
        if (ranged) {
          res.setHeader("Content-Range", `bytes ${s}-${s + out.length - 1}/${total}`);
          return res.status(206).end(out);
        }
        return res.status(200).end(out);
      }
      const raw = pairs(await redis(["HGETALL", SONGS]));
      const songs = merge(raw, Date.now()).filter((s) => !s.hide && !s.pending).map(pub);
      res.setHeader("Cache-Control", "public, max-age=0, s-maxage=5, stale-while-revalidate=20");
      return res.status(200).json({ songs });
    }

    if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.token !== "string" || !body.token) return fail(res, 400, "bad_request");

    const u = await discordUser(body.token);
    if (!u) return fail(res, 401, "invalid_or_expired_login");
    // Everything below is owner-only, checked here on the server.
    if (!OWNERS.includes(u.id)) return fail(res, 403, "owners_only");
    const now = Date.now();
    const action = body.action;

    if (action === "song_list") {
      const raw = pairs(await redis(["HGETALL", SONGS]));
      return res.status(200).json({ songs: merge(raw, now) });
    }

    if (action === "song_create") {
      const raw = pairs(await redis(["HGETALL", SONGS]));
      const all = merge(raw, now);
      if (all.length >= MAX_SONGS) return fail(res, 507, "songs_full");
      // sweep abandoned uploads
      for (const id of Object.keys(raw)) {
        const r = parse(raw[id]);
        if (r && r.st === "pending" && now - (r.ts || 0) >= PENDING_TTL) { await redis(["HDEL", SONGS, id]); await dropAudio(id, r); }
      }
      const id = require("crypto").randomBytes(8).toString("hex");
      const d = Math.max(0, Math.min(36000, Math.round(Number(body.d) || 0)));
      const ord = all.reduce((m, s) => Math.max(m, s.ord), 0) + 1;
      const rec = { title: clean(body.title, 80) || "Untitled", artist: clean(body.artist, 80), d, ord, ts: now, st: "ready" };
      if (body.link) {
        const url = parseAudioLink(body.link);
        if (!url) return fail(res, 400, "bad_link");
        rec.kind = "link"; rec.url = url;
      } else {
        const size = Number(body.size), cs = Number(body.cs), n = Number(body.chunks), mime = String(body.mime || "");
        if (!(size > 0 && size <= MAX_AUDIO) || !Number.isInteger(cs) || cs < 1 || cs > MAX_RAW_CHUNK
          || !Number.isInteger(n) || n < 1 || n > MAX_CHUNKS || n !== Math.ceil(size / cs) || !AUDIO_MIME.includes(mime)) return fail(res, 400, "bad_audio");
        rec.kind = "file"; rec.mime = mime; rec.size = size; rec.cs = cs; rec.n = n; rec.st = "pending";
      }
      await redis(["HSET", SONGS, id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true, id, st: rec.st });
    }

    if (action === "song_chunk" || action === "song_finish") {
      const id = String(body.id || "");
      if (!ID_RE.test(id)) return fail(res, 400, "bad_id");
      const rec = parse(await redis(["HGET", SONGS, id]));
      if (!rec) return fail(res, 404, "not_found");
      if (rec.st !== "pending") return fail(res, 400, "not_pending");
      if (action === "song_chunk") {
        const i = Number(body.i), d = body.data;
        if (!Number.isInteger(i) || i < 0 || i >= rec.n) return fail(res, 400, "bad_chunk");
        if (typeof d !== "string" || !d || d.length > MAX_CHUNK_B64 || !B64_RE.test(d)) return fail(res, 400, "bad_chunk");
        const want = i < rec.n - 1 ? rec.cs : rec.size - (rec.n - 1) * rec.cs;
        if (Buffer.byteLength(d, "base64") !== want) return fail(res, 400, "bad_chunk");
        await redis(["SET", chunkKey(id, i), d]);
        return res.status(200).json({ ok: true });
      }
      const keys = [];
      for (let i = 0; i < rec.n; i++) keys.push(chunkKey(id, i));
      const have = await redis(["EXISTS", ...keys]);
      if (have !== rec.n) return fail(res, 400, "missing_chunks");
      rec.st = "ready"; rec.ts = now;
      await redis(["HSET", SONGS, id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true });
    }

    if (action === "song_update") {
      const id = String(body.id || "");
      const builtin = BID_RE.test(id) && BUILTIN.some((b) => b.id === id);
      if (!builtin && !ID_RE.test(id)) return fail(res, 400, "bad_id");
      const stored = parse(await redis(["HGET", SONGS, id]));
      if (!builtin && (!stored || stored.st !== "ready")) return fail(res, 404, "not_found");
      const rec = stored || {};
      if (builtin) rec.builtin = 1;
      if (typeof body.title === "string") rec.title = clean(body.title, 80) || (builtin ? BUILTIN.find((b) => b.id === id).title : "Untitled");
      if (typeof body.artist === "string") rec.artist = clean(body.artist, 80);
      if (body.d !== undefined) rec.d = Math.max(0, Math.min(36000, Math.round(Number(body.d) || 0)));
      if (typeof body.hide === "boolean") rec.hide = body.hide;
      await redis(["HSET", SONGS, id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true });
    }

    if (action === "song_delete") {
      const id = String(body.id || "");
      if (BID_RE.test(id)) return fail(res, 400, "builtin_song");
      if (!ID_RE.test(id)) return fail(res, 400, "bad_id");
      const rec = parse(await redis(["HGET", SONGS, id]));
      if (!rec) return res.status(200).json({ ok: true });
      await redis(["HDEL", SONGS, id]);
      await dropAudio(id, rec);
      return res.status(200).json({ ok: true });
    }

    if (action === "song_reset") {
      const id = String(body.id || "");
      if (!BUILTIN.some((b) => b.id === id)) return fail(res, 400, "bad_id");
      await redis(["HDEL", SONGS, id]);
      return res.status(200).json({ ok: true });
    }

    if (action === "song_reorder") {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, MAX_SONGS + BUILTIN.length) : [];
      if (!ids.length || new Set(ids).size !== ids.length) return fail(res, 400, "bad_order");
      const raw = pairs(await redis(["HGETALL", SONGS]));
      const args = [];
      ids.forEach((id, idx) => {
        const builtin = BUILTIN.some((b) => b.id === id);
        if (!builtin && !ID_RE.test(id)) return;
        const rec = parse(raw[id]) || (builtin ? { builtin: 1 } : null);
        if (!rec) return;
        rec.ord = idx;
        args.push(id, JSON.stringify(rec));
      });
      if (!args.length) return fail(res, 400, "bad_order");
      await redis(["HSET", SONGS, ...args]);
      return res.status(200).json({ ok: true });
    }

    return fail(res, 400, "bad_action");
  } catch (e) {
    console.error("songs api:", e && e.message);
    return fail(res, 500, "server_error");
  }
};
