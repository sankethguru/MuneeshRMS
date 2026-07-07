FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=2299
EXPOSE 2299

VOLUME ["/app/data"]

CMD ["node", "server.js"]
