# Builds a single static binary (frontend embedded) and runs it on an empty image.
# Alpine's Rust targets musl and links statically by default.

FROM rust:1.99-alpine AS chef
# musl-dev: C toolchain bits for crates that compile C code (e.g. bundled SQLite).
RUN apk add --no-cache musl-dev
RUN cargo install cargo-chef --locked --version 0.1.78
WORKDIR /app

# Compute a dependency-only "recipe" so dependency builds are cached
# until Cargo.toml / Cargo.lock change.
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin solenna
# Empty data dir to copy into the final image with the right owner.
RUN mkdir /data

FROM scratch
COPY --from=builder /app/target/release/solenna /solenna
COPY --from=builder --chown=10001:10001 /data /data
USER 10001:10001
ENV SOLENNA_PORT=8080 \
    SOLENNA_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["/solenna"]
