# SupaNet signup site — static single page (index.html), served on $PORT.
# On Railway: set RAILWAY_DOCKERFILE_PATH=control-plane/ui/Dockerfile.

FROM node:22-alpine

RUN npm install -g serve@14

WORKDIR /app
COPY control-plane/ui/ .

CMD ["sh", "-c", "serve -s . -l ${PORT:-3000}"]
