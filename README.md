# EU Grants Feed

A static, searchable browser for open and forthcoming European Commission funding calls.

## Data source

This project does not use RSS. The Funding & Tenders Portal exposes a public search API and public facet dictionaries, which this project uses to generate a local JSON snapshot:

- `https://ec.europa.eu/info/funding-tenders/opportunities/portal/assets/openid-login-config.json`
- `https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA`
- `https://api.tech.ec.europa.eu/search-api/prod/rest/facet?apiKey=SEDIA`

## Run locally

```bash
npm run update:data
npm run dev
```

Then open `http://localhost:4173`.

## Daily refresh

A GitHub Actions workflow is included at `.github/workflows/daily-refresh.yml`.
It regenerates `data/grants.json` once a day and commits the updated snapshot if the source data changed.
