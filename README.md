# Omegaplus AI

Omegaplus AI is a non-staking football analysis service for finding SportyBet events, selecting prediction models, ranking predictions, and creating share/booking codes from real event, market, specifier, and outcome IDs.

## Boundary

This service does not place bets, stake money, access a user's SportyBet account, or handle passwords, OTPs, PINs, or payment details.

## API

- GET /health
- GET /api/fixtures?search=&date=
- GET /api/events/:eventId/markets
- GET /api/market-families
- GET /api/multi-market?family=goals|btts|1x2|double-chance|dnb|asian-handicap|handicap|corners|cards|team-goals|first-half|combo|correct-score
- GET /api/prediction-models
- POST /api/analyze
- POST /api/booking
- GET /api/booking/:code

### Create booking code

POST /api/booking

Body:
{
  "selections": [
    {
      "eventId": "EVENT_ID",
      "marketId": "MARKET_ID",
      "specifier": "SPECIFIER",
      "outcomeId": "OUTCOME_ID"
    }
  ]
}

The service forwards the selection data to SportyBet's share-order endpoint and returns the resulting share/booking code. If SportyBet rejects the anonymous share endpoint, the API returns a website fallback with the exact selections instead of fabricating a code.

### Multi-market analysis

`/api/multi-market` fetches today's events, retrieves event-market data with bounded concurrency and caching, classifies selections into supported market families, and ranks them by normalized market probability. Supported families include goals O/U, BTTS, 1X2, double chance, draw no bet, handicap/Asian handicap, corners, cards/bookings, team goals, first-half markets, combinations, and correct score.

The engine does not claim calibrated win probabilities: market-implied probabilities are normalized from odds and live-stat adjustments are heuristic.

## Important

SportyBet does not provide a verified public developer API for these endpoints. This implementation uses web endpoints observed in the open-source SportyBet MCP ecosystem. SportyBet can change undocumented endpoints at any time.

## Railway

Run with:

npm start

Optional environment variables:
- PORT
- SPORTYBET_API_BASE_URL (default: https://www.sportybet.com)
- SPORTYBET_REGION (default: ng)
- SPORTYBET_COUNTRY (default: NG)
- SPORTYBET_TIMEOUT_MS (default: 15000)

## Selectable prediction models

The live prediction engine is designed around these match statistics:

- Shots
- Shots on Target
- Possession
- Dangerous Attacks
- Corners
- Cards
- Goals
- xG
- Red Cards
- Market Probability
- Omegaplus Ensemble

The live-stat models are data-dependent: they become analytically usable when the live feed supplies the corresponding match statistics.