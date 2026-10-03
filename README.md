# Omegaplus AI

Omegaplus AI is a non-staking football analysis service for finding SportyBet events, selecting prediction models, ranking predictions, and creating share/booking codes from real event, market, specifier, and outcome IDs.

## Boundary

This service does not place bets, stake money, access a user's SportyBet account, or handle passwords, OTPs, PINs, or payment details.

## API

- GET /health
- GET /api/fixtures?search=&date=
- GET /api/events/:eventId/markets
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

The service forwards the selection data to SportyBet's share-order endpoint and returns the resulting share/booking code.

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