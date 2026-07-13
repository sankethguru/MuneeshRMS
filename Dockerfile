FROM node:20-alpine

WORKDIR /app

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
EXPOSE 2299

VOLUME ["/app/data"]

CMD ["node", "server.js"]
