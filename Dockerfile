# vitals — a small Node service. One dependency (mysql2) and nothing else: no
# framework, no build step, no bundler.
#
# node:24 is a floor, not a preference — several language features this uses landed
# there, and the base should not be dropped without checking.
FROM node:24-alpine

WORKDIR /app

# Dependencies first so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

# The suite runs at build time. It covers the failures that are invisible at runtime:
# a wrong filter field is a 400 you only see in a log, a missed window-chunk silently
# truncates history, and a webhook endpoint that answers 200 to an unauthenticated
# probe fails subscriber registration with no clue as to why.
#
# There is no database in a build, so the storage tests SKIP themselves loudly and
# the ~24 pure tests still gate the image. Do not "fix" that by pointing the build at
# a real MySQL: a build that writes to the fleet's database is a build that can
# corrupt production data.
COPY test ./test
RUN node test/run.js

# Fail the build on a root-absolute URL in public/. A DEPLOY-ONLY class of bug: the
# app is served at / locally but under a path prefix in the fleet, and the balancer
# strips that prefix, so "/style.css" works on a laptop and 404s against the ingress.
COPY scripts ./scripts
RUN node scripts/check-paths.js

# Bind all interfaces inside the container. The app defaults to 127.0.0.1 because run
# locally it is unauthenticated; in the fleet the login gate at the balancer is what
# protects it. This app holds health data — do not mark it `public: true`.
ENV HOST=0.0.0.0 \
    PORT=4330

# NO VOLUME. State lives in the fleet's MySQL, which is the whole reason this app can
# run at more than one replica: a local file would give each replica its own private
# copy of your health history and a dashboard that answered differently per request.
EXPOSE 4330

CMD ["node", "server.js"]
