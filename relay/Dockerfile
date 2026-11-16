# Self-hosted iroh relay for PeerSpace browser audio/video. Serves plain HTTP on port 3340.
# TLS is terminated by the reverse proxy in front of the container (Traefik in
# Coolify/Dokploy), so this image contains no certificates and no TLS configuration.
#
# RELAY VERSION: must match the `iroh` version in crates/peer-media/Cargo.lock (1.3.0).
ARG RUST_VERSION=1.91
ARG IROH_RELAY_VERSION=1.3.0

FROM rust:${RUST_VERSION}-bookworm AS builder
ARG IROH_RELAY_VERSION
# The `iroh-relay` binary is gated behind the `server` feature (required-features in Cargo.toml).
# --locked uses the Cargo.lock shipped inside the crate.
RUN cargo install iroh-relay --version ${IROH_RELAY_VERSION} --locked --features server --root /out

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system relay \
    && useradd --system --gid relay --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin relay

COPY --from=builder /out/bin/iroh-relay /usr/local/bin/iroh-relay
COPY relay.toml /etc/iroh-relay/relay.toml
COPY relay-locked.toml.in /etc/iroh-relay/relay-locked.toml.in
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER relay
EXPOSE 3340

# entrypoint.sh picks the open or the access-locked config (see IROH_RELAY_HTTP_BEARER_TOKEN).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
