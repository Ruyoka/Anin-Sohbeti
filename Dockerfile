FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
RUN if [ "$NODE_ENV" = "production" ]; then npm ci --only=production; else npm ci; fi
COPY . .
EXPOSE 6000
CMD ["npm", "run", "start"]
