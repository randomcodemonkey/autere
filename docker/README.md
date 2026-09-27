# Autere docker build

Container build for running autere + 9router under supervisord.

## Build

```bash
cd docker
docker build -t autere-image ..
```

## Multi-arch build

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/autere-image --push ..
```

Note: `openjdk-21-jdk-headless`, `golang`, and other apt packages are available on both amd64 and arm64 for ubuntu:resolute, so the same Dockerfile works. The arm64 build runs native emulation (qemu) for the `npm ci && npm run build` step unless you have arm64 runners — expect the node/emulation steps to be slow.

## Run

Env variables are provided by the caller (docker run / compose), e.g.:

```bash
docker run -d --name autere \
  -p 3456:3456 -p 8080:8080 \
  -e INITIAL_PASSWORD=secret -e SERVER_NAME=mybox \
  -v autere-data:/home/autere/.autere \
  autere-image
```

- Backend serves the built frontend on **3456**.
- Bump `NPM_CACHE_COUNTER` in the Dockerfile to force global npm reinstalls (e.g. to force install new pi version).
- Entrypoint installs pi extensions, copies the autere skill from the repo root, and seeds the Autere persona
