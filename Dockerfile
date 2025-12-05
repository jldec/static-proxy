FROM ubuntu:24.04

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun && \
    mkdir -p /opt/bun

COPY bun-server.js /opt/bun/bun-server.js

# Expose Bun server port
EXPOSE 3000

# Change this for force a new image
ENV IMAGE_VERSION=0.0.3

WORKDIR /opt/bun

ENTRYPOINT ["bun", "bun-server.js"]
