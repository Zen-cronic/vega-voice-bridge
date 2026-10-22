# The hub alone, in a small image. No cloud specifics: run it on a laptop, a LAN box or any container host.
#   docker build -t vega-voice-bridge-hub .
#   docker run --rm -p 8790:8790 vega-voice-bridge-hub --public-url http://<this machine's LAN IP>:8790 --echo
# Arguments after the image name go to vega-voice-bridge-hub (see --help).
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.build.json README.md PROTOCOL.md CHANGELOG.md LICENSE ./
COPY src ./src
COPY types ./types
COPY examples/minimal-phone/phone.html ./examples/minimal-phone/
RUN npm run build && npm pack --ignore-scripts --pack-destination /tmp

FROM node:22-alpine
WORKDIR /app
COPY --from=build /tmp/vega-voice-bridge-*.tgz /tmp/
RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund /tmp/vega-voice-bridge-*.tgz ws@8 \
  && rm /tmp/vega-voice-bridge-*.tgz
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
ENTRYPOINT ["node", "node_modules/vega-voice-bridge/dist/cli.js", "--port", "8790"]
