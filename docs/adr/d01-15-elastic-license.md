# D01-15: Elastic License 2.0

Status: accepted 2026-09-19. This settles the licence the M0 exit record carried as an open owner
decision, and with it the `info.license` of the generated OpenAPI document.

Iridium is source-available, not open source. The `LICENSE` file is the Elastic License 2.0 verbatim;
`package.json` and `packages/contracts/openapi/openapi.json` carry the SPDX identifier `Elastic-2.0`.

The product is intended to be free for the people who run it for themselves. A person running a
personal instance on a private server, and a company running Iridium for its own staff and teams,
are both unrestricted, and neither is affected by the address the instance answers on: serving your
own organisation over a public URL is ordinary self-hosting, not a hosted service. What the licence
bars is providing Iridium to third parties as a hosted or managed service that gives those users a
substantial set of its features — the licence draws no distinction between doing that for revenue
and doing it for free, so a free public instance offered to strangers is barred on the same terms as
a commercial one.

The Elastic License was chosen over the two alternatives that carry the same bar because its bar
does not expire. BSL 1.1 and the FSL both convert each release to Apache-2.0 on a change date, four
and two years out respectively, which hands a competing hosted offering a dated key rather than
refusing it. AGPL-3.0 was rejected outright: it is genuine open source and would satisfy a wish to
publish the source, but it permits competing hosting and only obliges the competitor to publish
their modifications, which is not the restriction this project wants.

The cost of the choice is stated rather than hidden. `Elastic-2.0` is not an OSI-approved licence,
so Iridium may not be described as open source, some distributions and corporate policies refuse
source-available dependencies, and contributors who filter for OSI licences will pass it over. That
is accepted: the hosting bar is worth more to this project than the label.

This decision governs Iridium's own source only. The licences of its dependencies are a separate
policy and remain governed by D10-12 and D10-15, whose scan and exception list are unchanged; the
exception list is empty and no dependency constrains this choice.
