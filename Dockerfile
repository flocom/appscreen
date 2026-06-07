# App Store Screenshot Generator
# Lightweight nginx container serving static files

FROM nginx:alpine

LABEL maintainer="App Store Screenshot Generator"
LABEL description="Browser-based tool for creating App Store marketing screenshots"

# Remove default nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Copy application files. Globs so every root HTML/CSS/JS module is included
# automatically — avoids shipping an image that 404s a newly-added script
# (e.g. appstore-features.js, updater.js, color-input.js, panel-resize.js).
COPY *.html /usr/share/nginx/html/
COPY *.css /usr/share/nginx/html/
COPY *.js /usr/share/nginx/html/

# Copy assets
COPY models/ /usr/share/nginx/html/models/
COPY img/ /usr/share/nginx/html/img/

# Copy custom nginx configuration for SPA and caching
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
