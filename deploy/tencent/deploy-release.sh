#!/usr/bin/env bash
set -Eeuo pipefail

commit_sha="${1:-}"
archive_path="${2:-}"
release_root="/opt/gulong/releases"
current_link="/opt/gulong/current"
service_name="gulong"
local_health_url="http://127.0.0.1:8787/api/health"

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid immutable commit SHA." >&2
  exit 2
fi

expected_archive="/tmp/gulong-release-${commit_sha}.tar.gz"
if [[ "$archive_path" != "$expected_archive" || ! -f "$archive_path" ]]; then
  echo "Release archive is missing or outside the approved path." >&2
  exit 2
fi

install -d -m 0755 "$release_root"
target="$release_root/$commit_sha"
previous="$(readlink -f "$current_link" 2>/dev/null || true)"
stage=""
activated=0

if [[ -n "$previous" && "$previous" != "$release_root"/* ]]; then
  echo "Current release points outside the approved release root." >&2
  exit 2
fi

cleanup() {
  local exit_code=$?
  rm -f "$archive_path" "/tmp/deploy-release.sh"
  if [[ -n "$stage" && -d "$stage" ]]; then
    rm -rf -- "$stage"
  fi
  return "$exit_code"
}
trap cleanup EXIT

health_check() {
  local attempt
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 5 "$local_health_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  if [[ "$activated" -ne 1 || -z "$previous" || ! -d "$previous" ]]; then
    return 0
  fi

  local rollback_link="/opt/gulong/.current-rollback-${commit_sha}"
  ln -s "$previous" "$rollback_link"
  mv -Tf "$rollback_link" "$current_link"
  systemctl restart "$service_name"
  health_check
}

if [[ -d "$target" ]]; then
  if [[ ! -f "$target/.deploy-commit" ]] || [[ "$(tr -d '\r\n' < "$target/.deploy-commit")" != "$commit_sha" ]]; then
    echo "Existing target does not contain the expected commit marker." >&2
    exit 3
  fi
else
  stage="$(mktemp -d "$release_root/.staging-${commit_sha}.XXXXXX")"
  tar -xzf "$archive_path" -C "$stage"

  if [[ ! -f "$stage/package-lock.json" || ! -f "$stage/dist/client/index.html" || ! -f "$stage/server/local.js" ]]; then
    echo "Release artifact is incomplete." >&2
    exit 3
  fi

  if [[ -n "$previous" && -d "$previous/node_modules" && -f "$previous/package-lock.json" ]] \
    && cmp -s "$previous/package-lock.json" "$stage/package-lock.json"; then
    cp -al "$previous/node_modules" "$stage/node_modules"
  else
    chown -R gulong:gulong "$stage"
    runuser -u gulong -- bash -c "cd '$stage' && npm ci --omit=dev --ignore-scripts"
  fi

  node --check "$stage/server/local.js"
  printf '%s\n' "$commit_sha" > "$stage/.deploy-commit"
  chown -R gulong:gulong "$stage"
  mv "$stage" "$target"
  stage=""
fi

next_link="/opt/gulong/.current-next-${commit_sha}"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$current_link"
activated=1

if ! systemctl restart "$service_name" || ! health_check; then
  echo "New release failed its health gate; restoring the previous release." >&2
  if rollback; then
    echo "Previous release restored successfully." >&2
  else
    echo "Rollback health verification failed and requires immediate operator attention." >&2
  fi
  exit 4
fi

echo "Tencent release $commit_sha is active and healthy."
