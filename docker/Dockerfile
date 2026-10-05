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
# ubuntu:resolute ships ca-certificates without a usable trust bundle
# (postinst trigger bug) — reinstall before ANY TLS fetch.
RUN apt-get -y update \
    && apt-get install -y --reinstall ca-certificates \
    && apt-get -y upgrade \
    && apt-get install -y --no-install-recommends \
      autoconf \
      automake \
      apt-transport-https \
      build-essential \
      curl \
      emacs \
      fd-find \
      git \
      gnupg \
      golang \
      iputils-ping \
      jq \
      less \
      maven \
      nodejs \
      netcat-openbsd \
      npm \
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
    && apt-get -y update \
    && apt-get install -y --no-install-recommends \
      docker-ce-cli \
      sbt \
    && apt-get -y clean \
    && rm -rf /var/lib/apt/lists/*

# increment the counter if you want to force npm reinstalls, e.g. new versions
ENV NPM_CACHE_COUNTER=0002

RUN npm install -g cypress --ignore-scripts \
    && npm install -g 9router --ignore-scripts \
    && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.2 \
    && npm install -g @tobilu/qmd \
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

WORKDIR /home/autere/dist
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /tmp/*

USER autere
WORKDIR /home/autere

ENTRYPOINT ["/entrypoint.sh"]
