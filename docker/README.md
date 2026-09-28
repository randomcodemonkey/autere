# Autere docker build

Container build for running autere (9router is started and managed by the backend when the provider is 9router) under supervisord. This is the only supported way to run autere.

## Build

NOTE: Build commands are executed from repository root
```bash
docker build -t randomcodemonkey.org/autere -f docker/Dockerfile .
```

## Multi-arch build

Autere image can be built targeting multiple architectures with `docker buildx`, local
buildx build can however only target a single architecture.

```bash
docker buildx build --platform linux/arm64 -t randomcodemonkey.org/autere -f docker/Dockerfile .
```

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/randomcodemonkey.org/autere --push -f docker/Dockerfile .
```

## Run

All configuration is via env variables (docker run / compose), e.g.:

```bash
docker run -d --name autere \
  -p 127.0.0.1:3456:3456 -p 127.0.0.1:20128:20128 \
  -e INITIAL_PASSWORD=secret \
  -v autere-data:/home/autere/.autere \
  -v autere-master-pi-data:/home/autere/.pi \
  -v autere-master-9router-data:/home/autere/.9router \
  randomcodemonkey.org/autere
```

See [Autere README](../README.md) for details on the available ENV variables.

