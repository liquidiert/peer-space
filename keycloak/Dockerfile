# Pre-built ("optimized") Keycloak for PeerSpace.
# `kc.sh build` bakes the build-time options into the image, so the container starts with
# `start --optimized` instead of re-augmenting Keycloak on every boot (less memory, faster start).
# These must match the runtime config: changing any of them means rebuilding the image.
#
# Use :latest tag to dangerously auto update with new peer-space features.
FROM quay.io/keycloak/keycloak:latest AS builder

ENV KC_DB=postgres \
    KC_CACHE=local \
    KC_HEALTH_ENABLED=true

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:latest

COPY --from=builder /opt/keycloak/ /opt/keycloak/
# Imported on first start only (`--import-realm`); ${...} placeholders are filled from the
# container environment at that moment.
COPY import/ /opt/keycloak/data/import/

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
