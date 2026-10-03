const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function impliedProbability(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n <= 1) return null;
  return 1 / n;
}

function normalizeMarketProbabilities(outcomes) {
  const rows = outcomes.map(o => ({ ...o, implied: impliedProbability(o.odds) })).filter(o => o.implied != null);
  const total = rows.reduce((s, o) => s + o.implied, 0);
  return total ? rows.map(o => ({ ...o, probability: o.implied / total })) : rows.map(o => ({ ...o, probability: null }));
}

function extractNamedTeams(event) {
  const home = event?.homeTeamName || event?.homeTeam?.name || event?.home?.name ||
    event?.competitors?.find(c => c.position === 'home')?.name || event?.competitors?.[0]?.name || null;
  const away = event?.awayTeamName || event?.awayTeam?.name || event?.away?.name ||
    event?.competitors?.find(c => c.position === 'away')?.name || event?.competitors?.[1]?.name || null;
  return { home, away };
}

function extractOutcomes(node, path = [], context = {}) {
  const found = [];
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) found.push(...extractOutcomes(item, path, context));
    return found;
  }
  const ownMarketId = node.marketId ?? node.marketID ?? node.market?.id ?? node.market?.marketId ??
    (Array.isArray(node.outcomes) ? node.id : context.marketId);
  const ownSpecifier = node.specifier ?? node.market?.specifier ?? context.specifier ?? null;
  const outcomeId = node.outcomeId ?? node.outcomeID ?? (context.marketId ? node.id : node.outcomeId ?? node.outcomeID);
  const odds = node.odds ?? node.price ?? node.value ?? node.outcomeOdds;
  const name = node.outcomeName ?? node.name ?? node.label ?? node.desc;
  if (outcomeId != null && odds != null && Number(odds) > 1 && name && context.marketId) {
    found.push({ outcomeId: String(outcomeId), marketId: String(context.marketId), name: String(name), odds: Number(odds), specifier: ownSpecifier });
  }
  const childContext = {
    marketId: ownMarketId ?? context.marketId ?? null,
    specifier: ownSpecifier
  };
  for (const [key, value] of Object.entries(node)) {
    if (["odds", "price", "value", "outcomeOdds"].includes(key)) continue;
    found.push(...extractOutcomes(value, path.concat(key), childContext));
  }
  return found;
}

function scoreQuality({ probability, odds, hasMarket, hasTeams, dataCompleteness = 0 }) {
  let score = 25;
  if (hasMarket) score += 15;
  if (hasTeams) score += 10;
  if (probability != null) score += Math.round(clamp(probability, 0, 1) * 25);
  if (odds && odds >= 1.05 && odds <= 5) score += 5;
  score += Math.round(clamp(dataCompleteness, 0, 1) * 20);
  return clamp(score, 0, 100);
}

function classify(probability) {
  if (probability == null) return 'unknown';
  if (probability >= 0.85) return 'very-high';
  if (probability >= 0.78) return 'high';
  if (probability >= 0.68) return 'medium';
  return 'low';
}

const PREDICTION_MODELS = [
  { id: 'shots', name: 'Shots', type: 'live', status: 'available', description: 'Live total and team shot statistics.' },
  { id: 'shots-on-target', name: 'Shots on Target', type: 'live', status: 'available', description: 'Live shots-on-target statistics.' },
  { id: 'possession', name: 'Possession', type: 'live', status: 'available', description: 'Live possession percentages.' },
  { id: 'dangerous-attacks', name: 'Dangerous Attacks', type: 'live', status: 'available', description: 'Live dangerous-attack statistics.' },
  { id: 'corners', name: 'Corners', type: 'live', status: 'available', description: 'Live corner statistics.' },
  { id: 'cards', name: 'Cards', type: 'live', status: 'available', description: 'Live card statistics.' },
  { id: 'goals', name: 'Goals', type: 'live', status: 'available', description: 'Current score and goal events.' },
  { id: 'xg', name: 'xG', type: 'live', status: 'available', description: 'Live expected-goals statistics when supplied by the feed.' },
  { id: 'red-cards', name: 'Red Cards', type: 'live', status: 'available', description: 'Live red-card statistics.' },
  { id: 'market-implied', name: 'Market Probability', type: 'pre-match', status: 'available', description: 'Normalizes market odds into an implied probability.' },
  { id: 'ensemble', name: 'Omegaplus Ensemble', type: 'ensemble', status: 'available', description: 'Combines selected signals using only data actually present.' }
];

const STAT_ALIASES = {
  shots: ['shots', 'totalShots', 'shotsTotal'],
  'shots-on-target': ['shotsOnTarget', 'onTarget', 'shotsOnGoal'],
  possession: ['possession', 'possessionPct', 'possessionPercentage'],
  'dangerous-attacks': ['dangerousAttacks', 'dangerousAttack', 'dangerous_attacks'],
  corners: ['corners', 'corner', 'cornerKicks'],
  cards: ['cards', 'yellowCards', 'totalCards'],
  goals: ['goals', 'score'],
  xg: ['xg', 'expectedGoals', 'expected_goals'],
  'red-cards': ['redCards', 'red_card', 'redcards']
};

function number(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace('%', '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstNumber(obj, aliases) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of aliases) {
    const n = number(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function normalizeSidePair(value, aliases) {
  if (Array.isArray(value) && value.length >= 2) return { home: number(value[0]), away: number(value[1]) };
  if (!value || typeof value !== 'object') return null;
  const home = firstNumber(value, ['home', 'homeValue', 'homeTeam', 'home_value', '1']);
  const away = firstNumber(value, ['away', 'awayValue', 'awayTeam', 'away_value', '2']);
  if (home != null || away != null) return { home, away };
  for (const key of aliases) {
    if (value[key] && value[key] !== value) {
      const nested = normalizeSidePair(value[key], aliases);
      if (nested) return nested;
    }
  }
  return null;
}

function findStatSource(event, aliases) {
  const roots = [event?.stats, event?.statistics, event?.liveStats, event?.liveStatistics, event?.matchStats, event?.statisticsData];
  for (const root of roots) {
    const pair = normalizeSidePair(root, aliases);
    if (pair && (pair.home != null || pair.away != null)) return pair;
    if (root && typeof root === 'object') {
      for (const key of Object.keys(root)) {
        if (aliases.includes(key)) {
          const pair2 = normalizeSidePair(root[key], aliases);
          if (pair2 && (pair2.home != null || pair2.away != null)) return pair2;
        }
      }
    }
  }
  const homeObj = event?.homeStats || event?.homeStatistics || event?.homeTeam?.stats;
  const awayObj = event?.awayStats || event?.awayStatistics || event?.awayTeam?.stats;
  if (homeObj || awayObj) {
    return { home: firstNumber(homeObj, aliases), away: firstNumber(awayObj, aliases) };
  }
  return null;
}

function extractLiveStats(event) {
  const stats = {};
  for (const [id, aliases] of Object.entries(STAT_ALIASES)) {
    const pair = findStatSource(event, aliases);
    if (pair && (pair.home != null || pair.away != null)) stats[id] = pair;
  }
  const score = stats.goals || normalizeSidePair(event?.score || event?.scores || event?.result, ['home', 'away']);
  if (score && (score.home != null || score.away != null)) stats.goals = score;
  return stats;
}

function pairSignal(pair, mode = 'total') {
  if (!pair) return null;
  const h = pair.home == null ? 0 : pair.home;
  const a = pair.away == null ? 0 : pair.away;
  if (mode === 'dominance') return clamp(Math.abs(h - a) / Math.max(h + a, 1), 0, 1);
  return clamp((h + a), 0, 100);
}

function liveOver15Signal(stats) {
  const signals = [];
  const add = (id, value, weight) => { if (Number.isFinite(value)) signals.push({ id, value: clamp(value, 0, 1), weight }); };

  const goals = stats.goals;
  if (goals && (goals.home != null || goals.away != null)) {
    const g = (goals.home || 0) + (goals.away || 0);
    add('goals', g >= 2 ? 1 : g === 1 ? 0.72 : 0.25, 0.30);
  }
  if (stats.xg) {
    const xg = (stats.xg.home || 0) + (stats.xg.away || 0);
    add('xg', 1 - Math.exp(-Math.max(0, xg) * 0.9), 0.22);
  }
  if (stats['shots-on-target']) {
    const s = pairSignal(stats['shots-on-target']);
    add('shots-on-target', 1 - Math.exp(-s / 3.2), 0.15);
  }
  if (stats.shots) {
    const s = pairSignal(stats.shots);
    add('shots', 1 - Math.exp(-s / 8), 0.10);
  }
  if (stats['dangerous-attacks']) {
    const s = pairSignal(stats['dangerous-attacks']);
    add('dangerous-attacks', 1 - Math.exp(-s / 35), 0.08);
  }
  if (stats.corners) {
    const s = pairSignal(stats.corners);
    add('corners', 1 - Math.exp(-s / 3.5), 0.05);
  }
  if (stats.possession) {
    const p = stats.possession;
    const total = (p.home || 0) + (p.away || 0);
    const balance = total > 0 ? 1 - Math.abs((p.home || 0) - (p.away || 0)) / total : 0;
    add('possession', balance, 0.03);
  }
  if (stats['red-cards']) {
    const rc = (stats['red-cards'].home || 0) + (stats['red-cards'].away || 0);
    add('red-cards', rc ? 0.58 : 0.5, 0.02);
  }
  if (stats.cards) {
    const cards = (stats.cards.home || 0) + (stats.cards.away || 0);
    add('cards', 1 - Math.exp(-cards / 4), 0.02);
  }
  const weight = signals.reduce((s, x) => s + x.weight, 0);
  if (!weight) return null;
  const score = signals.reduce((s, x) => s + x.value * x.weight, 0) / weight;
  return { score: clamp(score, 0, 1), signals, completeness: signals.reduce((s, x) => s + x.weight, 0) };
}

function analyzeEvent(event, marketFilter = null, selectedModels = ['market-implied']) {
  const { home, away } = extractNamedTeams(event);
  const raw = extractOutcomes(event);
  const groups = new Map();
  for (const row of raw) {
    const key = row.marketId || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const stats = extractLiveStats(event);
  const liveModels = selectedModels.filter(m => m.type === 'live').map(m => m.id);
  const live = liveOver15Signal(stats);
  const predictions = [];

  for (const [marketId, outcomes] of groups) {
    const normalized = normalizeMarketProbabilities(outcomes);
    for (const o of normalized) {
      const label = o.name.toLowerCase();
      if (marketFilter && !label.includes(marketFilter.toLowerCase())) continue;
      const isOver15 = /over\s*1\.5|over1\.5|o1\.5/.test(label);
      let probability = o.probability;
      let source = 'market-implied';
      if (isOver15 && live && liveModels.length) {
        probability = live.score;
        source = 'live-statistics';
      }
      if (isOver15 && selectedModels.some(m => m.id === 'ensemble') && live && o.probability != null) {
        probability = clamp((o.probability * 0.55) + (live.score * 0.45), 0, 1);
        source = 'ensemble';
      }
      const quality = scoreQuality({
        probability,
        odds: o.odds,
        hasMarket: marketId !== 'unknown',
        hasTeams: Boolean(home && away),
        dataCompleteness: live ? live.completeness : 0
      });
      predictions.push({
        eventId: String(event.eventId ?? event.id ?? ''),
        home, away, marketId, outcomeId: o.outcomeId, selection: o.name, odds: o.odds, specifier: o.specifier,
        probability: probability == null ? null : Number(probability.toFixed(4)),
        confidence: classify(probability), qualityScore: quality, source,
        liveStats: Object.keys(stats),
        liveSignal: isOver15 && live ? Number(live.score.toFixed(4)) : null
      });
    }
  }
  return { eventId: String(event.eventId ?? event.id ?? ''), home, away, predictions, stats, liveSignal: live };
}

function rankPredictions(predictions, { minProbability = 0.78, limit = 25, maxOdds = null, minOdds = null } = {}) {
  return predictions.filter(p => p.probability != null)
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

function getPredictionModels() { return PREDICTION_MODELS.map(model => ({ ...model })); }

function selectPredictionModels(modelIds) {
  const ids = Array.isArray(modelIds) && modelIds.length ? modelIds.map(String) : ['market-implied'];
  const selected = PREDICTION_MODELS.filter(model => ids.includes(model.id));
  return selected.length ? selected : [PREDICTION_MODELS.find(m => m.id === 'market-implied')];
}

module.exports = {
  impliedProbability, normalizeMarketProbabilities, extractNamedTeams, extractOutcomes, extractLiveStats,
  liveOver15Signal, analyzeEvent, rankPredictions, optimizeSlip, classify,
  PREDICTION_MODELS, getPredictionModels, selectPredictionModels
};
