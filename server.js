const express = require("express");
const { analyzeEvent, rankPredictions, optimizeSlip, getPredictionModels, selectPredictionModels } = require("./analytics");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.SPORTYBET_API_BASE_URL || "https://www.sportybet.com";
const REGION = process.env.SPORTYBET_REGION || "ng";
const TIMEOUT_MS = Number(process.env.SPORTYBET_TIMEOUT_MS || 15000);
const MAX_RETRIES = Number(process.env.SPORTYBET_MAX_RETRIES || 2);
const CACHE_TTL_MS = Number(process.env.SPORTYBET_CACHE_TTL_MS || 90000);
const DEFAULT_MARKET_IDS = process.env.SPORTYBET_MARKET_IDS || "1,18,10,29,11,26,36,14,60100";

const fixtureCache = new Map();
const fixtureInFlight = new Map();

function sportPath(path) {
  return `${BASE_URL}/api/${REGION}/${path.replace(/^\//, "")}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sportyFetch(path, options = {}, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(sportPath(path), {
      ...options,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        Pragma: "no-cache",
        "Current-Country": REGION.toUpperCase(),
        Referer: `${BASE_URL}/${REGION}/`,
        Origin: BASE_URL,
        "Sec-Ch-Ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": "\"Windows\"",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // 403 is a hard upstream block; retrying it only adds delay.
    // Retry transient throttling/server errors instead.
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(300 * Math.pow(2, attempt));
      return sportyFetch(path, options, attempt + 1);
    }

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

function extractEvents(data) {
  const tournaments = Array.isArray(data?.data?.tournaments)
    ? data.data.tournaments
    : Array.isArray(data?.tournaments) ? data.tournaments : [];
  let events = tournaments.flatMap(t => Array.isArray(t?.events) ? t.events : []);
  if (!events.length) {
    events = Array.isArray(data?.data?.events) ? data.data.events
      : Array.isArray(data?.events) ? data.events
      : Array.isArray(data?.results) ? data.results : [];
  }
  return events;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "omegaplus-ai", staking: false });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const date = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const marketId = typeof req.query.marketId === "string" && req.query.marketId.trim()
      ? req.query.marketId.trim() : DEFAULT_MARKET_IDS;
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

    // Exclude the cache-busting timestamp from our internal cache key.
    // Otherwise every request becomes a cache miss.
    const cacheParams = new URLSearchParams(params);
    cacheParams.delete("_t");
    const cacheKey = `${REGION}:${cacheParams.toString()}`;
    const cached = fixtureCache.get(cacheKey);
    let events;
    let totalNum = null;

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      events = cached.events;
      totalNum = cached.totalNum;
    } else {
      let pending = fixtureInFlight.get(cacheKey);
      if (!pending) {
        pending = sportyFetch(`factsCenter/pcUpcomingEvents?${params.toString()}`)
          .then(data => ({
            events: extractEvents(data),
            totalNum: data?.data?.totalNum ?? data?.totalNum ?? null
          }))
          .finally(() => fixtureInFlight.delete(cacheKey));
        fixtureInFlight.set(cacheKey, pending);
      }
      const fresh = await pending;
      events = fresh.events;
      totalNum = fresh.totalNum;
      fixtureCache.set(cacheKey, { events, totalNum, timestamp: Date.now() });
    }

    if (search) events = events.filter(e => JSON.stringify(e).toLowerCase().includes(search));
    if (date) events = events.filter(e => JSON.stringify(e).includes(date));

    res.json({ ok: true, count: events.length, totalNum, marketId, pageNum, pageSize, events });
  } catch (error) {
    res.status(error.status || 502).json({
      ok: false,
      error: error.message,
      upstream: error.data || null
    });
  }
});

app.get("/api/prediction-models", (_req, res) => {
  res.json({ ok: true, app: "Omegaplus AI", models: getPredictionModels() });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!events.length) return res.status(400).json({ ok: false, error: "events must contain at least one event" });
    const models = selectPredictionModels(req.body?.models);
    const marketFilter = typeof req.body?.marketFilter === "string" && req.body.marketFilter.trim()
      ? req.body.marketFilter.trim() : null;
    const minProbability = Number.isFinite(Number(req.body?.minProbability)) ? Number(req.body.minProbability) : 0.78;
    const limit = Math.min(Math.max(Number(req.body?.limit || 25), 1), 100);
    const predictions = events.flatMap(event => analyzeEvent(event, marketFilter).predictions);
    const ranked = rankPredictions(predictions, { minProbability, limit });
    res.json({
      ok: true,
      app: "Omegaplus AI",
      selectedModels: models,
      modelInputs: models.map(m => ({ id: m.id, status: m.status })),
      count: ranked.length,
      predictions: ranked
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/events/:eventId/markets", async (req, res) => {
  try {
    const eventId = String(req.params.eventId || "").trim();
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

    const normalized = selections.map((s, i) => {
      if (!s || !s.eventId || !s.marketId || !s.outcomeId) {
        throw new Error(`selection ${i + 1} requires eventId, marketId and outcomeId`);
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

    const payload = data?.data || data;
    res.json({
      ok: true,
      staking: false,
      bookingCode: payload?.shareCode || payload?.bookingCode || payload?.code || null,
      shareURL: payload?.shareURL || payload?.shareUrl || null,
      deadline: payload?.deadline || null,
      data
    });
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message, upstream: error.data || null });
  }
});

app.get("/api/booking/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({ ok: false, error: "code is required" });
    const data = await sportyFetch(`orders/share/${encodeURIComponent(code)}`);
    res.json({ ok: true, code, data });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message, upstream: error.data || null });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Omegaplus AI listening on port ${PORT}`);
});
