FROM oven/bun:1.4.4 AS bun

FROM rust:1.100.0-bookworm AS builder
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile
COPY Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
COPY src ./src
COPY web ./web
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home celine \
    && mkdir -m 700 /data \
    && chown celine:celine /data
ENV CELINE_DATA_DIR=/data
COPY --from=builder /app/target/release/celine /usr/local/bin/celine
USER 10001
STOPSIGNAL SIGINT
ENTRYPOINT ["celine"]
