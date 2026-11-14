# Railway finds this file in the repository root and builds the service from it.
#
# The gateway uses only Node's standard library, so there is nothing to install:
# the image is Node plus the source files.

# The tests pass on Node 22, 24 and 26. To move to another of them, change the
# number here.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

# Run as the unprivileged user that the official Node image provides.
USER node

# No EXPOSE line on purpose: the gateway listens on the port given in the PORT
# variable, which Railway sets, and falls back to 8080 without it.

# Start node directly (no npm, no shell) so that Railway's stop signal reaches
# the gateway and it can finish in-flight requests before exiting.
CMD ["node", "src/server.js"]
