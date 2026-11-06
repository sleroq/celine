# Celine

Celine is a planned Telegram profile companion. This repository currently contains
only build scaffolding; the application has not been implemented yet.

## Development

Rust is pinned to 1.99.1 in `rust-toolchain.toml`. On Linux and macOS,
`nix develop` provides that toolchain and Bun. To build the current scaffold:

```sh
cargo test --locked
nix build .#celine
```

The Nix flake provides packages for Linux and macOS on x64 and ARM64. The CI
matrix also covers Windows on x64 and ARM64 using Cargo.

## Binary cache

The cache workflow builds the x86-64 Linux Nix closure and pushes it to the
`celine` Attic cache at `https://cache.cum.army/` on main, tags, and manual
runs. The Attic cache and an appropriately scoped GitHub Actions `ATTIC_TOKEN`
secret must be provisioned before this workflow can push. No cache or token is
created by this repository.

The Telegram API ID and hash have not been supplied. Do not commit credentials or
session data. A credential embedded in a distributed binary is extractable, and
Nix store paths and cache contents must also be treated as readable.
