# syntax=docker/dockerfile:1
# Build artifacts only. This image does not run a GUI or an HTTP server.
FROM node:24-bookworm-slim AS node

# Build on the oldest Ubuntu baseline we intend to support.
FROM ubuntu:22.04 AS builder
ARG DEBIAN_FRONTEND=noninteractive
ARG RUST_TOOLCHAIN=stable
ARG TARGETARCH
ENV CARGO_HOME=/opt/rust/cargo \
    RUSTUP_HOME=/opt/rust/rustup \
    PATH=/opt/rust/cargo/bin:/usr/local/bin:$PATH \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    CI=true
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl wget file pkg-config \
    libgtk-3-dev libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf \
    xz-utils unzip squashfs-tools \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
RUN curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain "$RUST_TOOLCHAIN" \
    && rm /tmp/rustup-init.sh

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,id=neuron-map-registry,target=/opt/rust/cargo/registry \
    --mount=type=cache,id=neuron-map-target-${TARGETARCH},target=/app/src-tauri/target,sharing=locked \
    rm -rf src-tauri/target/release/bundle \
    && npm run build:linux \
    && mkdir -p /out \
    && cp src-tauri/target/release/bundle/deb/*.deb /out/ \
    && cp src-tauri/target/release/bundle/appimage/*.AppImage /out/ \
    && cd /out && sha256sum -- *.deb *.AppImage > SHA256SUMS

FROM scratch AS artifacts
COPY --from=builder /out/ /
