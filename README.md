# ARIAN TERMINAL Worker

Safe external worker shell for the Solana-first ARIAN TERMINAL deployment.

## Current stage
- HTTP health endpoint: `/` and `/health`
- Docker-ready
- No production credentials committed
- No Supabase writes enabled yet

## Security
Real credentials must be configured only as hosting environment variables. Never commit `.env` or service-role keys.

## Deployment
Designed for deployment from this public repository to Blitz Cloud. First validate the health endpoint. Production collectors will be migrated incrementally only after the service is stable.
