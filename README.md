# Wolcom 0.5.0 — tenant customization

This app-only update adds customer-specific branding, custom domains and channel administration on top of Wolcom 0.4.10.

## Customer branding
Customer Admin can open **Control → Branding & domains** and upload a customer logo, choose Dark/Light theme and an accent/background color. Customer branding always shows a discreet **Powered by Wolcom** signature. The global Wolcom favicon remains installation-wide.

## Custom domains
A customer can register a hostname such as `intercom.example.com`. Wolcom asks for a DNS CNAME to `call.wolcom.se`, verifies that CNAME and then maps the verified hostname to the organization using the HTTP Host header. In 0.5.0 TLS/reverse-proxy provisioning is intentionally manual: add the verified hostname and certificate in Nginx Proxy Manager. Wolcom does not receive NPM credentials.

## Channels
Customer users can rename channels and choose a short icon while keeping the stable channel UUID used by LiveKit, chat and monitor routing. The backend also stores description, accent color, active/default listen/default talk and default pan fields for later UI expansion.

## Capacity/pricing foundation
Organizations now have `max_concurrent_users`, intended for hosted pricing based on concurrent participants rather than registered accounts. 0.5.0 stores and displays the limit but does not hard-disconnect users when the limit is reached; reliable enforcement should use LiveKit room participant state in a later release.

## Install
Upload `wolcom-update-0.5.0.tar.gz` via HQ → Updates. It recreates only the app container; PostgreSQL, Redis, LiveKit and the updater remain running.
