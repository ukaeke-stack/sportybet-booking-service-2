const express = require("express");
const path = require("path");
const { analyzeEvent, rankPredictions, optimizeSlip, getPredictionModels, selectPredictionModels, extractOutcomes, listMarketFamilies } = require("./analytics");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.SPORTYBET_API_BASE_URL || "https://www.sportybet.com";
const REGION = process.env.SPORTYBET_REGION || "ng";
const TIMEOUT_MS = Number(process.env.SPORTYBET_TIMEOUT_MS || 15000);
const MAX_RETRIES = Number(process.env.SPORTYBET_MAX_RETRIES || 2);
const CACHE_TTL_MS = Number(process.env.SPORTYBET_CACHE_TTL_MS || 90000);
const DEFAULT_MARKET_IDS = process.env.SPORTYBET_MARKET_IDS || "1,18,10,29,11,26,36,14,60100";

const fixtureCache = new Map();
const fixtureInFlight = new Map();
const eventMarketCache = new Map();
const eventMarketInFlight = new Map();

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
  let events = tournaments.flatMap(t => Array.isArray(t?.events) ? t.events.map(e => ({
    ...e,
    tournamentName: e?.tournamentName || t?.tournamentName || t?.name || t?.tournament?.name || null,
    categoryName: e?.categoryName || t?.categoryName || t?.category?.name || null,
    tournamentId: e?.tournamentId || t?.tournamentId || t?.id || null,
    categoryId: e?.categoryId || t?.categoryId || t?.category?.id || null
  })) : []);
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
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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
    const predictions = events.flatMap(event => analyzeEvent(event, marketFilter, models).predictions);
    const ranked = rankPredictions(predictions, { minProbability, limit });
    res.json({
      ok: true,
      app: "Omegaplus AI",
      selectedModels: models,
      modelInputs: models.map(m => ({ id: m.id, status: m.status, type: m.type })),
      count: ranked.length,
      predictions: ranked
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/over15", async (req, res) => {
  try {
    const models = selectPredictionModels(req.query.models ? String(req.query.models).split(",") : ["market-implied", "ensemble"]);
    const minProbability = Math.min(Math.max(Number(req.query.minProbability || 0.78), 0.5), 0.99);
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 25);
    const params = new URLSearchParams({
      sportId: "sr:sport:1", marketId: DEFAULT_MARKET_IDS, pageSize: "100", pageNum: "1",
      todayGames: "true", timeline: String(Math.min(Math.max(Number(req.query.timeline || 720), 12), 720)), _t: String(Date.now())
    });
    const cacheParams = new URLSearchParams(params); cacheParams.delete("_t");
    const key = `${REGION}:${cacheParams.toString()}`;
    let data = fixtureCache.get(key);
    const freshEnough = data && Date.now() - data.timestamp < CACHE_TTL_MS;
    if (!freshEnough) {
      let pending = fixtureInFlight.get(key);
      if (!pending) {
        pending = sportyFetch(`factsCenter/pcUpcomingEvents?${params}`)
          .then(raw => ({ events: extractEvents(raw), totalNum: raw?.data?.totalNum ?? raw?.totalNum ?? null, timestamp: Date.now() }))
          .finally(() => fixtureInFlight.delete(key));
        fixtureInFlight.set(key, pending);
      }
      try { data = await pending; fixtureCache.set(key, data); }
      catch (e) { if (!data) throw e; data = { ...data, stale: true, upstreamError: e.message }; }
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone:"Africa/Lagos", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
    const todayEvents = data.events.filter(e => {
      const ts = Number(e?.estimateStartTime ?? e?.startTime ?? e?.scheduledStartTime ?? e?.startTimestamp);
      if (!Number.isFinite(ts)) return false;
      const d = new Intl.DateTimeFormat("en-CA", { timeZone:"Africa/Lagos", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(ts < 1e12 ? ts*1000 : ts));
      return d === today;
    });
    const all = todayEvents.flatMap(e => analyzeEvent(e, "over 1.5", models).predictions)
      .filter(p => /over\s*1\.5|over1\.5|o1\.5/i.test(p.selection));
    const selected = rankPredictions(all, { minProbability, limit });
    res.json({ ok:true, market:"Over 1.5 Goals", count:selected.length, requested:limit, todayEvents:todayEvents.length, stale:Boolean(data.stale),
      warning:"Model probabilities are estimates, not guarantees. Live-stat signals are heuristic unless calibrated.",
      selectedModels:models, predictions:selected });
  } catch (error) {
    res.status(error.status || 502).json({ ok:false, error:error.message, upstream:error.data || null });
  }
});

async function getEventMarkets(eventId) {
  const key = String(eventId);
  const cached = eventMarketCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  let pending = eventMarketInFlight.get(key);
  if (!pending) {
    pending = sportyFetch(`factsCenter/pcEventMarkets?eventId=${encodeURIComponent(key)}`)
      .finally(() => eventMarketInFlight.delete(key));
    eventMarketInFlight.set(key, pending);
  }
  const data = await pending;
  eventMarketCache.set(key, { data, timestamp: Date.now() });
  return data;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (error) { results[i] = { error }; }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, runWorker));
  return results;
}

app.get("/api/market-families", (_req, res) => {
  res.json({ ok:true, markets:listMarketFamilies() });
});

app.get("/api/multi-market", async (req, res) => {
  try {
    const family = typeof req.query.family === "string" ? req.query.family.trim() : "";
    const league = typeof req.query.league === "string" ? req.query.league.trim().toLowerCase() : "";
    const minProbability = Math.min(Math.max(Number(req.query.minProbability || 0.78), 0.5), 0.99);
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 50);
    const maxEvents = Math.min(Math.max(Number(req.query.maxEvents || 40), 1), 60);
    const models = selectPredictionModels(req.query.models ? String(req.query.models).split(",") : ["market-implied","ensemble"]);

    const params = new URLSearchParams({
      sportId:"sr:sport:1", marketId:DEFAULT_MARKET_IDS, pageSize:"100", pageNum:"1",
      todayGames:"true", timeline:String(Math.min(Math.max(Number(req.query.timeline || 720),12),720)), _t:String(Date.now())
    });
    const cacheParams = new URLSearchParams(params); cacheParams.delete("_t");
    const key = `${REGION}:${cacheParams.toString()}`;
    let data = fixtureCache.get(key);
    if (!data || Date.now() - data.timestamp >= CACHE_TTL_MS) {
      let pending = fixtureInFlight.get(key);
      if (!pending) {
        pending = sportyFetch(`factsCenter/pcUpcomingEvents?${params}`)
          .then(raw => ({events:extractEvents(raw), totalNum:raw?.data?.totalNum ?? raw?.totalNum ?? null, timestamp:Date.now()}))
          .finally(()=>fixtureInFlight.delete(key));
        fixtureInFlight.set(key,pending);
      }
      data = await pending;
      fixtureCache.set(key,data);
    }

    const today = new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Lagos",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const todayEvents = data.events.filter(e => {
      const ts=Number(e?.estimateStartTime ?? e?.startTime ?? e?.scheduledStartTime ?? e?.startTimestamp);
      if (!Number.isFinite(ts)) return false;
      const d=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Lagos",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts<1e12?ts*1000:ts));
      return d===today;
    }).filter(e => !league || String(e?.tournamentName || e?.tournament?.name || e?.categoryName || e?.leagueName || "").toLowerCase() === league).slice(0,maxEvents);

    const details = await mapWithConcurrency(todayEvents, 8, async event => {
      const eventId=String(event.eventId ?? event.id ?? "");
      if (!eventId) return event;
      const markets=await getEventMarkets(eventId);
      return {...event, marketData:markets};
    });
    const predictions = details.flatMap(event => {
      if (event?.error) return [];
      const eventId=String(event.eventId ?? event.id ?? "");
      const marketData=event.marketData;
      const rows=extractOutcomes(marketData);
      if (!rows.length) return analyzeEvent(event,family||null,models).predictions;
      const synthetic={...event, outcomes:rows};
      return analyzeEvent(synthetic,family||null,models).predictions;
    });
    const selected=rankPredictions(predictions,{minProbability,limit,family:family||null});
    res.json({
      ok:true, marketFamily:family||"all", marketCount:listMarketFamilies().length,
      count:selected.length, requested:limit, todayEvents:todayEvents.length,
      failedEvents:details.filter(x=>x?.error).length,
      warning:"Probabilities are model/market estimates, not guarantees. Market-implied probabilities are normalized odds; live signals are heuristic unless calibrated.",
      selectedModels:models, predictions:selected
    });
  } catch(error) {
    res.status(error.status||502).json({ok:false,error:error.message,upstream:error.data||null});
  }});

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

app.post("/api/over15/booking", async (req, res) => {
  try {
    const predictions = Array.isArray(req.body?.predictions) ? req.body.predictions.slice(0, 30) : [];
    if (!predictions.length) return res.status(400).json({ ok:false, error:"predictions must contain at least one selection" });
    const selections = predictions.map((p,i) => {
      if (!p.eventId || !p.marketId || !p.outcomeId) throw Object.assign(new Error(`selection ${i+1} is missing eventId, marketId or outcomeId`), {status:400});
      return {eventId:String(p.eventId), marketId:String(p.marketId), specifier:p.specifier == null ? "" : String(p.specifier), outcomeId:String(p.outcomeId)};
    });
    let data;
    try {
      data = await sportyFetch("orders/share", {method:"POST", body:JSON.stringify({selections})});
    } catch (upstreamError) {
      // SportyBet can reject the anonymous share API while the normal website
      // still supports creating a booking code. Return a browser fallback
      // instead of pretending the code was created.
      const upstream = upstreamError?.data || null;
      return res.status(503).json({
        ok: false,
        fallbackAvailable: true,
        error: upstreamError.message,
        upstream,
        fallback: {
          type: "website",
          url: `${BASE_URL}/${REGION}/`,
          selections: selections.map((s, i) => ({
            number: i + 1,
            eventId: s.eventId,
            marketId: s.marketId,
            specifier: s.specifier,
            outcomeId: s.outcomeId,
            home: predictions[i]?.home || null,
            away: predictions[i]?.away || null,
            selection: predictions[i]?.selection || null,
            odds: predictions[i]?.odds || null
          }))
        }
      });
    }
    const payload=data?.data||data;
    res.json({ok:true,staking:false,count:selections.length,bookingCode:payload?.shareCode||payload?.bookingCode||payload?.code||null,shareURL:payload?.shareURL||payload?.shareUrl||null,deadline:payload?.deadline||null});
  } catch(error) { res.status(error.status||400).json({ok:false,error:error.message,upstream:error.data||null}); }
});

function validateBookingSelections(selections, events) {
  const byEvent = new Map(events.map(e => [String(e.eventId), e]));
  const errors = [];
  for (const s of selections) {
    const event = byEvent.get(String(s.eventId));
    if (!event) {
      errors.push(`Event ${s.eventId} is not in the current SportyBet feed.`);
      continue;
    }
    const markets = Array.isArray(event.markets) ? event.markets : [];
    const market = markets.find(m =>
      String(m.id ?? m.marketId) === String(s.marketId) &&
      (s.specifier == null || String(m.specifier ?? "") === String(s.specifier))
    );
    if (!market) {
      errors.push(`Market ${s.marketId}${s.specifier ? ` (${s.specifier})` : ""} is not available for ${event.homeTeamName || event.homeTeam?.name || "Home"} vs ${event.awayTeamName || event.awayTeam?.name || "Away"}.`);
      continue;
    }
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const outcome = outcomes.find(o => String(o.id ?? o.outcomeId) === String(s.outcomeId));
    if (!outcome) {
      errors.push(`Outcome ${s.outcomeId} is not available on market ${s.marketId} for event ${s.eventId}.`);
      continue;
    }
    if (outcome.isActive === false || market.status === "suspended") {
      errors.push(`Selection ${s.eventId}/${s.marketId}/${s.outcomeId} is no longer active.`);
    }
  }
  return errors;
}

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

    // Refresh the live catalogue immediately before creating the share code.
    // This prevents stale selections/odds from reaching SportyBet's share endpoint.
    const live = await fetchFixtures({ timeline: 720, pageSize: 100, pageNum: 1, todayGames: false });
    const validationErrors = validateBookingSelections(normalized, live);
    if (validationErrors.length) {
      return res.status(409).json({
        ok:false,
        error:"One or more selections are stale or unavailable.",
        validationErrors,
        fallbackAvailable:true,
        fallback:{type:"website",url:`${BASE_URL}/${REGION}/`,selections:normalized}
      });
    }

    let data;
    try {
      data = await sportyFetch("orders/share", {
        method: "POST",
        body: JSON.stringify({ selections: normalized })
      });
    } catch (upstreamError) {
      return res.status(503).json({
        ok:false, fallbackAvailable:true, error:upstreamError.message, upstream:upstreamError.data||null,
        fallback:{type:"website",url:`${BASE_URL}/${REGION}/`,selections:normalized}
      });
    }
    const payload = data?.data || data;
    const bookingCode=payload?.shareCode || payload?.bookingCode || payload?.code || null;
    if (!bookingCode) {
      return res.status(502).json({ok:false,error:"SportyBet did not return a booking/share code",data});
    }
    res.json({ok:true,staking:false,bookingCode,shareURL:payload?.shareURL||payload?.shareUrl||null,deadline:payload?.deadline||null});
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
