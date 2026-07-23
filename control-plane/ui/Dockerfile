# SupaNet signup site — static single page (index.html), served on $PORT.
# On Railway: set RAILWAY_DOCKERFILE_PATH=control-plane/ui/Dockerfile.

FROM node:22-alpine

RUN npm install -g serve@14

WORKDIR /app
COPY control-plane/ui/ .

# `serve` is installed globally above; package.json's start script uses it, so
# both the image CMD and a platform-imposed `npm start` land in the same place.
CMD ["npm", "start"]
