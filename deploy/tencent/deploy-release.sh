#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-}"
commit_sha="${2:-}"
release_root="/opt/gulong/releases"
current_link="/opt/gulong/current"
service_name="gulong"
local_health_url="http://127.0.0.1:8787/api/health"

if [[ "$mode" != "prepare" && "$mode" != "activate" ]]; then
  echo "Deployment mode must be prepare or activate." >&2
  exit 2
fi

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid immutable commit SHA." >&2
  exit 2
fi

install -d -m 0755 "$release_root"
target="$release_root/$commit_sha"
stage="$release_root/.staging-$commit_sha"
previous="$(readlink -f "$current_link" 2>/dev/null || true)"
activated=0

if [[ -n "$previous" && "$previous" != "$release_root"/* ]]; then
  echo "Current release points outside the approved release root." >&2
  exit 2
fi

if [[ "$stage" != "$release_root/.staging-$commit_sha" || "$target" != "$release_root/$commit_sha" ]]; then
  echo "Resolved release paths are outside the approved scope." >&2
  exit 2
fi

if [[ "$mode" == "prepare" ]]; then
  if [[ -e "$stage" ]]; then
    rm -rf -- "$stage"
  fi
  if [[ -d "$target" && "$target" != "$previous" ]]; then
    failed_target="$release_root/.failed-${commit_sha}-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$target" "$failed_target"
  fi
  install -d -m 0755 "$stage"
  if [[ -n "$previous" && -d "$previous" ]]; then
    cp -al "$previous/." "$stage/"
  fi
  echo "Tencent staging release $stage is ready for checksum synchronization."
  exit 0
fi

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
  rm -rf -- "$stage"
else
  if [[ ! -d "$stage" || ! -f "$stage/.deploy-commit" ]] \
    || [[ "$(tr -d '\r\n' < "$stage/.deploy-commit")" != "$commit_sha" ]] \
    || [[ ! -f "$stage/package-lock.json" || ! -f "$stage/dist/client/index.html" || ! -f "$stage/server/local.js" ]] \
    || [[ ! -f "$stage/shared/error-messages.js" ]]; then
    echo "Synchronized release is incomplete or does not match the requested commit." >&2
    exit 3
  fi

  install_dependencies=0
  if [[ ! -d "$stage/node_modules" ]]; then
    install_dependencies=1
  elif [[ -n "$previous" && -f "$previous/package-lock.json" ]] \
    && ! cmp -s <(tr -d '\r' < "$previous/package-lock.json") <(tr -d '\r' < "$stage/package-lock.json"); then
    install_dependencies=1
  fi

  if [[ "$install_dependencies" -eq 1 ]]; then
    rm -rf -- "$stage/node_modules"
    install -d -m 0755 "$stage/.npm-cache"
    chown -R gulong:gulong "$stage"
    runuser -u gulong -- env HOME="$stage" npm_config_cache="$stage/.npm-cache" \
      bash -c "cd '$stage' && npm ci --omit=dev --ignore-scripts"
    rm -rf -- "$stage/.npm-cache"
  fi

  node --check "$stage/server/local.js"
  chown -R gulong:gulong "$stage"
  mv "$stage" "$target"
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

rm -f /tmp/deploy-release.sh
echo "Tencent release $commit_sha is active and healthy."
