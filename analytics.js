const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function impliedProbability(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n <= 1) return null;
  return 1 / n;
}

function normalizeMarketProbabilities(outcomes) {
  const rows = outcomes
    .map(o => ({ ...o, implied: impliedProbability(o.odds) }))
    .filter(o => o.implied != null);
  const total = rows.reduce((s, o) => s + o.implied, 0);
  if (!total) return rows.map(o => ({ ...o, probability: null }));
  return rows.map(o => ({ ...o, probability: o.implied / total }));
}

function extractNamedTeams(event) {
  const home = event?.homeTeamName || event?.homeTeam?.name || event?.home?.name ||
    event?.competitors?.find(c => c.position === 'home')?.name || event?.competitors?.[0]?.name || null;
  const away = event?.awayTeamName || event?.awayTeam?.name || event?.away?.name ||
    event?.competitors?.find(c => c.position === 'away')?.name || event?.competitors?.[1]?.name || null;
  return { home, away };
}

function extractOutcomes(node, path = []) {
  const found = [];
  if (!node || typeof node !== 'object') return found;

  if (Array.isArray(node)) {
    for (const item of node) found.push(...extractOutcomes(item, path));
    return found;
  }

  const outcomeId = node.outcomeId ?? node.outcomeID ?? node.id;
  const odds = node.odds ?? node.price ?? node.value ?? node.outcomeOdds;
  const name = node.outcomeName ?? node.name ?? node.label ?? node.desc;
  const marketId = node.marketId ?? node.marketID ?? node.market?.id ?? node.market?.marketId;

  if (outcomeId != null && odds != null && Number(odds) > 1 && name) {
    found.push({ outcomeId: String(outcomeId), marketId: marketId == null ? null : String(marketId),
      name: String(name), odds: Number(odds) });
  }

  for (const [key, value] of Object.entries(node)) {
    if (['odds', 'price', 'value', 'outcomeOdds'].includes(key)) continue;
    found.push(...extractOutcomes(value, path.concat(key)));
  }
  return found;
}

function scoreQuality({ probability, odds, hasMarket, hasTeams }) {
  let score = 35;
  if (hasMarket) score += 20;
  if (hasTeams) score += 15;
  if (probability != null) score += Math.round(clamp(probability, 0, 1) * 25);
  if (odds && odds >= 1.05 && odds <= 5) score += 5;
  return clamp(score, 0, 100);
}

function classify(probability) {
  if (probability == null) return 'unknown';
  if (probability >= 0.85) return 'very-high';
  if (probability >= 0.78) return 'high';
  if (probability >= 0.68) return 'medium';
  return 'low';
}

function analyzeEvent(event, marketFilter = null) {
  const { home, away } = extractNamedTeams(event);
  const raw = extractOutcomes(event);
  const groups = new Map();

  for (const row of raw) {
    const key = row.marketId || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const predictions = [];
  for (const [marketId, outcomes] of groups) {
    const normalized = normalizeMarketProbabilities(outcomes);
    for (const o of normalized) {
      const label = o.name.toLowerCase();
      if (marketFilter && !label.includes(marketFilter.toLowerCase())) continue;
      const quality = scoreQuality({
        probability: o.probability,
        odds: o.odds,
        hasMarket: marketId !== 'unknown',
        hasTeams: Boolean(home && away)
      });
      predictions.push({
        eventId: String(event.eventId ?? event.id ?? ''),
        home, away,
        marketId,
        outcomeId: o.outcomeId,
        selection: o.name,
        odds: o.odds,
        probability: o.probability == null ? null : Number(o.probability.toFixed(4)),
        confidence: classify(o.probability),
        qualityScore: quality
      });
    }
  }

  return { eventId: String(event.eventId ?? event.id ?? ''), home, away, predictions };
}

function rankPredictions(predictions, { minProbability = 0.78, limit = 25, maxOdds = null, minOdds = null } = {}) {
  return predictions
    .filter(p => p.probability != null)
    .filter(p => p.probability >= minProbability)
    .filter(p => maxOdds == null || p.odds <= maxOdds)
    .filter(p => minOdds == null || p.odds >= minOdds)
    .sort((a, b) => (b.probability - a.probability) || (b.qualityScore - a.qualityScore))
    .slice(0, limit);
}

function optimizeSlip(predictions, { size = 10, bankers = [], excluded = [] } = {}) {
  const excludedSet = new Set(excluded.map(String));
  const bankersSet = new Set(bankers.map(String));
  const unique = new Map();

  for (const p of predictions) {
    if (excludedSet.has(String(p.eventId))) continue;
    const key = String(p.eventId);
    if (!unique.has(key) || p.probability > unique.get(key).probability) unique.set(key, p);
  }

  const selected = [...unique.values()].sort((a, b) => b.probability - a.probability);
  const locked = selected.filter(p => bankersSet.has(String(p.eventId)));
  const rest = selected.filter(p => !bankersSet.has(String(p.eventId)));
  return [...locked, ...rest].slice(0, Math.max(size, locked.length));
}


const PREDICTION_MODELS = [
  {
    id: 'shots',
    name: 'Shots',
    type: 'live',
    status: 'data-dependent',
    description: 'Live total and team shot statistics.'
  },
  {
    id: 'shots-on-target',
    name: 'Shots on Target',
    type: 'live',
    status: 'data-dependent',
    description: 'Live shots-on-target statistics.'
  },
  {
    id: 'possession',
    name: 'Possession',
    type: 'live',
    status: 'data-dependent',
    description: 'Live possession percentages.'
  },
  {
    id: 'dangerous-attacks',
    name: 'Dangerous Attacks',
    type: 'live',
    status: 'data-dependent',
    description: 'Live dangerous-attack statistics.'
  },
  {
    id: 'corners',
    name: 'Corners',
    type: 'live',
    status: 'data-dependent',
    description: 'Live corner statistics.'
  },
  {
    id: 'cards',
    name: 'Cards',
    type: 'live',
    status: 'data-dependent',
    description: 'Live yellow/card statistics.'
  },
  {
    id: 'goals',
    name: 'Goals',
    type: 'live',
    status: 'data-dependent',
    description: 'Current match score and goal events.'
  },
  {
    id: 'xg',
    name: 'xG',
    type: 'live',
    status: 'data-dependent',
    description: 'Live expected-goals statistics.'
  },
  {
    id: 'red-cards',
    name: 'Red Cards',
    type: 'live',
    status: 'data-dependent',
    description: 'Live red-card statistics.'
  },
  {
    id: 'market-implied',
    name: 'Market Probability',
    type: 'pre-match',
    status: 'available',
    description: 'Normalizes market odds into an implied probability.'
  },
  {
    id: 'ensemble',
    name: 'Omegaplus Ensemble',
    type: 'ensemble',
    status: 'available',
    description: 'Combines selected prediction signals when their required data is available.'
  }
];

function getPredictionModels() {
  return PREDICTION_MODELS.map(model => ({ ...model }));
}

function selectPredictionModels(modelIds) {
  const ids = Array.isArray(modelIds) && modelIds.length ? modelIds.map(String) : ['market-implied'];
  const selected = PREDICTION_MODELS.filter(model => ids.includes(model.id));
  return selected.length ? selected : [PREDICTION_MODELS[0]];
}

module.exports = {
  impliedProbability,
  normalizeMarketProbabilities,
  extractNamedTeams,
  analyzeEvent,
  rankPredictions,
  optimizeSlip,
  classify,
  PREDICTION_MODELS,
  getPredictionModels,
  selectPredictionModels
};
