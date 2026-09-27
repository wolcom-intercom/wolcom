FROM node:22-alpine
RUN apk add --no-cache postgresql-client tar gzip
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs backuphub.mjs backuphub-github-metadata.mjs ./
COPY public ./public
COPY cloud ./cloud
EXPOSE 3000
CMD ["node", "server.mjs"]
