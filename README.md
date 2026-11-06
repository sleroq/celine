# Celine

Celine is a local Telegram user-account companion that rotates profile photos and emoji statuses. It supports multiple accounts; emoji status rotation requires Telegram Premium.

## Build and run

Get Telegram application credentials from [my.telegram.org](https://my.telegram.org), then set `CELINE_API_ID` and `CELINE_API_HASH` in your build environment:

```sh
(cd web && bun install --frozen-lockfile)
cargo build --release --locked
./target/release/celine
```

Open http://127.0.0.1:7766 and sign in using Telegram's **Settings → Devices → Link desktop device**. A built binary needs no Bun installation to run.

Credentials are embedded **at build time**; setting them when launching the binary has no effect. Builds without valid credentials, including the published releases, cannot log in. The application hash can be extracted from the binary and from Nix store or cache artifacts: do not publish credential-bearing builds unintentionally.

## Data and security

Celine has no web authentication. Anyone with access to the local service can control the connected Telegram accounts. Do not expose or proxy it to an untrusted network.

Data is stored in the platform application-data directory, or in `CELINE_DATA_DIR` if set. It includes Telegram session keys: treat them like passwords and back up the directory only to trusted storage. Logging out does not delete the local account directory or Telegram photo history. To erase local copies, stop Celine and remove its data directory.

## Development

Use `nix develop` on Linux or macOS, or install the pinned Rust toolchain and Bun. Install frontend dependencies before running Cargo; the Rust build embeds the frontend.

```sh
(cd web && bun install --frozen-lockfile)
cargo run --locked
# Optional frontend dev server, with /api proxied to Celine:
(cd web && bun run dev)
```

Checks:

```sh
(cd web && bun run lint && bun run format:check && bun run build && bun test)
cargo fmt --all -- --check
cargo test --workspace --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
```

`nix build .#celine` builds the package without Telegram credentials. Credentials may be supplied with the package's `apiId` and `apiHash` overrides, subject to the Nix store warning above.
