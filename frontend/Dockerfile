FROM node:20-alpine AS build

WORKDIR /app

# Baked in at build time. Leave it empty to call the API through this image's own
# /api proxy (runtime-configured, works on Render/Railway/Fly without a rebuild).
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

# Rendered into /etc/nginx/conf.d/default.conf by the image entrypoint, so the
# container can adapt to the platform through plain environment variables:
#   PORT=10000 API_UPSTREAM=https://api.example.com
ENV PORT=80 \
    API_UPSTREAM=http://backend:4000 \
    RESOLVER="127.0.0.11 8.8.8.8 1.1.1.1"

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /usr/local/bin/normalize-and-start.sh
RUN chmod +x /usr/local/bin/normalize-and-start.sh \
    && rm -f /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Wrapper normalizes API_UPSTREAM, then runs the stock nginx entrypoint.
ENTRYPOINT ["/usr/local/bin/normalize-and-start.sh"]
CMD ["nginx", "-g", "daemon off;"]
