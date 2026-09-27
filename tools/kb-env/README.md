# kb-env

Provision an **installed** KB Labs platform (user-mode, via `kb-create` + a local
Verdaccio) from a declarative profile, leave it live, and work inside it. Unlike
the per-domain e2e suites (which run against `workspace:*` sources), kb-env
exercises the **real installed packages** — the same thing a user gets.

## Commands

```
kb-env up <profile> [--fresh]   provision + start an environment, leave it live
kb-env shell                    open a shell inside it (clean PATH — installed kb, not pnpm kb)
kb-env exec -- <cmd>            run a command inside it
kb-env config <profile>         hot-swap the config overlay (no reinstall)
kb-env status                   show the live environment's services
kb-env profiles                 list profiles
kb-env down [--rm]              stop (and with --rm remove) the environment
```

Profiles live in `e2e/testbed/testbed.yaml` (repo) or the embedded defaults:
`plugins` (what to install), `services` (what to run), `config` (overlay).

## Isolation & parallel environments

Each environment installs into an external dir (`KB_ENV_HOME`, default
`~/.kb-env`), with an isolated `KB_HOME` and a clean PATH, so it
never picks up the workspace `node_modules` or the `pnpm kb` alias.

Ports shift through one knob, **`KB_ENV_OFFSET`** (additive). It flows to the
whole virtual network via the transport adapter (`KB_NET_OFFSET`): service
binds, gateway routing, and kb-dev health probes all use the shifted ports.
Socket services isolate by `KB_SOCKET_HASH` (per project dir). So an environment
coexists with a running dev stack, and two environments run in parallel:

```
# env A — default ports, default home
kb-env up mind

# env B — shifted ports + its own home, in parallel
KB_ENV_HOME=~/.kb-env-b KB_ENV_OFFSET=1000 kb-env up mind
#   gateway A :4000, gateway B :5000; rest A :5050, rest B :6050; no collisions
```

`KB_ENV_OFFSET` is a **local** mechanism (many environments on one host). In
cloud/k8s it stays 0 — isolation there comes from namespace/DNS, and the
transport map carries real addresses.

## Modes

`up` installs from a local Verdaccio populated with the current workspace build
(`pack-all` → publish), so you test your unreleased changes as a user would.
