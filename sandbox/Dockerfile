# Sandbox image for running generated code: the toolchains the language packs check with.
# Built locally with `scripts/sandbox-vm.sh`. Containers run with --network none.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build clang clang-tidy cppcheck gdb \
        python3 python3-pip python3-venv python3-pytest \
        shellcheck bats make git ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Python linters at pinned versions (matched by the python language pack).
RUN pip3 install --no-cache-dir --break-system-packages ruff==0.14.* mypy==1.18.* cmakelang==0.6.13

# Node.js 22 from the official tarball.
ARG NODE_VERSION=22.20.0
RUN arch="$(dpkg --print-architecture)"; case "$arch" in amd64) a=x64;; arm64) a=arm64;; *) exit 1;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${a}.tar.xz" | tar -xJ -C /usr/local --strip-components=1

WORKDIR /work
CMD ["bash"]
