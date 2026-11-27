---
id: S-109
title: Authentication — sign in through a configured identity provider
persona: team-member
area: security
priority: P2
status: active
release: false
modes: [secured]
surfaces: [studio, api]
---

## Goal

A secured deployment with an administrator-configured redirect identity provider can authenticate an existing tenant user through that provider.

## Prerequisites

- [ ] Secured gateway configured with both `email-password` and an OIDC redirect provider; use shared OAuth state storage when running multiple gateway workers.
- [ ] Provider identity maps to an existing user in the tenant; no self-registration is enabled by this flow.

## Steps

| # | Action | Expected |
|---|---|---|
| S-109.1 | Request `GET <gateway-url>/auth/providers`, then open Studio `/login` | HTTP 200 JSON lists `email-password` with kind `password` and the configured OIDC provider with kind `redirect`; Studio shows a “Continue with <provider-id>” link to `/auth/oauth/<provider-id>/start`. |
| S-109.2 | Open `GET <gateway-url>/auth/oauth/<provider-id>/start?returnTo=/dashboard` | Gateway redirects to the configured identity provider and sets an OAuth state cookie. |
| S-109.3 | Complete provider authentication and return through `/auth/oauth/<provider-id>/callback` | Gateway establishes the user session and redirects to `/dashboard`; `GET /auth/me` returns the existing user's email and tenant ID. |
| S-109.4 | Start a provider flow, then return with a missing, altered, or replayed state | Gateway redirects to `/login?error` without establishing an authenticated session. |
