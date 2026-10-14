# GigShield backend + frontend (single container)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY backend ./backend
COPY frontend ./frontend
ENV PORT=4000 DATA_DIR=/app/data
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "backend/server.js"]
