# SportyBet Booking Service

Non-staking HTTP service for finding SportyBet football events and creating share/booking codes from real event, market, specifier, and outcome IDs.

## Boundary

This service does not place bets, stake money, access a user's SportyBet account, or handle passwords, OTPs, PINs, or payment details.

## API

- GET /health
- GET /api/fixtures?search=&date=
- GET /api/events/:eventId/markets
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
