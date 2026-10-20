# syntax=docker/dockerfile:1

# ---- frontend build stage ----
FROM node:24-alpine AS build
WORKDIR /app
ADD package.json package-lock.json /app/
ADD tsconfig.* /app/
ADD src /app/src/
# vite publicDir points at the repo root (favicon/logo/sw assets)
ADD public /app/public/
RUN npm ci --no-audit --no-fund && npm run build

# ---- runtime image ----
FROM ubuntu:resolute

USER root
ENV DEBIAN_FRONTEND=noninteractive
# ubuntu:resolute ships ca-certificates without a usable trust bundle
# (postinst trigger bug) — reinstall before ANY TLS fetch.
RUN apt-get -y -qq update \
    && apt-get install -y -qq --reinstall ca-certificates \
    && apt-get -y -qq upgrade \
    && apt-get install -y -qq --no-install-recommends \
      autoconf \
      automake \
      apt-transport-https \
      build-essential \
      curl \
      emacs-nox \
      fd-find \
      git \
      gnupg \
      golang \
      iputils-ping \
      jq \
      less \
      maven \
      netcat-openbsd \
      openjdk-21-jdk-headless \
      openssh-client \
      python3 \
      ripgrep \
      rsync \
      supervisor \
      xvfb \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x2EE0EA64E40A89B84B2DF73499E82A75642AC823" -o /etc/apt/keyrings/sbt.asc \
    && chmod a+r /etc/apt/keyrings/*.asc \
    && printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources \
     && printf 'Types: deb\nURIs: https://repo.scala-sbt.org/scalasbt/debian\nSuites: all\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/sbt.asc\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/sbt.sources \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && printf 'Types: deb\nURIs: https://deb.nodesource.com/node_26.x\nSuites: nodistro\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/nodesource.gpg\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/nodesource.sources \
    && apt-get -y -qq update \
    && apt-get install -y -qq --no-install-recommends \
      docker-ce-cli \
      nodejs \
      sbt \
    && rm -rf /usr/lib/jvm/*/jmods \
    && apt-get -y clean \
    && rm -rf /var/lib/apt/lists/*

# increment the counter if you want to force npm reinstalls, e.g. new versions
ENV NPM_CACHE_COUNTER=0002

RUN npm install -g cypress --ignore-scripts \
    && npm install -g 9router --ignore-scripts \
    && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4 \
    && npm install -g @tobilu/qmd \
    # qmd ships llama.cpp prebuilds for every arch and GPU backend; keep only
    # this arch's CPU build (deployments pass no GPU devices)
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in amd64) llama=x64 ;; arm64) llama=arm64 ;; *) llama="" ;; esac \
    && for d in /usr/lib/node_modules/@tobilu/qmd/node_modules/@node-llama-cpp/*/; do \
         n="$(basename "$d")"; \
         case "$n" in *-cuda|*-cuda-ext|*-vulkan) rm -rf "$d" ;; "linux-$llama") ;; *) [ -z "$llama" ] || rm -rf "$d" ;; esac; \
       done \
    && npm cache clean --force

# autere backend runs from source via tsx (runtime dependency, installed with the app)
RUN useradd -m -d /home/autere -s /bin/bash -G tty autere \
    && mkdir -p /home/autere/log /home/autere/code /home/autere/.autere /home/autere/.pi /home/autere/.cache /home/autere/.config /home/autere/.ivy /home/autere/.m2 /home/autere/.npm \
    && chown -R autere:autere /home/autere

COPY --chown=autere:autere docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --chown=autere:autere docker/entrypoint.sh /entrypoint.sh
COPY --chown=autere:autere SKILL.md /home/autere/SKILL.md

# autere app: prebuilt frontend (dist/) + compiled backend (dist-backend/)
# + runtime-only node_modules. No source in the image.
COPY --chown=autere:autere --from=build /app/dist /home/autere/dist
COPY --chown=autere:autere --from=build /app/dist-backend /home/autere/dist-backend
COPY --chown=autere:autere package.json package-lock.json /home/autere/dist/
# Bundled custom pi extensions (loaded via entrypoint symlinks).
COPY --chown=autere:autere extras /home/autere/pi-ext-extra/
# Extensions carry their own package.json (node_modules are dockerignored),
# so install their deps here; sandbox env copies include them.
RUN set -e; cd /home/autere/pi-ext-extra; for d in */; do \
      if [ -f "$d/package-lock.json" ]; then (cd "$d" && npm ci --omit=dev --no-audit --no-fund); fi; \
    done; rm -rf /root/.npm

WORKDIR /home/autere/dist
# The compiled backend resolves bare imports starting at /home/autere/dist-backend
# (chain: dist-backend/node_modules → ~/node_modules → …); the install below
# lands in /home/autere/dist/node_modules, which is NOT in that chain. Link it,
# or any runtime dependency (web-push) crashes the backend at startup.
RUN npm ci --omit=dev --no-audit --no-fund \
    && ln -s /home/autere/dist/node_modules /home/autere/node_modules \
    && npm cache clean --force \
    && rm -rf /tmp/*

USER autere
WORKDIR /home/autere

# Preinstall pi npm extensions as the autere user so entrypoint.sh never
# installs at container start (rerunning it would fetch fresh versions).
# Enabled/disabled per deployment in entrypoint.sh by filtering settings.json
# "packages". Bump NPM_CACHE_COUNTER when updating versions.
RUN set -e; for pkg in pi-9router-ext pi-web-search pi-memory copilot-credit-usage; do pi install "npm:$pkg"; done \
    && npm cache clean --force

ENTRYPOINT ["/entrypoint.sh"]
