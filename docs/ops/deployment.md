# Deployment

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

The end-to-end deployment walkthrough for `infra/compose.prod.yaml`: prerequisites, TLS (the public `Caddyfile` variant and the air-gapped `Caddyfile.internal` variant), secrets, creating the first admin, and post-deploy smoke checks — reproducing verbatim the hardened compose file, the Prometheus scrape and alerting setup, the outbound-network ("what leaves the box") statement, the supported-clients table, and the capacity starting points calibrated against the M8 load SLOs. Rewritten as a verbatim-followable procedure at M8 and validated by the nightly `compose.prod clean-VM boot` job.

## Source

- docs/plan/11-operations-and-deployment.md, "Container images and build", "Reverse proxy", "Capacity and admission control"
- docs/plan/12-milestones.md §12 (M8 scope: "rewritten as a verbatim-followable procedure ... validated by the clean-VM run")

## Enterprise CA trust and certificate pinning (Electron desktop)

Written early, ahead of the rest of this document, because `docs/spikes/S07-electron-enterprise-ca.md`
measured this behaviour before M5 builds the desktop TLS handling against it.

Enterprises that terminate TLS with a private certificate authority have two ways to make the
Iridium desktop client trust it. The one to use for a private-CA deployment, on every operating
system, is the per-profile fingerprint pin: setting `pinnedCertSha256` on the server profile makes
the client accept exactly that certificate for that host through `setCertificateVerifyProc`, with no
change to the operating system's certificate store. This is the primary and recommended path.

The operating system's own trust store is the alternative route, and it differs by operating system:

- **Windows.** For a managed fleet, push the CA certificate into `LocalMachine\Root` by Group
  Policy or Intune — silent and machine-wide, with no user interaction. On a single machine without
  fleet management, `certutil -user -addstore Root <ca.crt>` installs the certificate for the
  current user, but it is not a scriptable, unattended step: it raises a modal Windows
  **Security Warning** dialog and waits for a person to click through it before the certificate is
  installed.
- **macOS.** Add the certificate to the keychain and mark it trusted.
- **Linux.** Add the certificate to the NSS database Electron reads:
  `certutil -d sql:$HOME/.pki/nssdb -A` (Electron's network stack does not read `/etc/ssl/certs` on
  Linux).

Whichever route is used, its correctness on each operating system is verified by CI (the
`e2e-electron` matrix), not by this spike, which ran on Windows only.

If neither route is in place — the CA is in no certificate store and no pin is configured — the
desktop client fails closed with no workaround: the main-process navigation emits `did-fail-load`
with code `-202` (`ERR_CERT_AUTHORITY_INVALID`) and the window is left blank. There is no
certificate-warning interstitial and no "proceed anyway" option; the user sees an empty window.
