# Live Presence

Standalone Bun WebSocket service with ephemeral in-memory state. Build/run with Bun; configure `PORT` and explicit `ALLOWED_ORIGINS`. Reverse proxy may publish it under Admin's `/presence` path; it has no database or Admin API dependency.
