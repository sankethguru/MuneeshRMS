FROM node:20-alpine

WORKDIR /app

# Chromium (via Alpine's own apk package, not puppeteer's bundled
# download — that download targets glibc and fails outright on Alpine's
# musl libc) + the libraries it needs to actually render, for bill/
# invoice PDF generation. Not setting PUPPETEER_EXECUTABLE_PATH here
# deliberately — the exact binary name/path from apk's chromium package
# can vary, and this hasn't been verified against a real container build
# (no Docker available in the environment this was built in). billPdf.js
# checks several known candidate paths itself and picks whichever
# actually exists, which is more robust than hardcoding one guess here.
# If PDF generation fails with "no Chromium executable found" after
# deploying, run `which chromium chromium-browser google-chrome` inside
# the container and set PUPPETEER_EXECUTABLE_PATH explicitly to whatever
# that reports.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ttf-freefont

# package-lock.json* (the trailing *) means "copy it if present, don't
# fail the build if it isn't" — a plain COPY of a file that doesn't
# exist fails the whole build outright, which is worse than just losing
# the reproducible-install guarantee for this one run. Below, npm ci
# (strict, reproducible, requires a real lockfile) is used when one
# exists; npm install (looser, but always works) is the fallback.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

ENV PORT=2299
ENV NODE_ENV=production
EXPOSE 2299

VOLUME ["/app/data"]

CMD ["node", "server.js"]
