# Caddy with DNS-provider plugins, so it can get a real HTTPS certificate through a DNS
# challenge. Nothing has to be reachable from the internet; works for home-only servers.
# Pick the provider with DNS_PROVIDER in .env (dynv6 or duckdns).
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/dynv6 \
    --with github.com/caddy-dns/duckdns

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
