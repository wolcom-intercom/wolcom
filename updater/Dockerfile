FROM node:22-alpine
RUN apk add --no-cache bash curl git docker-cli docker-cli-compose tar gzip coreutils openssh-client
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.mjs ./
EXPOSE 8096
CMD ["node","server.mjs"]
