const express = require("express");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.SPORTYBET_API_BASE_URL || "https://www.sportybet.com";
const REGION = process.env.SPORTYBET_REGION || "ng";
const TIMEOUT_MS = Number(process.env.SPORTYBET_TIMEOUT_MS || 15000);

function sportPath(path) {
  return `${BASE_URL}/api/${REGION}/${path.replace(/^\//, "")}`;
}

async function sportyFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(sportPath(path), {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Current-Country": REGION.toUpperCase(),
        "User-Agent": "Mozilla/5.0 (compatible; SportyBetBookingService/1.0)",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`SportyBet returned HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    if (data && typeof data === "object" && Number(data.bizCode) && Number(data.bizCode) !== 10000) {
      const error = new Error(`SportyBet rejected the request: ${data.message || data.innerMsg || "Invalid"}`);
      error.status = 422;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sportybet-booking-service", staking: false });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const date = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const marketId = typeof req.query.marketId === "string" ? req.query.marketId : "1";
    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 100), 1), 100);
    const pageNum = Math.max(Number(req.query.pageNum || 1), 1);
    const timeline = Math.min(Math.max(Number(req.query.timeline || 720), 12), 720);
    const params = new URLSearchParams({
      sportId: "sr:sport:1",
      marketId,
      pageSize: String(pageSize),
      pageNum: String(pageNum),
      todayGames: "false",
      timeline: String(timeline),
      _t: String(Date.now())
    });
    const data = await sportyFetch(`factsCenter/pcUpcomingEvents?${params.toString()}`);
    const events = Array.isArray(data?.events) ? data.events
      : Array.isArray(data?.data?.events) ? data.data.events
      : Array.isArray(data?.results) ? data.results
      : data?.data?.tournaments || data?.tournaments || [];
    let list = Array.isArray(events) ? events : [];
    if (search) list = list.filter(e => JSON.stringify(e).toLowerCase().includes(search));
    if (date) list = list.filter(e => JSON.stringify(e).includes(date));
    res.json({ ok: true, count: list.length, events: list });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message, upstream: error.data || null });
  }
});

app.get("/api/events/:eventId/markets", async (req, res) => {
  try {
    const eventId = req.params.eventId.trim();
    if (!eventId) return res.status(400).json({ ok: false, error: "eventId is required" });
    const data = await sportyFetch(`factsCenter/pcEventMarkets?eventId=${encodeURIComponent(eventId)}`);
    res.json({ ok: true, eventId, data });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message, upstream: error.data || null });
  }
});

app.post("/api/booking", async (req, res) => {
  try {
    const selections = req.body?.selections;
    if (!Array.isArray(selections) || selections.length < 1 || selections.length > 30) {
      return res.status(400).json({ ok: false, error: "selections must contain between 1 and 30 items" });
    }
    const normalized = selections.map((s, index) => {
      if (!s || !s.eventId || !s.marketId || !s.outcomeId) {
        throw new Error(`selection ${index + 1} requires eventId, marketId and outcomeId`);
      }
      return {
        eventId: String(s.eventId).trim(),
        marketId: String(s.marketId).trim(),
        specifier: s.specifier == null ? null : String(s.specifier).trim(),
        outcomeId: String(s.outcomeId).trim()
      };
    });
    const data = await sportyFetch("orders/share", {
      method: "POST",
      body: JSON.stringify({ selections: normalized })
    });
    res.json({
      ok: true,
      staking: false,
      bookingCode: data?.data?.shareCode || data?.shareCode || data?.bookingCode || data?.code || null,
      shareURL: data?.data?.shareUrl || data?.shareURL || data?.shareUrl || null,
      data
    });
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message, upstream: error.data || null });
  }
});

app.get("/api/booking/:code", async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, error: "code is required" });
    const data = await sportyFetch(`orders/share/${encodeURIComponent(code)}`);
    res.json({ ok: true, code, data });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message, upstream: error.data || null });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SportyBet booking service listening on port ${PORT}`);
});
