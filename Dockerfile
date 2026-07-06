# West EPCM Technologies — backend container for Google Cloud Run
# Cloud Run injects PORT (default 8080); server.js already reads process.env.PORT.
FROM node:20-slim

WORKDIR /usr/src/app
ENV NODE_ENV=production

# Install production dependencies first (better layer caching).
# No package-lock.json in the repo, so use npm install (not npm ci).
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the application.
COPY . .

# Cloud Run listens on $PORT (8080). Documented for clarity.
EXPOSE 8080

CMD ["node", "server.js"]
