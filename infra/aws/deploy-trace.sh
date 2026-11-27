#!/usr/bin/env bash
set -euo pipefail

IMAGE_URI="${1:-}"
if [[ -z "${IMAGE_URI}" ]]; then
  echo "Usage: deploy-trace.sh <ecr-image-uri>" >&2
  exit 1
fi

# Detect AWS region via IMDSv2 (fallback to ap-south-1)
IMDS_TOKEN="$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)"
REGION="${AWS_REGION:-$(curl -fsS -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" "http://169.254.169.254/latest/meta-data/placement/region" || echo "ap-southeast-2")}"
SSM_PREFIX="${SSM_PREFIX:-/trace/prod}"
LOG_GROUP="${LOG_GROUP:-/trace/backend-go}"
UPSTREAM_FILE="/etc/nginx/conf.d/00-trace-upstream.conf"
ENV_FILE="/run/trace-deploy.env"

cleanup() {
  rm -f "${ENV_FILE}"
}
trap cleanup EXIT

echo "[deploy] Region=${REGION} Image=${IMAGE_URI}"

# 1. Authenticate Docker to ECR using the EC2 Instance Role (zero static credentials)
REGISTRY="${IMAGE_URI%%/*}"
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${REGISTRY}"

# 2. Pull immutable image
echo "[deploy] Pulling ${IMAGE_URI}..."
docker pull "${IMAGE_URI}"

# 3. Fetch runtime config & KMS-encrypted secrets from SSM Parameter Store into tmpfs (/run)
echo "[deploy] Loading parameters from SSM ${SSM_PREFIX}..."
umask 077
: > "${ENV_FILE}"

NEXT_TOKEN=""
while :; do
  if [[ -n "${NEXT_TOKEN}" ]]; then
    RESP="$(aws ssm get-parameters-by-path --region "${REGION}" --path "${SSM_PREFIX}" --recursive --with-decryption --next-token "${NEXT_TOKEN}" --output json)"
  else
    RESP="$(aws ssm get-parameters-by-path --region "${REGION}" --path "${SSM_PREFIX}" --recursive --with-decryption --output json)"
  fi

  echo "${RESP}" | jq -r '.Parameters[] | "\(.Name | split("/") | last)=\(.Value)"' >> "${ENV_FILE}"
  NEXT_TOKEN="$(echo "${RESP}" | jq -r '.NextToken // empty')"
  [[ -z "${NEXT_TOKEN}" ]] && break
done

if [[ ! -s "${ENV_FILE}" ]]; then
  echo "[deploy] ERROR: No parameters found under ${SSM_PREFIX}" >&2
  exit 1
fi

# 4. Determine active vs target blue/green slot
CURRENT_PORT="8081"
if [[ -f "${UPSTREAM_FILE}" ]] && grep -q "127.0.0.1:8082" "${UPSTREAM_FILE}"; then
  CURRENT_PORT="8082"
fi

if [[ "${CURRENT_PORT}" == "8081" ]]; then
  TARGET_SLOT="green"
  TARGET_PORT="8082"
  OLD_SLOT="blue"
else
  TARGET_SLOT="blue"
  TARGET_PORT="8081"
  OLD_SLOT="green"
fi

TARGET_NAME="trace-${TARGET_SLOT}"
OLD_NAME="trace-${OLD_SLOT}"

echo "[deploy] Blue/Green swap: current=${OLD_NAME}:${CURRENT_PORT} -> candidate=${TARGET_NAME}:${TARGET_PORT}"

# 5. Launch candidate container bound strictly to loopback (127.0.0.1)
docker rm -f "${TARGET_NAME}" >/dev/null 2>&1 || true

docker run -d \
  --name "${TARGET_NAME}" \
  --restart unless-stopped \
  --env-file "${ENV_FILE}" \
  -e PORT=8080 \
  -p "127.0.0.1:${TARGET_PORT}:8080" \
  --memory 420m \
  --memory-swap 640m \
  --log-driver=awslogs \
  --log-opt "awslogs-region=${REGION}" \
  --log-opt "awslogs-group=${LOG_GROUP}" \
  --log-opt "awslogs-stream=${TARGET_NAME}" \
  --log-opt "awslogs-create-group=false" \
  "${IMAGE_URI}"

# Wipe env file immediately after Docker reads it
rm -f "${ENV_FILE}"

# 6. Health check candidate before routing any traffic
echo "[deploy] Waiting for http://127.0.0.1:${TARGET_PORT}/health..."
HEALTHY=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${TARGET_PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "${TARGET_NAME}"; then
    echo "[deploy] ERROR: Candidate container ${TARGET_NAME} exited prematurely!" >&2
    docker inspect --format '{{.State.ExitCode}} {{.State.Error}}' "${TARGET_NAME}" || true
    docker rm -f "${TARGET_NAME}" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 1
done

if [[ "${HEALTHY}" -ne 1 ]]; then
  echo "[deploy] ERROR: Candidate ${TARGET_NAME} failed /health after 30s; aborting swap (live slot untouched)." >&2
  docker rm -f "${TARGET_NAME}" >/dev/null 2>&1 || true
  exit 1
fi

echo "[deploy] Candidate ${TARGET_NAME} is healthy. Atomically flipping Nginx upstream..."

# 7. Atomically swap Nginx upstream and reload (zero dropped connections)
TMP_UPSTREAM="$(mktemp /etc/nginx/conf.d/.upstream.XXXXXX)"
cat > "${TMP_UPSTREAM}" <<EOF
upstream trace_backend {
    server 127.0.0.1:${TARGET_PORT};
    keepalive 32;
}
EOF
mv -f "${TMP_UPSTREAM}" "${UPSTREAM_FILE}"

nginx -t
nginx -s reload

# Verify through Nginx using the origin-verify secret
if [[ -f /etc/trace-origin-verify ]]; then
  ORIGIN_SECRET="$(cat /etc/trace-origin-verify)"
  curl -fsS --max-time 3 -H "X-Origin-Verify: ${ORIGIN_SECRET}" "http://127.0.0.1/health" >/dev/null
fi

# 8. Gracefully drain old container (SIGTERM gives Go's 10s Shutdown time to finish active SSE streams)
if docker ps -a --format '{{.Names}}' | grep -qx "${OLD_NAME}"; then
  echo "[deploy] Gracefully draining ${OLD_NAME} (SIGTERM, 15s timeout)..."
  docker stop -t 15 "${OLD_NAME}" >/dev/null 2>&1 || true
  docker rm -f "${OLD_NAME}" >/dev/null 2>&1 || true
fi

# 9. Keep EBS root volume lean by pruning old unused images
docker image prune -af --filter "until=24h" >/dev/null 2>&1 || true

echo "[deploy] SUCCESS: ${TARGET_NAME} (${IMAGE_URI}) is now serving live traffic on 127.0.0.1:${TARGET_PORT}."
