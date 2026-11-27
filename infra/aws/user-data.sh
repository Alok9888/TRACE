#!/usr/bin/env bash
set -euo pipefail

exec > >(tee /var/log/trace-user-data.log) 2>&1
echo "[user-data] Bootstrapping TRACE EC2 host (Amazon Linux 2023)..."

# 1. Add 1 GB swap so 1 GB t3.micro handles blue/green container overlap comfortably
if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Install Docker, Nginx, and jq (awscli + amazon-ssm-agent ship with AL2023)
dnf update -y -q
dnf install -y -q docker nginx jq

systemctl enable --now docker
systemctl enable --now amazon-ssm-agent

# 3. Store CloudFront origin-verify secret (defense-in-depth alongside SG prefix list)
umask 077
printf '%s' '__ORIGIN_VERIFY_SECRET__' > /etc/trace-origin-verify
chmod 600 /etc/trace-origin-verify
umask 022

# 4. Write minimal nginx.conf without the AL2023 default port-80 server block
cat > /etc/nginx/nginx.conf <<'NGINX_MAIN'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';
    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    include /etc/nginx/conf.d/*.conf;
}
NGINX_MAIN

# 5. Initial blue upstream slot
cat > /etc/nginx/conf.d/00-trace-upstream.conf <<'NGINX_UPSTREAM'
upstream trace_backend {
    server 127.0.0.1:8081;
    keepalive 32;
}
NGINX_UPSTREAM

# 6. TRACE reverse proxy tuned for unbuffered SSE streaming & 20 MB direct uploads
cat > /etc/nginx/conf.d/trace.conf <<'NGINX_SITE'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Reject any direct-to-IP request missing CloudFront's secret origin header
    if ($http_x_origin_verify != "__ORIGIN_VERIFY_SECRET__") {
        return 403;
    }

    # Support direct 20 MB PDF / EPUB / Notebook multipart uploads (bypasses Vercel 4.5 MB cap)
    client_max_body_size 26m;

    location / {
        proxy_pass http://trace_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;

        # Disable buffering so Groq/Gemini SSE tokens flush to browser immediately
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
        add_header X-Accel-Buffering no;

        proxy_connect_timeout 10s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX_SITE

# 7. Install atomic blue/green deploy script
echo '__DEPLOY_SCRIPT_B64__' | base64 -d > /usr/local/bin/deploy-trace.sh
chmod 755 /usr/local/bin/deploy-trace.sh

nginx -t
systemctl enable --now nginx

echo "[user-data] TRACE EC2 bootstrap complete."
