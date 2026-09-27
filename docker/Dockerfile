# syntax=docker/dockerfile:1

# ---- frontend build stage ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/frontend/package.json src/frontend/
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# ---- runtime image ----
FROM ubuntu:resolute

USER root
RUN apt-get -y update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      curl \
      python3 \
      golang \
      openjdk-21-jdk-headless \
      emacs \
      maven \
      nodejs \
      npm \
      git \
      supervisor \
      jq \
      openssh-client \
      ripgrep \
      xvfb \
      iputils-ping \
      netcat-openbsd \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
RUN apt-get -y update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get -y clean \
    && rm -rf /var/lib/apt/lists/*

# increment the counter if you want to force npm reinstalls, e.g. new versions
ENV NPM_CACHE_COUNTER=0001

RUN npm install -g cypress --ignore-scripts
RUN npm install -g 9router --ignore-scripts \
    && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4 \
    && npm cache clean --force

# autere backend runs from source via tsx (runtime dependency, installed with the app)
RUN useradd -m -d /home/autere -s /bin/bash -G tty autere \
    && mkdir -p /home/autere/log /home/autere/code \
    && chown -R autere:autere /home/autere

COPY --chown=autere:autere supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --chown=autere:autere entrypoint.sh /entrypoint.sh
COPY --chown=autere:autere SKILL.md /tmp

# autere app: prebuilt frontend + source + runtime-only node_modules
COPY --chown=autere:autere --from=build /app/dist /home/autere/code/autere/dist
COPY --chown=autere:autere package.json package-lock.json /home/autere/code/autere/
COPY --chown=autere:autere src /home/autere/code/autere/src/
WORKDIR /home/autere/code/autere
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /tmp/*

USER autere
WORKDIR /home/autere

ENTRYPOINT ["/entrypoint.sh"]
